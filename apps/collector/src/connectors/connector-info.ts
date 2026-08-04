import type { ConnectorInfo, MachineConnectorReport } from "@420ai/shared";
import type { Connector } from "./connector.js";
import { connectors as defaultConnectors } from "./connector.js";
import { approvalStatus } from "./connector-approvals.js";
import type { ConnectorErrorRecord } from "../queue/queue-store.js";

/**
 * The SINGLE `Connector → ConnectorInfo` conversion point, plus the M16 16.3 wire report derived
 * from it.
 *
 * `@420ai/shared` is a leaf and cannot import `Connector` (that would invert the dependency graph),
 * so the fidelity fields are mirrored on the wire. Extracted from `serve.ts` in 16.3 because a
 * SECOND consumer appeared — the capture engine, which reports the same inventory to the archive on
 * the heartbeat. Two copies of this mapping would be two views of connector health that could
 * disagree, which is the exact problem the scorecard exists to remove.
 */

/** Built-in connector ids, computed once — anything else is a user-defined custom connector (M10-S2). */
const BUILTIN_IDS = new Set(defaultConnectors.map((c) => c.id));

/**
 * Map a `Connector` (+ its resolved enablement + home) to the serializable `ConnectorInfo` wire
 * shape. A test asserts this mapping stays 1:1 with `ConnectorFidelity`.
 */
export function mapConnectorInfo(
  c: Connector,
  enabled: boolean,
  home: string,
  approval: "approved" | "needs-approval",
): ConnectorInfo {
  return {
    id: c.id,
    enabled,
    status: c.fidelity.status,
    captureMethod: c.fidelity.captureMethod,
    liveness: c.fidelity.liveness,
    tokens: c.fidelity.tokens,
    cost: c.fidelity.cost,
    knownGaps: c.fidelity.knownGaps,
    watchGlobs: c.watchGlobs(home),
    // Slice 12.7b: the declared §10.3 scope + the §10.4 approval state.
    requiredPermissions: c.fidelity.requiredPermissions,
    approval,
    // A connector whose id is not a built-in is a user-defined custom connector (M10-S2).
    custom: !BUILTIN_IDS.has(c.id),
  };
}

/**
 * Narrow a `ConnectorInfo` to what the ARCHIVE is allowed to know, folding in the collector-owned
 * error state (M16 16.3).
 *
 * `watchGlobs` ARE DROPPED, AND THAT IS THE POINT OF THIS FUNCTION (D-16.3-3). They are absolute
 * paths under the operator's home (`C:\Users\<name>\.claude\projects\**`), so sending them writes
 * the operator's username and directory layout into a database a design partner is later asked to
 * trust (§7 P0.4, docs/guide/data-boundary.md). `requiredPermissions` carries the same information
 * as a human-readable capture-scope statement built for exactly that review (12.7b) and IS sent.
 *
 * The destructuring below is deliberate rather than a field-by-field copy: `MachineConnectorReport`
 * is `Omit<ConnectorInfo, "watchGlobs"> & …`, so a NEW field added to `ConnectorInfo` flows through
 * automatically and a new SENSITIVE one has to be excluded here explicitly — the type and this
 * function fail together rather than drifting apart.
 */
