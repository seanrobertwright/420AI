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
import {
  deriveAlertSet,
  deriveDeploymentAlertSet,
  openFiringsDiverge,
  reconcileThrottleKey,
  DEPLOYMENT_THROTTLE_KEY,
} from "./alert-set.js";
import { alertKey } from "@420ai/shared";

/**
 * M16 16.6 / 16.7 — the shared alert composition, tested WITHOUT a database.
 *
 * WHY THIS FILE EXISTS (16.6). The composition makes the flap invariant structural: the background
 * tick and `GET /v1/monitor` must derive the same codes, because the reconcile resolves every open
 * firing absent from the derived set, so two lists that disagree make firings flap. Yet its only
 * coverage was the integration suite, behind a DOUBLE env gate (`skipIf(!TEST_URL || !APP_URL)`) —
 * i.e. the invariant that exists to be provable was provable only when Postgres happened to be
 * running. `skipped ≠ passed`, applied to the guard rather than the feature.
 *
 * WHAT 16.7 CHANGED, AND WHY THIS FILE'S THESIS IS REWRITTEN RATHER THAN EXTENDED.
 *
 * The mechanism this file was written to defend — "there is ONE list, so the two callers cannot
 * disagree" — IS NO LONGER THE MECHANISM. There are now two lists, because two of the nine codes
 * belong to the deployment rather than to any tenant, and deriving those per-org opened one firing
 * per org for one condition.
 *
 * The property that replaces it is DISJOINTNESS: the org reconcile filters `org_id = :orgId` and
 * the deployment reconcile filters `org_id IS NULL`, so neither scope can resolve the other's
 * firings HOWEVER the two lists diverge. That is strictly stronger than a shared list — it survives
 * a caller getting the split wrong — but it is only true while the two derive functions stay
 * disjoint in the codes they emit, and NOTHING in the type system says so. Adding
 * `deriveCatalogAlerts` back into `deriveAlertSet` typechecks perfectly and silently restores the
 * bug 16.7 exists to fix.
 *
 * So the disjointness is asserted here, as an executable claim rather than a comment (D-16.7-3),
 * alongside the surviving per-scope COMPLETENESS tests. This file is pure: no DB, no clock of its
 * own, always runs in `npm test`.
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
  windowedConnectors: [],
};

/** The two codes that belong to the DEPLOYMENT, not to any tenant (16.7). */
const DEPLOYMENT_CODES: AlertCode[] = ["catalog.update_requires_approval", "ingest.auth_failure"];

