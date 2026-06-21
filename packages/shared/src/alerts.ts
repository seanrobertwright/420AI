import type { LiveMonitorSnapshot, MonitorStatus } from "./monitor.js";

/**
 * M10 Operational Alerts — a pure, stateless derived projection over the M9 Live
 * Monitor snapshot (PRD §20, glossary "Operational Alert" in docs/CONTEXT.md).
 *
 * M9 deliberately shipped STATES, not actions: `deriveMachineStatus` →
 * online|stale|offline and `isBacklogHigh` already live in monitor.ts and are
 * carried per-machine on the snapshot. This module turns those already-derived
 * states (plus connector health) into named, severity-ranked alerts. It reads the
 * snapshot's `machines[].status` / `machines[].backlogHigh` / `connectors[]` rows
 * and NEVER re-parses a timestamp or recomputes liveness (.agents/system-reviews/
 * m7-m9-review.md: "reuse the deriveMachineStatus states — do not recompute liveness").
 *
 * Pure + clock-free, exactly like monitor.ts: `deriveAlerts` is a function of the
 * snapshot ALONE (the snapshot is self-contained — it carries `status`,
 * `backlogHigh`, and `generatedAt`), so no `nowMs` / `new Date()` is needed.
 *
 * STATELESS: alerts are re-derived on every snapshot (repo invariant "events
 * disposable / projections re-derivable"). There is NO persisted firing history —
 * `since` is the timestamp of the triggering EVIDENCE (e.g. last heartbeat / last
 * event), NOT a "fired at" time.
 *
 * M10 3c (persisted alert engine): `deriveAlerts` itself stays FROZEN (D2). The new
 * "backlog GROWING" derivative is produced by a SEPARATE pure function —
 * `deriveBacklogTrendAlerts` — layered BESIDE `deriveAlerts` and merged via the
 * exported `sortAlerts` helper (the route does
 * `sortAlerts([...deriveAlerts(built), ...deriveBacklogTrendAlerts(...)])`). Firing
 * history + ack live in the persisted layer (alert-firings.ts + the db/ingest layers),
 * never here — this module remains pure + clock-free.
 */

/** Alert urgency, rendered critical-first. */
export type AlertSeverity = "critical" | "warning" | "info";

/** The operational-alert conditions derivable from the M9 snapshot today (PRD §20 subset). */
export type AlertCode =
  | "collector.offline"
  | "collector.stale"
  | "connector.failing"
  | "sync.backlog_high"
  | "sync.backlog_growing"
  | "catalog.update_requires_approval"
  | "ingest.auth_failure"
  | "archive.unreachable";

/** Stamps the alert derivation shape (sibling of MONITOR_VERSION; D11, PRD §23). */
export const ALERT_VERSION = "m10-alerts-v1" as const;

/**
 * Tunable thresholds for the connector-failure heuristic. `connectorHealth` is a
 * LIFETIME aggregate (no time window), so this is a lifetime failure ratio, not
 * "failing right now" — the honest limit of the current projection. A connector
 * with ≥5 tool calls and ≥50% failed is genuinely misbehaving; it resolves as
 * healthy calls dilute the ratio. (A recent-window rate is a deferred refinement.)
 */
export const ALERT_THRESHOLDS = {
  connectorFailMinCalls: 5,
  connectorFailRatio: 0.5,
} as const;

/**
 * One named, severity-ranked operational alert. `since` is evidence-time (see the
 * module doc), null when the trigger is a depth/count rather than a timestamp
 * (e.g. sync.backlog_high).
 */
export interface OperationalAlert {
  code: AlertCode;
  severity: AlertSeverity;
  message: string;
  machineId?: string;
  machineName?: string;
  connector?: string;
  since: string | null;
}

/** critical < warning < info — lower rank sorts first. */
const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Derive the operational alerts for a snapshot (PRD §20). Reads the already-derived
 * machine `status`/`backlogHigh` and connector rows; emits at most one machine-liveness
 * alert per machine plus a backlog alert when applicable, plus a per-connector failure
 * alert. Output is sorted critical-first, stable within a severity (machines in snapshot
 * order, then connectors — Array.prototype.sort is stable in Node ≥ 24).
 */
