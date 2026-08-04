import type { ConnectorInfo, MachineConnectorReport } from "@420ai/shared";
import type { Connector } from "./connector.js";
import { connectors as defaultConnectors } from "./connector.js";
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
): MachineConnectorReport {
  const { watchGlobs: _dropped, ...rest } = info;
  return {
    ...rest,
    custom: rest.custom ?? false,
    lastErrorMessage: error?.message ?? null,
    lastErrorAt: error?.at ?? null,
    errorCount: error?.count ?? 0,
  };
}