describe("deriveAlertSet — the shared ORG-scoped composition", () => {
  it("derives NOTHING from a healthy snapshot with no signals", () => {
    expect(deriveAlertSet(snapshot({ machines: [machine()] }), NO_INPUTS)).toEqual([]);
  });

  it("emits ALL SEVEN org codes when every org condition is present", () => {
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
      { samplesByMachine: samples, windowedConnectors: [windowedConnector as never] },
    );

    const codes = new Set<AlertCode>(alerts.map((a) => a.code));
    expect([...codes].sort()).toEqual(
      [
        "archive.unreachable",
        "collector.offline",
        "collector.stale",
        "connector.failing",
        "connector.failure_rate",
        "sync.backlog_growing",
        "sync.backlog_high",
      ].sort(),
    );
    expect(codes.size).toBe(7);
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

/**
 * M16 16.7 — D-16.7-3 AS AN EXECUTABLE CLAIM.
 *
 * These are the tests that would fail if someone "completed the pattern" by putting the catalog or
 * auth-failure derivation back into `deriveAlertSet`. Nothing else would: both call sites
 * typecheck, both suites stay green, and the only symptom would be one firing per org for one
 * deployment-wide condition — the exact defect 16.7 shipped to remove, silently restored.
 */
describe("the two scopes are DISJOINT (D-16.7-3)", () => {
  /** Every org input turned maximally "loud", so any leaked global code would show up. */
  function loudOrgAlerts() {
    return deriveAlertSet(
      snapshot({
        machines: [
          machine({ id: "m-off", status: "offline" }),
          machine({ id: "m-stale", status: "stale" }),
          machine({ id: "m-back", backlogHigh: true, queuePending: 5000 }),
          machine({
            id: "m-unreach",
            consecutiveSyncFailures: ARCHIVE_UNREACHABLE_MIN_FAILURES,
          }),
        ],
        connectors: [
          {
            sourceConnector: "claude-code",
            toolCalls: ALERT_THRESHOLDS.connectorFailMinCalls,
            toolsFailed: ALERT_THRESHOLDS.connectorFailMinCalls,
            lastEventAt: "2026-08-06T11:59:00.000Z",
          } as never,
        ],
      }),
      {
        samplesByMachine: new Map(),
        windowedConnectors: [
          {
            sourceConnector: "codex",
            toolCalls: CONNECTOR_RATE_ALERT.minCalls,
            toolsFailed: CONNECTOR_RATE_ALERT.minCalls,
            lastEventAt: "2026-08-06T11:59:00.000Z",
          } as never,
        ],
      },
    );
  }

  it("deriveAlertSet returns NONE of the deployment codes, for any input", () => {
    const codes = loudOrgAlerts().map((a) => a.code);
    for (const global of DEPLOYMENT_CODES) {
      expect(codes, `${global} leaked into the ORG scope`).not.toContain(global);
    }
  });

  it("deriveDeploymentAlertSet returns ONLY the deployment codes", () => {
    const alerts = deriveDeploymentAlertSet({
      pendingCatalogs: 3,
      authFailureCount: AUTH_FAILURE_ALERT.minFailures,
    });
    expect(alerts.map((a) => a.code).sort()).toEqual([...DEPLOYMENT_CODES].sort());
  });

  it("the two ALERT-KEY sets never intersect — which is what makes neither able to flap the other", () => {
    // Compared by `alertKey`, not by code, because `alertKey` is what the reconcile's
    // `notInArray` predicate actually compares. A shared code with different keys would be
    // harmless; a shared KEY is what would make one scope resolve the other's row.
    const orgKeys = new Set(loudOrgAlerts().map(alertKey));
    const deploymentKeys = new Set(
      deriveDeploymentAlertSet({
        pendingCatalogs: 1,
        authFailureCount: AUTH_FAILURE_ALERT.minFailures,
      }).map(alertKey),
    );
    expect(orgKeys.size).toBeGreaterThan(0);
    expect(deploymentKeys.size).toBe(2);
    for (const key of deploymentKeys) {
      expect(orgKeys.has(key), `key ${key} appears in BOTH scopes`).toBe(false);
    }
  });

  it("deriveDeploymentAlertSet is silent below both thresholds", () => {
    expect(deriveDeploymentAlertSet({ pendingCatalogs: 0, authFailureCount: 0 })).toEqual([]);
    // The auth-failure derivation is a THRESHOLD, not a presence check — one failure is noise.
    expect(
      deriveDeploymentAlertSet({
        pendingCatalogs: 0,
        authFailureCount: AUTH_FAILURE_ALERT.minFailures - 1,
      }),
    ).toEqual([]);
  });
});

describe("reconcile throttle keys (M16 16.7)", () => {
  it("the deployment sentinel cannot collide with a real (org, user) key", () => {
    // `reconcileThrottleKey` composes two uuids; `*` is not a uuid character. A collision would
    // make one org's reconcile throttle suppress the deployment's, or vice versa.
    const real = reconcileThrottleKey(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );
    expect(real).not.toBe(DEPLOYMENT_THROTTLE_KEY);
    expect(DEPLOYMENT_THROTTLE_KEY).toContain("*");
  });

  it("is stable and org+user-grained", () => {
    expect(reconcileThrottleKey("o", "u")).toBe(reconcileThrottleKey("o", "u"));
    expect(reconcileThrottleKey("o", "u1")).not.toBe(reconcileThrottleKey("o", "u2"));
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
