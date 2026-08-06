import { describe, it, expect } from "vitest";
import {
  MONITOR_VERSION,
  ALERT_THRESHOLDS,
  CONNECTOR_RATE_ALERT,
  ARCHIVE_UNREACHABLE_MIN_FAILURES,
  BACKLOG_TREND_THRESHOLDS,
  AUTH_FAILURE_ALERT,
  type AlertCode,
  type LiveMonitorSnapshot,
} from "@420ai/shared";
import { deriveAlertSet, openFiringsDiverge } from "./alert-set.js";

/**
 * M16 16.6 — the shared alert composition, tested WITHOUT a database.
 *
 * `deriveAlertSet` exists specifically to make the flap invariant structural: the background tick
 * and `GET /v1/monitor` must derive the same codes, because `reconcileAlertFirings` resolves every
 * open firing absent from the derived set, so two lists that disagree make firings flap. Yet its
 * only coverage was the integration suite, behind a DOUBLE env gate
 * (`skipIf(!TEST_URL || !APP_URL)`) — i.e. the invariant that exists to be provable was provable
 * only when Postgres happened to be running. `skipped ≠ passed`, applied to the guard rather than
 * the feature.
 *
 * This file is pure: no DB, no clock of its own, always runs in `npm test`.
 */

/** A machine row already carrying its derived `status`/`backlogHigh`, as both callers pass. */
function machine(over: Partial<LiveMonitorSnapshot["machines"][number]> = {}) {
  return {
    id: "m1",
    name: "dogfood",
    status: "online" as const,
    lastSeenAt: "2026-08-06T12:00:00.000Z",
    lastHeartbeatAt: "2026-08-06T12:00:00.000Z",
    queuePending: 0,
    queueInflight: 0,
    collectorVersion: "0.9.1",
    consecutiveSyncFailures: 0,
    backlogHigh: false,
    ...over,
  } as LiveMonitorSnapshot["machines"][number];
}

function snapshot(over: Partial<LiveMonitorSnapshot> = {}): LiveMonitorSnapshot {
  return {
    monitorVersion: MONITOR_VERSION,
    generatedAt: "2026-08-06T12:00:00.000Z",
    machines: [],
    connectors: [],
    activeSessions: [],
    alerts: [],
    alertFirings: [],
    ...over,
  };
}

const NO_INPUTS = {
  samplesByMachine: new Map(),
  pendingCatalogs: 0,
  authFailureCount: 0,
  windowedConnectors: [],
};

