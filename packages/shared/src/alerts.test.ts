import { describe, it, expect } from "vitest";
import { emptyMonitorSnapshot, type LiveMonitorSnapshot, type MonitorStatus } from "./monitor.js";
import type { ConnectorHealthRow } from "./projections.js";
import {
  deriveAlerts,
  deriveBacklogTrend,
  deriveBacklogTrendAlerts,
  deriveCatalogAlerts,
  sortAlerts,
  ALERT_THRESHOLDS,
  ALERT_VERSION,
  BACKLOG_TREND_THRESHOLDS,
  type BacklogSample,
  type OperationalAlert,
} from "./alerts.js";
import { alertKey } from "./alert-firings.js";

type MachineRow = LiveMonitorSnapshot["machines"][number];

const HB = "2026-06-15T11:55:00.000Z";

function machine(over: Partial<MachineRow> & { status: MonitorStatus }): MachineRow {
  return {
    id: "m1",
    name: "laptop",
    os: "linux",
    hostname: "host",
    lastSeenAt: HB,
    lastHeartbeatAt: HB,
    queuePending: 0,
    queueInflight: 0,
    collectorVersion: "0.9.1",
    backlogHigh: false,
    ...over,
  };
}

function connector(over: Partial<ConnectorHealthRow> & { sourceConnector: string }): ConnectorHealthRow {
  return {
    lastEventAt: "2026-06-15T11:59:00.000Z",
    eventCount: 0,
    toolCalls: 0,
    toolsFailed: 0,
    parserVersions: ["2.0.0"],
    models: [],
    ...over,
  };
}

/** Build a snapshot from the empty helper, then attach machines/connectors. */
function snapshot(over: Partial<LiveMonitorSnapshot>): LiveMonitorSnapshot {
  return { ...emptyMonitorSnapshot("2026-06-15T12:00:00.000Z"), ...over };
}

