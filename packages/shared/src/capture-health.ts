import type { ConnectorCatalogLiveness } from "./connector-catalog.js";
import type { ConnectorInfo } from "./control-protocol.js";
import type { MonitorStatus } from "./monitor.js";

/**
 * M16 16.3 — Capture health scorecard (research plan §7 P0.1).
 *
 * THE ACCEPTANCE CRITERION IS A DISTINCTION, NOT A NUMBER: "a user can distinguish 'no work
 * happened' from 'capture is broken'." Everything the archive holds today is derived from OBSERVED
 * events (`connectorHealth` is a `GROUP BY events.source_connector`), and a connector that is
 * enabled-but-broken emits nothing — so it produces no row at all, byte-identical to a connector
 * that is disabled and byte-identical to a healthy connector on a quiet day.
 *
 * This module is the join of DECLARED (what the collector says it is doing, reported on the
 * heartbeat) against OBSERVED (what actually arrived). Pure + clock-injected, exactly like
 * `monitor.ts`: `@420ai/shared` stays dependency-free and never reads the wall clock, so the whole
 * classification is unit-testable with no database and the CALLER (the ingest route) owns `now`.
 */

/** Stamps the derivation shape so a dashboard can detect drift (sibling of MONITOR_VERSION, D11/PRD §23). */
export const CAPTURE_HEALTH_VERSION = "m16-capture-health-v1";

/**
 * What the collector reports per connector on the heartbeat.
 *
 * DERIVED from `ConnectorInfo` (control-protocol.ts) rather than re-typed, so the archive's view
 * cannot drift from the desktop's. The `Omit<…, "watchGlobs">` IS LOAD-BEARING (D-16.3-3):
 * `watchGlobs` are absolute filesystem paths under the operator's home
 * (`C:\Users\<name>\.claude\projects\**`), so sending them would write the operator's username and
 * directory layout into a database a design partner is later asked to trust (§7 P0.4,
 * docs/guide/data-boundary.md). `requiredPermissions` carries the same information as a
 * human-readable capture-scope statement built for exactly that review (12.7b) and IS sent.
 * The exclusion is enforced at the TYPE level here and pinned by a test in the collector, so it is
 * not something anyone has to remember.
 */
export type MachineConnectorReport = Omit<ConnectorInfo, "watchGlobs"> & {
  /**
   * REQUIRED here even though `ConnectorInfo.custom` is optional (PR #77 review). The wire schema
   * lists `custom` in `required`, so the two must agree or a producer typed against THIS type can
   * legitimately omit a field the edge then 400s — taking the whole heartbeat, and the machine's
   * liveness, with it. `toMachineConnectorReport` already always sets it, so narrowing costs nothing.
   */
  custom: boolean;
  /** Last capture error for this connector, collector-owned (D-16.3-7). Null once never-errored. */
  lastErrorMessage: string | null;
  /** ISO timestamp of `lastErrorMessage`. */
  lastErrorAt: string | null;
  /** Monotonic per-connector error count held in the collector's `queue.sqlite` (D-16.3-7). */
  errorCount: number;
};

/**
 * Per-connector capture health.
 *
 * The union is designed around what the evidence can actually support, and it carries TWO states
 * that mean "cannot tell". Those are not gaps — they are the mitigation for the milestone's Risk 2
 * (the same operator builds and grades this instrument). A scorecard with no way to say "unknown"
 * reports a healthy-looking zero, which converts an outage into evidence.
 */
export type CaptureHealthState =
  /** Enabled, approved, events inside the freshness window. Working. */
  | "healthy"
  /** Enabled, approved, no recent events — and nothing suggests otherwise. NO WORK HAPPENED. */
  | "idle"
  /** The collector reported an error at or after the last successful event. BROKEN. */
  | "erroring"
  /** Withheld from capture pending §10.4 re-approval (12.7b). A KNOWN PERMISSION GAP. */
  | "needs-approval"
  /** Declared `enabled:false`. No work is EXPECTED — the honest zero. */
  | "disabled"
  /** A live-capture connector produced nothing while a SIBLING on the same machine did. SUSPECT. */
  | "silent"
  /** Events observed, but no machine declares this connector (a pre-16.3 collector). UNKNOWN. */
  | "unreported"
  /** The machine has not heartbeat recently — its declaration is stale. UNKNOWN. */
  | "unknown";