export function toMachineConnectorReport(
  info: ConnectorInfo,
  error?: ConnectorErrorRecord,
  home?: string,
): MachineConnectorReport {
  const { watchGlobs: _dropped, ...rest } = info;
  const scrub = (s: string): string => (home ? homeRelative(s, home) : s);
  return {
    ...rest,
    custom: rest.custom ?? false,
    // CLAMPED ON THE SENDER, mirroring the ingest schema's bounds (PR #77 review). A bound
    // VIOLATION is not stripped like an undeclared property is — `maxItems`/`maxLength` are a hard
    // 400, which rejects the WHOLE heartbeat, so the machine's LIVENESS never lands either and it
    // goes `offline` while the collector is fine. A custom connector is the realistic trigger:
    // `custom-connector.ts` builds `requiredPermissions` 1:1 from `def.watchGlobs`, and
    // `validateCustomDef` bounds neither their count nor their length. Truncating the inventory is
    // strictly better than losing the heartbeat — the panel shows slightly less detail instead of
    // claiming the machine is down.
    knownGaps: clampList(rest.knownGaps.map(scrub)),
    // HOME-RELATIVIZED, because the `watchGlobs` scrub above was leaking out through this field
    // (PR #77 review, found by three reviewers independently). A CUSTOM connector's
    // `requiredPermissions` are built 1:1 from its `watchGlobs`
    // (`Read user-configured file/log: C:\Users\<name>\…`), so D-16.3-3's type-level exclusion was
    // real for the built-ins and cosmetic for custom ones — the operator's username and directory
    // layout reached Postgres by the other field. The built-ins already write `~/.claude/…` by hand;
    // this makes custom connectors match.
    //
    // SCRUBBED HERE AND NOT AT THE SOURCE, deliberately: `requiredPermissions` feeds the §10.4
    // capture-surface FINGERPRINT, so rewriting the string in `custom-connector.ts` would invalidate
    // every existing approval and re-prompt the operator. This function is the archive boundary and
    // the only place that can scrub without touching local identity.
    requiredPermissions: clampList(rest.requiredPermissions.map(scrub)),
    // Same treatment: a capture error is `String(err)`, typically
    // `EACCES … open 'C:\Users\<name>\.claude\projects\…'`. The path IS the diagnostic and is kept
    // (docs/guide/data-boundary.md records it) — but it does not need the username to be useful.
    lastErrorMessage: error ? scrub(error.message) : null,
    lastErrorAt: error?.at ?? null,
    errorCount: error?.count ?? 0,
  };
}

/**
 * Resolve every registry connector's DECLARED state from the persisted config + approvals
 * (M16 16.3, PR #77 review).
 *
 * ONE DEFINITION FOR THREE CALL SITES — `cli.ts`'s `connectorStates`, `serve.ts`'s `connectorStates`,
 * and `serve.ts`'s `emitConnectors` — which had drifted into three copies of the same pair of
 * lookups. The cost of that duplication is specific rather than aesthetic: `serve` is the DESKTOP's
 * view of connector health and `watch` is the SERVICE's, and the whole point of 16.3 is that those
 * two agree. Three hand-maintained copies of "what does enabled mean" is exactly how they would stop
 * agreeing, and neither `tsc` nor any existing test would notice.
 *
 * Default-on is preserved here and nowhere else: an id ABSENT from the config means enabled.
 */
export function resolveConnectorStates(
  registry: Connector[],
  cfg: { connectors: Record<string, { enabled: boolean }> },
  approvals: Parameters<typeof approvalStatus>[1],
  home: string,
): Map<string, { enabled: boolean; approval: "approved" | "needs-approval" }> {
  return new Map(
    registry.map((c) => [
      c.id,
      {
        enabled: cfg.connectors[c.id]?.enabled !== false,
        approval: approvalStatus(c, approvals, home),
      },
    ]),
  );
}

/**
 * Replace the operator's home directory with `~` wherever it appears in a string bound for the
 * archive. Case-insensitive and separator-agnostic, because Windows paths reach us as both
 * `C:\Users\me\…` and `C:/Users/me/…` (the watcher normalizes globs to forward slashes) and the
 * drive letter's case is not stable.
 */
function homeRelative(text: string, home: string): string {
  if (!home) return text;
  let out = text;
  for (const v of new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])) {
    if (!v) continue;
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
  }
  return out;
}

/** Mirrors the heartbeat schema's `maxItems: 32` / `items.maxLength: 300` for the two string lists. */
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_LENGTH = 300;

function clampList(items: string[]): string[] {
  return items
    .slice(0, MAX_LIST_ITEMS)
    .map((s) => (s.length > MAX_LIST_ITEM_LENGTH ? `${s.slice(0, MAX_LIST_ITEM_LENGTH - 1)}…` : s));
}