describe("deriveAlertSet — the shared nine-code composition", () => {
  it("derives NOTHING from a healthy snapshot with no signals", () => {
    expect(deriveAlertSet(snapshot({ machines: [machine()] }), NO_INPUTS)).toEqual([]);
  });

  it("emits ALL NINE codes when every condition is present", () => {
    // THE PARITY TEST, at the pure layer. If a future edit drops a derive call from the shared
    // composition, this fails in `npm test` with no infrastructure — before the DB-gated suite
    // (which may be skipped) ever gets a chance to notice.
    const offline = machine({ id: "m-off", name: "off", status: "offline" });
    const stale = machine({ id: "m-stale", name: "stale", status: "stale" });
    const backlog = machine({
      id: "m-back",
      name: "back",
      status: "online",
      backlogHigh: true,
      queuePending: 5000,
    });
    const unreachable = machine({
      id: "m-unreach",
      name: "unreach",
      status: "online",
      consecutiveSyncFailures: ARCHIVE_UNREACHABLE_MIN_FAILURES,
    });
    const growing = machine({ id: "m-grow", name: "grow", status: "online" });

    const failingConnector = {
      sourceConnector: "claude-code",
      toolCalls: ALERT_THRESHOLDS.connectorFailMinCalls,
      toolsFailed: ALERT_THRESHOLDS.connectorFailMinCalls,
      lastEventAt: "2026-08-06T11:59:00.000Z",
    };
    const windowedConnector = {
      sourceConnector: "codex",
      toolCalls: CONNECTOR_RATE_ALERT.minCalls,
      toolsFailed: CONNECTOR_RATE_ALERT.minCalls,
      lastEventAt: "2026-08-06T11:59:00.000Z",
    };

    const samples = new Map([
      [
        "m-grow",
        Array.from({ length: BACKLOG_TREND_THRESHOLDS.minSamples }, (_, i) => ({
          ts: `2026-08-06T11:5${i}:00.000Z`,
          queuePending: i * BACKLOG_TREND_THRESHOLDS.minGrowth,
        })),
      ],
    ]);

    const alerts = deriveAlertSet(
      snapshot({
        machines: [offline, stale, backlog, unreachable, growing],
        connectors: [failingConnector as never],
      }),
      {
        samplesByMachine: samples,
        pendingCatalogs: 1,
        authFailureCount: AUTH_FAILURE_ALERT.minFailures,
        windowedConnectors: [windowedConnector as never],
      },
    );

    const codes = new Set<AlertCode>(alerts.map((a) => a.code));
    expect([...codes].sort()).toEqual(
      [
        "archive.unreachable",
        "catalog.update_requires_approval",
        "collector.offline",
        "collector.stale",
        "connector.failing",
        "connector.failure_rate",
        "ingest.auth_failure",
        "sync.backlog_growing",
        "sync.backlog_high",
      ].sort(),
    );
    expect(codes.size).toBe(9);
  });

  it("reads snapshot.connectors — passing [] would silently DROP connector.failing", () => {
    // The exact trap the plan's own reference snippet contained. Stated as a test rather than a
    // comment, because a dropped code does not fail loudly: it makes the firing flap.
    const connectors = [
      {
        sourceConnector: "claude-code",
        toolCalls: ALERT_THRESHOLDS.connectorFailMinCalls,
        toolsFailed: ALERT_THRESHOLDS.connectorFailMinCalls,
        lastEventAt: "2026-08-06T11:59:00.000Z",
      } as never,
    ];
    const withConnectors = deriveAlertSet(snapshot({ connectors }), NO_INPUTS);
    const without = deriveAlertSet(snapshot({ connectors: [] }), NO_INPUTS);
    expect(withConnectors.some((a) => a.code === "connector.failing")).toBe(true);
    expect(without.some((a) => a.code === "connector.failing")).toBe(false);
  });

  it("ignores activeSessions entirely — which is why the tick may skip that query", () => {
    const base = deriveAlertSet(
      snapshot({ machines: [machine({ status: "offline" })] }),
      NO_INPUTS,
    );
    const withSessions = deriveAlertSet(
      snapshot({
        machines: [machine({ status: "offline" })],
        activeSessions: [{ sessionId: "s1" } as never],
      }),
      NO_INPUTS,
    );
    expect(withSessions).toEqual(base);
  });

  it("sorts critical first", () => {
    const alerts = deriveAlertSet(
      snapshot({
        machines: [
          machine({ id: "a", name: "stale-one", status: "stale" }),
          machine({ id: "b", name: "offline-one", status: "offline" }),
        ],
      }),
      NO_INPUTS,
    );
    expect(alerts[0]!.severity).toBe("critical");
  });
});

describe("openFiringsDiverge — the shared throttle override", () => {
  const alert = {
    code: "collector.offline" as const,
    severity: "critical" as const,
    message: "m",
    machineId: "m1",
    since: null,
  };
  const firing = (over: Record<string, unknown> = {}) =>
    ({ alertKey: "collector.offline:m1", status: "open", ...over }) as never;

  it("is false when the open firings match the derived set", () => {
    expect(openFiringsDiverge([alert], [firing()])).toBe(false);
  });

  it("is true when an alert has appeared", () => {
    expect(openFiringsDiverge([alert], [])).toBe(true);
  });

  it("is true when an alert has cleared", () => {
    expect(openFiringsDiverge([], [firing()])).toBe(true);
  });

  it("IGNORES recently-resolved firings — they linger as confirmation, not as state", () => {
    // If resolved rows counted, every tick in the resolve window would see a false divergence and
    // reconcile, defeating the throttle exactly when the system is recovering.
    expect(openFiringsDiverge([], [firing({ status: "resolved" })])).toBe(false);
  });
});