/** The half of the P0.1 question a state answers. */
export type CaptureHealthVerdict = "capturing" | "not-capturing" | "broken" | "unknown";

/**
 * Which states answer which half of the P0.1 question. Exported so the UI cannot re-decide it —
 * two independently-derived verdicts on one screen is the "which number do I believe?" problem the
 * milestone exists to remove.
 */
export const CAPTURE_HEALTH_VERDICT = {
  healthy: "capturing",
  idle: "capturing",
  disabled: "not-capturing",
  erroring: "broken",
  silent: "broken",
  "needs-approval": "broken",
  unreported: "unknown",
  unknown: "unknown",
} as const satisfies Record<CaptureHealthState, CaptureHealthVerdict>;

export const CAPTURE_HEALTH_THRESHOLDS = {
  /**
   * How recently a connector must have produced an event to count as `healthy`.
   *
   * DELIBERATELY NOT `ACTIVE_WINDOW_MS`. That constant (15 min) answers "is a session in progress
   * right now" and 16.2's D-16.2-2 shares it between two surfaces that MUST agree. Capture health
   * asks a different question — "has this connector produced anything lately" — which is a
   * working-day question, not a session question. Sharing the 15-minute number would paint every
   * connector `silent`/`idle` over lunch. One working day of quiet is the point at which a
   * live-capture connector's silence starts to mean something.
   */
  freshEventMs: 24 * 60 * 60 * 1000, // 24 hours
} as const;

/** Aggregates over `events` for one (machine, connector) pair. Repo-normalized to ISO. */
export interface ObservedConnectorRow {
  machineId: string;
  connectorId: string;
  lastEventAt: string | null;
  eventCount: number;
  parserVersions: string[];
}

/** One reported declaration joined against its observation (the LEFT JOIN in the repository). */
export interface DeclaredConnectorRow extends ObservedConnectorRow {
  enabled: boolean;
  approval: ConnectorInfo["approval"];
  status: ConnectorInfo["status"];
  captureMethod: string;
  liveness: ConnectorCatalogLiveness;
  tokens: ConnectorInfo["tokens"];
  cost: ConnectorInfo["cost"];
  knownGaps: string[];
  requiredPermissions: string[];
  custom: boolean;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  errorCount: number;
  reportedAt: string;
}

/** Machine liveness for the rows attributed to it (an offline machine's declaration is stale). */
export interface CaptureHealthMachine {
  id: string;
  name: string;
  status: MonitorStatus;
}

export interface CaptureHealthInputs {
  machines: CaptureHealthMachine[];
  /** Every DECLARED (machine, connector) pair, with whatever was observed for it. */
  declared: DeclaredConnectorRow[];
  /** Every OBSERVED (machine, connector) pair. The set difference yields `unreported`. */
  observed: ObservedConnectorRow[];
}

/** One row of the scorecard. */
export interface CaptureHealthRow {
  machineId: string;
  machineName: string;
  machineStatus: MonitorStatus;
  connectorId: string;
  state: CaptureHealthState;
  verdict: CaptureHealthVerdict;
  /** False ⇒ nothing declares this connector; every declaration field below is null/empty. */
  declared: boolean;
  enabled: boolean | null;
  approval: ConnectorInfo["approval"] | null;
  status: ConnectorInfo["status"] | null;
  captureMethod: string | null;
  liveness: ConnectorCatalogLiveness | null;
  tokens: ConnectorInfo["tokens"] | null;
  cost: ConnectorInfo["cost"] | null;
  custom: boolean;
  knownGaps: string[];
  requiredPermissions: string[];
  lastEventAt: string | null;
  eventCount: number;
  parserVersions: string[];
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  errorCount: number;
  reportedAt: string | null;
}