describe("deriveAlerts", () => {
  it("empty snapshot → no alerts", () => {
    expect(deriveAlerts(emptyMonitorSnapshot("2026-06-15T12:00:00.000Z"))).toEqual([]);
  });

  it("one offline machine → exactly one critical collector.offline; since = lastHeartbeatAt", () => {
    const snap = snapshot({ machines: [machine({ id: "m1", name: "box", status: "offline" })] });
    const alerts = deriveAlerts(snap);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.code).toBe("collector.offline");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.machineId).toBe("m1");
    expect(alerts[0]!.machineName).toBe("box");
    expect(alerts[0]!.since).toBe(HB);
  });

  it("offline machine with no heartbeat falls back to lastSeenAt for since", () => {
    const snap = snapshot({
      machines: [machine({ status: "offline", lastHeartbeatAt: null, lastSeenAt: HB })],
    });
    expect(deriveAlerts(snap)[0]!.since).toBe(HB);
  });

  it("stale machine with backlogHigh → BOTH collector.stale and sync.backlog_high (warnings)", () => {
    const snap = snapshot({
      machines: [machine({ status: "stale", backlogHigh: true, queuePending: 250 })],
    });
    const codes = deriveAlerts(snap).map((a) => a.code);
    expect(codes).toContain("collector.stale");
    expect(codes).toContain("sync.backlog_high");
    expect(deriveAlerts(snap).every((a) => a.severity === "warning")).toBe(true);
    // backlog alert carries no timestamp (depth, not evidence-time)
    const backlog = deriveAlerts(snap).find((a) => a.code === "sync.backlog_high")!;
    expect(backlog.since).toBeNull();
    expect(backlog.message).toContain("250 pending");
  });

  it("offline machine with backlogHigh → ONLY collector.offline (backlog suppressed when offline)", () => {
    const snap = snapshot({
      machines: [machine({ status: "offline", backlogHigh: true, queuePending: 500 })],
    });
    const codes = deriveAlerts(snap).map((a) => a.code);
    expect(codes).toEqual(["collector.offline"]);
  });

  it("online machine → no liveness alert", () => {
    const snap = snapshot({ machines: [machine({ status: "online" })] });
    expect(deriveAlerts(snap)).toEqual([]);
  });

  it("connector with 10 calls / 6 failed (≥minCalls, ≥ratio) → connector.failing", () => {
    const snap = snapshot({
      connectors: [connector({ sourceConnector: "claude-code", toolCalls: 10, toolsFailed: 6 })],
    });
    const alerts = deriveAlerts(snap);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.code).toBe("connector.failing");
    expect(alerts[0]!.connector).toBe("claude-code");
    expect(alerts[0]!.message).toContain("6/10");
    expect(alerts[0]!.since).toBe("2026-06-15T11:59:00.000Z");
  });

  it("connector with 10 calls / 2 failed (below ratio) → no alert", () => {
    const snap = snapshot({
      connectors: [connector({ sourceConnector: "claude-code", toolCalls: 10, toolsFailed: 2 })],
    });
    expect(deriveAlerts(snap)).toEqual([]);
  });

  it("connector with 3 calls / 3 failed (below minCalls) → no alert (and no divide-by-zero risk)", () => {
    const snap = snapshot({
      connectors: [connector({ sourceConnector: "claude-code", toolCalls: 3, toolsFailed: 3 })],
    });
    expect(deriveAlerts(snap)).toEqual([]);
  });

  it("connector with 0 tool calls → no alert (divide-by-zero guard via minCalls)", () => {
    const snap = snapshot({
      connectors: [connector({ sourceConnector: "claude-code", toolCalls: 0, toolsFailed: 0 })],
    });
    expect(deriveAlerts(snap)).toEqual([]);
  });

  it("ratio boundary is inclusive: exactly minCalls calls at exactly the ratio fires", () => {
    const snap = snapshot({
      connectors: [
        connector({
          sourceConnector: "claude-code",
          toolCalls: ALERT_THRESHOLDS.connectorFailMinCalls,
          toolsFailed: Math.ceil(ALERT_THRESHOLDS.connectorFailMinCalls * ALERT_THRESHOLDS.connectorFailRatio),
        }),
      ],
    });
    expect(deriveAlerts(snap).map((a) => a.code)).toEqual(["connector.failing"]);
  });

  it("sorts critical-first even when a stale (warning) machine precedes an offline (critical) one", () => {
    const snap = snapshot({
      machines: [
        machine({ id: "stale-1", name: "a", status: "stale" }),
        machine({ id: "off-1", name: "b", status: "offline" }),
      ],
    });
    const codes = deriveAlerts(snap).map((a) => a.code);
    expect(codes[0]).toBe("collector.offline"); // critical first despite later snapshot order
    expect(codes).toContain("collector.stale");
  });

  it("ALERT_VERSION is the stable stamp", () => {
    expect(ALERT_VERSION).toBe("m10-alerts-v1");
  });
});

/** Build a windowed, ascending-by-ts sample list (the repo's contract for deriveBacklogTrend). */
function samples(...pending: number[]): BacklogSample[] {
  return pending.map((queuePending, i) => ({
    ts: `2026-06-15T12:0${i}:00.000Z`,
    queuePending,
  }));
}

describe("deriveBacklogTrend", () => {
  it("no samples → false", () => {
    expect(deriveBacklogTrend([])).toBe(false);
  });

  it("fewer than minSamples → false (no false positive on a fresh collector)", () => {
    // 2 samples even with a huge jump is below minSamples (3).
    expect(deriveBacklogTrend(samples(0, 500))).toBe(false);
  });

  it("minSamples samples rising by ≥ minGrowth → true", () => {
    expect(deriveBacklogTrend(samples(10, 40, 10 + BACKLOG_TREND_THRESHOLDS.minGrowth))).toBe(true);
  });

  it("minSamples samples rising by < minGrowth → false", () => {
    expect(deriveBacklogTrend(samples(10, 20, 10 + BACKLOG_TREND_THRESHOLDS.minGrowth - 1))).toBe(false);
  });

  it("flat or declining window → false", () => {
    expect(deriveBacklogTrend(samples(100, 100, 100))).toBe(false);
    expect(deriveBacklogTrend(samples(200, 150, 100))).toBe(false);
  });
});

