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
 * event), NOT a "fired at" time. A persisted firing/ack engine is a deferred M10 slice.
 */

/** Alert urgency, rendered critical-first. */
export type AlertSeverity = "critical" | "warning" | "info";

/** The operational-alert conditions derivable from the M9 snapshot today (PRD §20 subset). */
export type AlertCode =
  | "collector.offline"
  | "collector.stale"
  | "connector.failing"
  | "sync.backlog_high";

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

  return alerts
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