/** The payload of `GET /v1/capture-health` (route-owned clock). */
export interface CaptureHealthSnapshot {
  captureHealthVersion: string;
  generatedAt: string;
  rows: CaptureHealthRow[];
}

const key = (machineId: string, connectorId: string): string => `${machineId}\u0000${connectorId}`;

/** Parse an ISO timestamp to ms, or null when absent/unparseable (fail safe, never falsely fresh). */
function msOf(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Live-capture connectors are EXPECTED to produce whenever the operator works; batch/snapshot ones
 * (`claude-export`, `chatgpt-export`, `gemini-export`) capture only when an export file is dropped
 * in, which may be never. Flagging their quiet would put a permanent false red on the panel and
 * train the operator to ignore it — the same "cry wolf" failure §4.3 avoids for labels (D-16.3-4).
 */
const isLiveCapture = (liveness: ConnectorCatalogLiveness): boolean =>
  liveness === "streaming" || liveness === "near-real-time";

/**
 * Classify every declared connector, plus every observed-but-undeclared one.
 *
 * `nowMs` is injected (ms epoch) so this is deterministic and testable — the route owns the clock.
 * Rows are ordered by (machineName, connectorId) so the panel is stable across polls.
 */
export function deriveCaptureHealth(
  inputs: CaptureHealthInputs,
  nowMs: number,
): CaptureHealthRow[] {
  const machineById = new Map(inputs.machines.map((m) => [m.id, m]));
  const fresh = (iso: string | null): boolean => {
    const ms = msOf(iso);
    return ms !== null && nowMs - ms <= CAPTURE_HEALTH_THRESHOLDS.freshEventMs;
  };

  // Which machines had ANY connector produce recently — the sibling evidence that makes a
  // live-capture connector's silence surprising rather than merely quiet.
  const machinesWithRecentActivity = new Set<string>();
  for (const row of [...inputs.declared, ...inputs.observed]) {
    if (fresh(row.lastEventAt)) machinesWithRecentActivity.add(row.machineId);
  }

  const rows: CaptureHealthRow[] = [];
  const declaredKeys = new Set<string>();

  for (const d of inputs.declared) {
    declaredKeys.add(key(d.machineId, d.connectorId));
    const machine = machineById.get(d.machineId);
    const machineStatus: MonitorStatus = machine?.status ?? "offline";
    const state = classifyDeclared(d, machineStatus, fresh, machinesWithRecentActivity);
    rows.push({
      machineId: d.machineId,
      machineName: machine?.name ?? d.machineId,
      machineStatus,
      connectorId: d.connectorId,
      state,
      verdict: CAPTURE_HEALTH_VERDICT[state],
      declared: true,
      enabled: d.enabled,
      approval: d.approval,
      status: d.status,
      captureMethod: d.captureMethod,
      liveness: d.liveness,
      tokens: d.tokens,
      cost: d.cost,
      custom: d.custom,
      knownGaps: d.knownGaps,
      requiredPermissions: d.requiredPermissions,
      lastEventAt: d.lastEventAt,
      eventCount: d.eventCount,
      parserVersions: d.parserVersions,
      lastErrorMessage: d.lastErrorMessage,
      lastErrorAt: d.lastErrorAt,
      errorCount: d.errorCount,
      reportedAt: d.reportedAt,
    });
  }

  for (const o of inputs.observed) {
    if (declaredKeys.has(key(o.machineId, o.connectorId))) continue;
    const machine = machineById.get(o.machineId);
    // `unreported`, NOT `disabled`. A pre-16.3 collector reports nothing at all, so asserting
    // "disabled" would be a fabricated fact — exactly the Risk 2 failure this union exists to
    // prevent. The machine's status does not override it: both already read as "unknown", and
    // "your collector does not report this yet" is the more actionable of the two.
    rows.push({
      machineId: o.machineId,
      machineName: machine?.name ?? o.machineId,
      machineStatus: machine?.status ?? "offline",
      connectorId: o.connectorId,
      state: "unreported",
      verdict: CAPTURE_HEALTH_VERDICT.unreported,
      declared: false,
      enabled: null,
      approval: null,
      status: null,
      captureMethod: null,
      liveness: null,
      tokens: null,
      cost: null,
      custom: false,
      knownGaps: [],
      requiredPermissions: [],
      lastEventAt: o.lastEventAt,
      eventCount: o.eventCount,
      parserVersions: o.parserVersions,
      lastErrorMessage: null,
      lastErrorAt: null,
      errorCount: 0,
      reportedAt: null,
    });
  }

  return rows.sort(
    (a, b) =>
      a.machineName.localeCompare(b.machineName) ||
      a.machineId.localeCompare(b.machineId) ||
      a.connectorId.localeCompare(b.connectorId),
  );
}

/**
 * The state ladder for a DECLARED connector. Order is the whole argument:
 *
 * 1. an OFFLINE machine's declaration is stale, so it is read as `unknown` BEFORE anything else —
 *    a declaration from a laptop that closed two days ago is not a current fact;
 * 2. `disabled` — the operator turned it off, so no work is expected and nothing below applies;
 * 3. `needs-approval` — withheld from capture pending §10.4 re-approval, which EXPLAINS the
 *    silence, so it must outrank `idle` (edge case 6);
 * 4. `erroring` — an error at or after the last successful event. An error BEFORE it means the
 *    connector recovered (edge case 7);
 * 5. `healthy` — produced inside the freshness window;
 * 6. `silent` vs `idle` — the D-16.3-4 liveness gate.
 */
function classifyDeclared(
  d: DeclaredConnectorRow,
  machineStatus: MonitorStatus,
  fresh: (iso: string | null) => boolean,
  machinesWithRecentActivity: Set<string>,
): CaptureHealthState {
  if (machineStatus === "offline") return "unknown";
  if (!d.enabled) return "disabled";
  if (d.approval === "needs-approval") return "needs-approval";

  const errorMs = msOf(d.lastErrorAt);
  if (errorMs !== null) {
    const eventMs = msOf(d.lastEventAt);
    if (eventMs === null || errorMs >= eventMs) return "erroring";
  }

  if (fresh(d.lastEventAt)) return "healthy";

  // Silence is only evidence when silence is SURPRISING. A batch connector is expected to be quiet
  // for weeks; a live-capture one that produced nothing while a sibling on the same machine did is
  // suspicious — worded as suspicion on the panel, never as a verdict.
  //
  // BUT SIBLING EVIDENCE CANNOT BE THE ONLY TRIGGER, and assuming it could was a real hole
  // (D-16.3-4, extended after PR #77 review). The realistic outage is MACHINE-WIDE — the documented
  // Windows footgun is a service running under LocalSystem whose `homedir()` is
  // `…\config\systemprofile`, so EVERY connector's globs match nothing at the same moment. Nothing
  // throws, so `lastErrorAt` stays null; the heartbeat still flows, so the machine is `online`. With
  // no sibling left to blow the whistle, every connector fell through to `idle` — whose verdict is
  // `capturing` — and the panel reported "2 Capturing" for a machine capturing NOTHING. That is the
  // healthy-looking zero this module exists to prevent, in the exact dogfood configuration (two
  // live connectors, no third to act as a control). Proven with a test before this branch existed.
  //
  // So a live-capture connector that has NEVER produced ANYTHING is `silent` on its own evidence:
  // "no events, ever" is not a quiet week, it is an unproven capture path. Sibling evidence remains
  // the trigger for a connector that USED to produce and then stopped, which is the case it was
  // always the right signal for. Batch connectors are untouched — their quiet is still `idle`.
  if (isLiveCapture(d.liveness)) {
    if (d.lastEventAt === null) return "silent";
    if (machinesWithRecentActivity.has(d.machineId)) return "silent";
  }
  return "idle";
}