export function deriveAlerts(snapshot: LiveMonitorSnapshot): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];

  for (const m of snapshot.machines) {
    const since = m.lastHeartbeatAt ?? m.lastSeenAt;
    const status: MonitorStatus = m.status;
    if (status === "offline") {
      alerts.push({
        code: "collector.offline",
        severity: "critical",
        message: `Collector "${m.name}" is offline (no heartbeat for >5 min)`,
        machineId: m.id,
        machineName: m.name,
        since,
      });
    } else if (status === "stale") {
      alerts.push({
        code: "collector.stale",
        severity: "warning",
        message: `Collector "${m.name}" is stale (no heartbeat for >90 s)`,
        machineId: m.id,
        machineName: m.name,
        since,
      });
    }
    // A backlog alert for an offline machine is noise — suppress it. Stale + backlogHigh
    // may BOTH fire (both are actionable).
    if (m.backlogHigh && status !== "offline") {
      alerts.push({
        code: "sync.backlog_high",
        severity: "warning",
        message: `Collector "${m.name}" sync backlog is high (${m.queuePending ?? 0} pending)`,
        machineId: m.id,
        machineName: m.name,
        since: null, // depth, not a timestamp
      });
    }
  }

  for (const c of snapshot.connectors) {
    if (
      c.toolCalls >= ALERT_THRESHOLDS.connectorFailMinCalls &&
      c.toolsFailed / c.toolCalls >= ALERT_THRESHOLDS.connectorFailRatio
    ) {
      alerts.push({
        code: "connector.failing",
        severity: "warning",
        message: `Connector "${c.sourceConnector}" is failing (${c.toolsFailed}/${c.toolCalls} tool calls failed)`,
        connector: c.sourceConnector,
        since: c.lastEventAt,
      });
    }
  }

  return sortAlerts(alerts);
}

/**
 * Sort alerts critical-first, stable within a severity (Array.prototype.sort is stable
 * in Node ≥ 24). Extracted from `deriveAlerts` (D2 — behaviour unchanged) so the route
 * can sort the MERGED list of `deriveAlerts` + `deriveBacklogTrendAlerts` output once.
 */
export function sortAlerts(alerts: OperationalAlert[]): OperationalAlert[] {
  return alerts.slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** One time-stamped sync-backlog reading from the heartbeat time-series (sorted asc by the repo). */
export interface BacklogSample {
  ts: string; // ISO
  queuePending: number;
}

/** Lookback window for the backlog-growing trend (the repo windows samples to this). */
export const BACKLOG_TREND_WINDOW_MS = 10 * 60_000; // 10 minutes

/**
 * A deliberately simple, tunable trend heuristic — a recent-window slope model is a
 * deferred refinement, sibling of `connector.failing`'s lifetime-ratio honest-limit
 * note. `minSamples` avoids a false positive on a fresh collector; `minGrowth` is the
 * pending-count rise (first→last) over the window that counts as "growing".
 */
export const BACKLOG_TREND_THRESHOLDS = { minSamples: 3, minGrowth: 50 } as const;

/**
 * Pure trend test: did the backlog rise by ≥ `minGrowth` across a window of ≥ `minSamples`
 * samples? Clock-free — the repo pre-windows + sorts the samples ascending by `ts`.
 */
export function deriveBacklogTrend(samples: BacklogSample[]): boolean {
  if (samples.length < BACKLOG_TREND_THRESHOLDS.minSamples) return false;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return last.queuePending - first.queuePending >= BACKLOG_TREND_THRESHOLDS.minGrowth;
}

/**
 * Emit a `sync.backlog_growing` (warning) per machine whose recent backlog is rising
 * (D2 — sibling of `deriveAlerts`, NOT folded into it). Offline machines are suppressed
 * (mirrors the backlog-high offline suppression in `deriveAlerts`; they emit no samples
 * anyway). `since` carries the last sample's ts as a display label.
 */
export function deriveBacklogTrendAlerts(
  machines: LiveMonitorSnapshot["machines"],
  samplesByMachine: Map<string, BacklogSample[]>,
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const m of machines) {
    if (m.status === "offline") continue;
    const s = samplesByMachine.get(m.id) ?? [];
    if (!deriveBacklogTrend(s)) continue;
    const first = s[0]!;
    const last = s[s.length - 1]!;
    alerts.push({
      code: "sync.backlog_growing",
      severity: "warning",
      message: `Collector "${m.name}" sync backlog is growing (${first.queuePending}→${last.queuePending} pending)`,
      machineId: m.id,
      machineName: m.name,
      since: last.ts,
    });
  }
  return alerts;
}

