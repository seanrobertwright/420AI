import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { COLLECTOR_HOME } from "../identity.js";
import type { Connector } from "./connector.js";

/**
 * Per-connector capture-surface APPROVAL persistence (M12 Slice 12.7b, PRD §8.1/§10.4).
 *
 * `~/.420ai/connector-approvals.json` records, per connector id, the approved
 * "capture surface" — a stable fingerprint of what that connector reads (its
 * `watchGlobs(home)` + declared `requiredPermissions`). It sits ALONGSIDE the
 * registry and the capture core, never inside them: approval is applied by FILTERING
 * the `connectors[]` array passed into `runCaptureEngine` (mirroring `filterConnectors`),
 * so the registry, watcher, and engine are untouched.
 *
 * This is the §10.4 "user approval for capture surface changes" gate: a connector
 * whose CURRENT fingerprint differs from its RECORDED one is `"needs-approval"` and is
 * withheld from capture until the user approves (`connectors.approve`). A "Capture
 * Surface Change" (docs/CONTEXT.md) is exactly such a drift.
 *
 * Library file: it mirrors `connector-config.ts` — tolerant reads (absent/corrupt ⇒ a
 * safe default, never a throw), a `path` testability seam, and a `mode:0o600` write. It
 * never logs or exits, and every function is pure + `home`-injectable.
 *
 * DEFAULT-ON is load-bearing: an absent file, an unknown id, or a connector not yet
 * recorded all resolve to APPROVED. Seeding at boot (`seedMissingApprovals`) records a
 * brand-new connector's current fingerprint as the trusted baseline — so a fresh install
 * and any future new connector keep capturing, and only a LATER drift from that baseline
 * is gated. (Gating initial capture would regress default-on; §10.4 gates *changes*.)
 */

/** Stamps the approvals shape (D11-style sibling of CONNECTOR_CONFIG_VERSION). */
export const CONNECTOR_APPROVALS_VERSION = "m12-approvals-v1" as const;

/** Where per-connector approvals are persisted (testability seam: the optional `path`). */
export const CONNECTOR_APPROVALS_PATH = join(COLLECTOR_HOME, "connector-approvals.json");

export interface ConnectorApprovals {
  /** CONNECTOR_APPROVALS_VERSION stamp. */
  version: string;
  /** Keyed by `Connector.id` → the approved capture-surface fingerprint. */
  approved: Record<string, { surfaceFingerprint: string }>;
}

/** The safe default — nothing recorded yet, so everything is default-on (approved). */
function defaultApprovals(): ConnectorApprovals {
  return { version: CONNECTOR_APPROVALS_VERSION, approved: {} };
}

/**
 * The connector's CURRENT capture-surface fingerprint: a sha256 over its sorted
 * `watchGlobs(home)` + sorted `requiredPermissions`. Sorting both means a cosmetic
 * reordering never spuriously flips the fingerprint; hashing (not the raw scope) keeps
 * the approvals file tiny and comparison O(1). Pure — `home` is injected.
 */
export function captureSurfaceFingerprint(c: Connector, home: string): string {
  const globs = [...c.watchGlobs(home)].sort();
  const perms = [...c.fidelity.requiredPermissions].sort();
  return createHash("sha256").update(JSON.stringify({ globs, perms })).digest("hex");
}

/**
 * Load the approvals, returning the safe default when the file is absent or corrupt
 * (tolerant, mirroring `loadConnectorConfig`). Never throws.
 */
export function loadConnectorApprovals(path = CONNECTOR_APPROVALS_PATH): ConnectorApprovals {
  if (!existsSync(path)) return defaultApprovals();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConnectorApprovals>;
    return {
      version: parsed.version ?? CONNECTOR_APPROVALS_VERSION,
      approved: parsed.approved ?? {},
    };
  } catch {
    return defaultApprovals();
  }
}

/** Persist the approvals (mkdir + owner-only write, like `saveConnectorConfig`). */
export function saveConnectorApprovals(
  cfg: ConnectorApprovals,
  path = CONNECTOR_APPROVALS_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/**
 * The connector's approval state. DEFAULT-ON: an id absent from `approved` ⇒ approved
 * (a fresh/unrecorded connector keeps capturing). A recorded fingerprint that MATCHES
 * the current one ⇒ approved; a recorded fingerprint that DIFFERS ⇒ needs-approval (the
 * §10.4 capture-surface-change gate). Pure — `home` is injected.
 */
export function approvalStatus(
  c: Connector,
  approvals: ConnectorApprovals,
  home: string,
): "approved" | "needs-approval" {
  const recorded = approvals.approved[c.id];
  if (!recorded) return "approved";
  return recorded.surfaceFingerprint === captureSurfaceFingerprint(c, home)
    ? "approved"
    : "needs-approval";
}

/**
 * Record the current fingerprint for any connector ABSENT from `approved` (first-sight
 * trust — establishes the baseline so a later drift is detectable). Returns a NEW
 * approvals object plus `changed` (true iff anything was added). Never overwrites an
 * existing entry — a recorded-but-mismatched connector is the change we WANT to surface,
 * not silently re-bless. Pure — `home` is injected.
 */
export function seedMissingApprovals(
  registry: Connector[],
  approvals: ConnectorApprovals,
  home: string,
): { approvals: ConnectorApprovals; changed: boolean } {
  const approved = { ...approvals.approved };
  let changed = false;
  for (const c of registry) {
    if (!approved[c.id]) {
      approved[c.id] = { surfaceFingerprint: captureSurfaceFingerprint(c, home) };
      changed = true;
    }
  }
  return { approvals: { version: approvals.version, approved }, changed };
}

/**
 * Approve a connector's CURRENT capture surface: record its current fingerprint as the
 * new approved baseline. Returns a NEW approvals object (pure). After this, `approvalStatus`
 * returns "approved" until the surface drifts again.
 */
export function approveConnector(
  c: Connector,
  approvals: ConnectorApprovals,
  home: string,
): ConnectorApprovals {
  return {
    version: approvals.version,
    approved: {
      ...approvals.approved,
      [c.id]: { surfaceFingerprint: captureSurfaceFingerprint(c, home) },
    },
  };
}

/**
 * Filter a registry by approval: drop any connector whose surface drifted from its
 * approved baseline (`"needs-approval"`). Mirrors `filterConnectors`; default-on is
 * preserved (unrecorded ⇒ approved ⇒ kept). Composes cleanly with `filterConnectors`.
 */
export function filterByApproval(
  registry: Connector[],
  approvals: ConnectorApprovals,
  home: string,
): Connector[] {
  return registry.filter((c) => approvalStatus(c, approvals, home) !== "needs-approval");
}
