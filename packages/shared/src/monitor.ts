import type { ConnectorHealthRow } from "./projections.js";
import type { OperationalAlert } from "./alerts.js";
import type { AlertFiring } from "./alert-firings.js";

/**
 * M9 Live Monitor view types + pure status derivation (PRD §8.4, §10.1.1, §20).
 *
 * These are the contract the M9 monitor read endpoints return and the Next.js
 * dashboard consumes. Pure types + pure functions — `@420ai/shared` stays
 * dependency-free and clock-free: `deriveMachineStatus` takes `nowMs` as an
 * argument (no `new Date()` here) so it is deterministic and unit-testable at
 * the boundaries. The CALLER (the ingest route) owns the wall clock.
 *
 * Liveness is heartbeat-FIRST with a `lastSeenAt` fallback (D5): `lastSeenAt`
 * updates on ANY authenticated request and so cannot tell idle-but-alive from
 * offline, whereas `lastHeartbeatAt` is the purpose-built signal. Pre-M9 /
 * just-paired machines that have never sent a heartbeat fall back to lastSeenAt.
 */

/** Derived machine liveness (D3 — a STATE; the alert ENGINE that acts on it is M10). */
export type MonitorStatus = "online" | "stale" | "offline";

/** Stamps the snapshot shape so a future dashboard can detect a derivation change (D11, PRD §23). */
export const MONITOR_VERSION = "m10-monitor-v2";

/**
 * The "active now" window: a session whose last event is within this lookback is shown as active
 * by `GET /v1/monitor`. M9 stores only the LATEST heartbeat sample, so this is current recency —
 * NOT a rate-of-change ("backlog growing" / trend is M10, D4).
 *
 * TWO CONSUMERS, AND THAT IS THE REASON IT LIVES HERE (M16 16.2, D-16.2-2). It was a local const in
 * `apps/ingest/src/routes/monitor.ts` until the label queue needed the same number: 16.2's
 * `GET /v1/labels/queue` defines a session as SETTLED when `max(ts) < now − ACTIVE_WINDOW_MS`.
 * The settle threshold IS the active window, on purpose and not by coincidence — a session must
 * never be simultaneously "active now" in the Live Monitor and "ready to label" in the tray, and
 * asking a human to judge a session they are still in the middle of is the fastest route to the
 * milestone's Risk 3 (label burden kills the ground truth). Two copies of this number could drift;
 * one cannot.
 */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * How far back `GET /v1/labels/queue` looks for unlabeled sessions (M16 16.2, D-16.2-2).
 *
 * FOURTEEN DAYS IS DERIVED, NOT PICKED. The research plan's §3 review cadence is a Friday,
 * 30-minute session, so a full week can elapse between visits to the queue; 14 days leaves exactly
 * one missed week of slack before a session ages out unlabeled.
 *
 * A session older than this is DELIBERATELY unreachable from the queue rather than accidentally
 * missing: 16.4 counts it in the denominator as never-asked-about (which is the honest reading —
 * nobody was ever prompted), and the dashboard's `/labels` page is how one gets labelled late.
 */
export const LABEL_QUEUE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Tuned to the default 30 s heartbeat cadence (HEARTBEAT_INTERVAL_MS). */
export const MONITOR_THRESHOLDS = {
  staleMs: 90_000, // > 3× cadence with no heartbeat -> stale (amber)
  offlineMs: 300_000, // > 5 min -> offline (red)
  backlogHigh: 100, // queuePending above this -> backlogHigh flag
} as const;

/** Per-machine status row (clock-free; timestamps normalized to ISO strings by the repo). */
export interface MachineStatusRow {
  id: string;
  name: string;
  os: string | null;
  hostname: string | null;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  queuePending: number | null;
  queueInflight: number | null;
  collectorVersion: string | null;
  consecutiveSyncFailures: number | null; // M12 12.6 archive.unreachable signal (collector-reported)
}

/** One currently-active tool session (recent activity window), projected over `events`. */
export interface ActiveSessionRow {
  sessionId: string;
  sourceConnector: string;
  startedAt: string | null; // min(ts)
  lastEventAt: string | null; // max(ts); "N seconds ago" computed by the consumer
  eventCount: number;
  models: string[];
  projectPath: string | null;
  gitBranch: string | null;
}

/** The composed Live Monitor snapshot returned by GET /v1/monitor (route-owned clock). */
export interface LiveMonitorSnapshot {
  monitorVersion: string; // MONITOR_VERSION — shape/derivation stamp (D11)
  generatedAt: string; // route-owned clock (ISO)
  machines: (MachineStatusRow & { status: MonitorStatus; backlogHigh: boolean })[];
  connectors: ConnectorHealthRow[]; // reused verbatim from projections.ts
  activeSessions: ActiveSessionRow[];
  alerts: OperationalAlert[]; // M10 — derived from the above by deriveAlerts (alerts.ts)
  alertFirings: AlertFiring[]; // M10 3c — persisted firing history/ack reconciled on read (D1)
}

/**
 * Derive a machine's liveness from its heartbeat/recency timestamps.
 *
 * `nowMs` is injected (ms epoch) so this is deterministic + testable (CLAUDE.md).
 * Prefers the dedicated heartbeat signal; falls back to `lastSeenAt` for pre-M9
 * machines that have never sent one (D5). Neither present -> offline.
 */
export function deriveMachineStatus(
  m: Pick<MachineStatusRow, "lastHeartbeatAt" | "lastSeenAt">,
  nowMs: number,
): MonitorStatus {
  const ref = m.lastHeartbeatAt ?? m.lastSeenAt;
  if (!ref) return "offline";
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return "offline"; // unparseable timestamp → fail safe, never falsely "online"
  const age = nowMs - refMs;
  if (age > MONITOR_THRESHOLDS.offlineMs) return "offline";
  if (age > MONITOR_THRESHOLDS.staleMs) return "stale";
  return "online";
}

/** Current backlog over the threshold -> flag (D4: this is depth, NOT a growth/derivative). */
export const isBacklogHigh = (pending: number | null): boolean =>
  (pending ?? 0) > MONITOR_THRESHOLDS.backlogHigh;

/**
 * An all-empty snapshot carrying only the version stamp + the caller's clock. Used by the
 * ingest route (no user resolved) and by the dashboard page (ingest unreachable) so the
 * empty shape is defined ONCE.
 */
export function emptyMonitorSnapshot(generatedAt: string): LiveMonitorSnapshot {
  return {
    monitorVersion: MONITOR_VERSION,
    generatedAt,
    machines: [],
    connectors: [],
    activeSessions: [],
    alerts: [],
    alertFirings: [],
  };
}