describe("deriveBacklogTrendAlerts", () => {
  const machineRow = (over: Partial<MachineRow> & { status: MonitorStatus }): MachineRow =>
    machine(over);

  it("a non-offline machine with a rising window → one sync.backlog_growing (warning)", () => {
    const m = machineRow({ id: "m1", name: "box", status: "online" });
    const byMachine = new Map<string, BacklogSample[]>([["m1", samples(10, 60, 110)]]);
    const alerts = deriveBacklogTrendAlerts([m], byMachine);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.code).toBe("sync.backlog_growing");
    expect(alerts[0]!.severity).toBe("warning");
    expect(alerts[0]!.machineId).toBe("m1");
    expect(alerts[0]!.message).toContain("→");
    expect(alerts[0]!.message).toContain("10→110");
    // since = the last sample's ts (display label)
    expect(alerts[0]!.since).toBe("2026-06-15T12:02:00.000Z");
  });

  it("an offline machine with a rising window → suppressed (no alert)", () => {
    const m = machineRow({ id: "m1", name: "box", status: "offline" });
    const byMachine = new Map<string, BacklogSample[]>([["m1", samples(10, 60, 110)]]);
    expect(deriveBacklogTrendAlerts([m], byMachine)).toEqual([]);
  });

  it("a machine with no samples → no alert", () => {
    const m = machineRow({ id: "m1", name: "box", status: "online" });
    expect(deriveBacklogTrendAlerts([m], new Map())).toEqual([]);
  });
});

describe("deriveCatalogAlerts", () => {
  it("zero pending → no alert", () => {
    expect(deriveCatalogAlerts(0)).toEqual([]);
    expect(deriveCatalogAlerts(-1)).toEqual([]);
  });

  it("one pending → one catalog.update_requires_approval warning, since null, singular message", () => {
    const alerts = deriveCatalogAlerts(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.code).toBe("catalog.update_requires_approval");
    expect(alerts[0]!.severity).toBe("warning");
    expect(alerts[0]!.since).toBeNull();
    expect(alerts[0]!.message).toContain("1 signed pricing-catalog update awaiting approval");
  });

  it("multiple pending → pluralized message", () => {
    expect(deriveCatalogAlerts(3)[0]!.message).toContain("3 signed pricing-catalog updates awaiting approval");
  });

  it("keys on neither machine nor connector → alertKey catalog.update_requires_approval:*", () => {
    const [a] = deriveCatalogAlerts(2);
    expect(alertKey(a!)).toBe("catalog.update_requires_approval:*");
  });
});

describe("sortAlerts", () => {
  const a = (severity: OperationalAlert["severity"], code: OperationalAlert["code"]): OperationalAlert => ({
    code,
    severity,
    message: code,
    since: null,
  });

  it("orders critical before warning regardless of input order", () => {
    const sorted = sortAlerts([a("warning", "collector.stale"), a("critical", "collector.offline")]);
    expect(sorted.map((x) => x.severity)).toEqual(["critical", "warning"]);
  });

  it("is stable within a severity (preserves input order)", () => {
    const first = a("warning", "sync.backlog_high");
    const second = a("warning", "connector.failing");
    const sorted = sortAlerts([first, second]);
    expect(sorted[0]!.code).toBe("sync.backlog_high");
    expect(sorted[1]!.code).toBe("connector.failing");
  });
});

describe("alertKey", () => {
  it("a machine alert keys on machineId", () => {
    expect(alertKey({ code: "collector.offline", machineId: "m1", connector: undefined })).toBe(
      "collector.offline:m1",
    );
  });

  it("a connector alert keys on connector", () => {
    expect(alertKey({ code: "connector.failing", machineId: undefined, connector: "claude-code" })).toBe(
      "connector.failing:claude-code",
    );
  });
});
