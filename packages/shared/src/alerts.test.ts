import { describe, it, expect } from "vitest";
import { emptyMonitorSnapshot, type LiveMonitorSnapshot, type MonitorStatus } from "./monitor.js";
import type { ConnectorHealthRow } from "./projections.js";
import { deriveAlerts, ALERT_THRESHOLDS, ALERT_VERSION } from "./alerts.js";

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