/**
 * Emit a `catalog.update_requires_approval` (warning) when ≥1 signed pricing-catalog
 * update is awaiting approval (PRD §20/§10.4/§18). Pure + clock-free — sibling of
 * deriveBacklogTrendAlerts (3c D2); `deriveAlerts` stays frozen. `since` is null (a
 * count/state, like sync.backlog_high). Severity is `warning` (tunable: it needs
 * admin action, but no catalog ever changes a cost until approval, so it is not an
 * outage). Keys on neither machine nor connector → alertKey
 * "catalog.update_requires_approval:*" (one firing). Merged + re-sorted by sortAlerts
 * in the route, not here.
 */
export function deriveCatalogAlerts(pendingCount: number): OperationalAlert[] {
  if (pendingCount <= 0) return [];
  return [
    {
      code: "catalog.update_requires_approval",
      severity: "warning",
      message: `${pendingCount} signed pricing-catalog update${pendingCount === 1 ? "" : "s"} awaiting approval`,
      since: null,
    },
  ];
}

/** Windowed ingest-auth-failure alert (PRD §20). Window + threshold tunable. */
export const AUTH_FAILURE_ALERT = { windowMs: 15 * 60_000, minFailures: 3 } as const;

/**
 * Emit a GLOBAL `ingest.auth_failure` (warning) when ≥ minFailures invalid/revoked-token
 * ingest attempts occurred in the window (M12 12.6, PRD §20). Pure + clock-free — the
 * route computes the count via countRecentAuthFailures. Keys on neither machine nor
 * connector → alertKey "ingest.auth_failure:*" (one firing). Sibling of deriveCatalogAlerts;
 * `deriveAlerts` stays frozen — merged + re-sorted by sortAlerts in the route.
 */
export function deriveAuthFailureAlerts(recentCount: number): OperationalAlert[] {
  if (recentCount < AUTH_FAILURE_ALERT.minFailures) return [];
  return [
    {
      code: "ingest.auth_failure",
      severity: "warning",
      message: `${recentCount} ingest authentication failures in the last ${AUTH_FAILURE_ALERT.windowMs / 60_000} min`,
      since: null, // a count, not a timestamp (like sync.backlog_high / catalog)
    },
  ];
}

/** Consecutive collector→archive sync failures before we alert (collector-reported). */
export const ARCHIVE_UNREACHABLE_MIN_FAILURES = 3;

/**
 * Emit a per-machine `archive.unreachable` (warning) when a collector reports ≥ N consecutive
 * sync failures (M12 12.6, PRD §20). Reads the already-projected `consecutiveSyncFailures`;
 * offline machines are SUPPRESSED (mirrors the backlog-high offline suppression in deriveAlerts
 * — `collector.offline` already covers them, and the reported count is stale once heartbeats
 * stop). `since` = lastHeartbeatAt/lastSeenAt (display label). Sibling of deriveBacklogTrendAlerts.
 */
export function deriveArchiveUnreachableAlerts(
  machines: LiveMonitorSnapshot["machines"],
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const m of machines) {
    if (m.status === "offline") continue;
    if ((m.consecutiveSyncFailures ?? 0) < ARCHIVE_UNREACHABLE_MIN_FAILURES) continue;
    alerts.push({
      code: "archive.unreachable",
      severity: "warning",
      message: `Collector "${m.name}" cannot reach the archive (${m.consecutiveSyncFailures} consecutive sync failures)`,
      machineId: m.id,
      machineName: m.name,
      since: m.lastHeartbeatAt ?? m.lastSeenAt,
    });
  }
  return alerts;
}
