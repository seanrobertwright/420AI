import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, recordHeartbeat, recordIngestAuthFailure } from "@420ai/db";
import type { AlertFiring, LiveMonitorSnapshot } from "@420ai/shared";
import { buildApp } from "./app.js";
import { AnalysisProviderError, type AnalysisProvider, type AnalysisRequest } from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// buildApp requires an analysis provider even though delivery tests never interpret.
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in delivery tests", "unavailable");
  },
};

/**
 * M12 12.6 alert delivery e2e (PRD §20). A SPY deliverer injected via buildApp proves the
 * evaluate-on-read delivery path: a newly-opened firing is pushed exactly once (the
 * delivery_attempted_at marker makes a re-read a no-op), and the two new §20 alert codes
 * (ingest.auth_failure, archive.unreachable) surface on the snapshot given their signals.
 */
describe.skipIf(!TEST_URL)("alert delivery + new §20 conditions (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  const delivered: AlertFiring[] = [];
  const deliverer = {
    deliver: vi.fn(async (f: AlertFiring): Promise<void> => {
      delivered.push(f);
    }),
  };

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
      alertDeliverer: deliverer,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  beforeEach(async () => {
    // ingest_auth_failures has NO FK, so the users-CASCADE won't clear it — TRUNCATE it explicitly.
    await dbh.db.execute(
      sql`TRUNCATE alert_firings, ingest_auth_failures, machine_heartbeats, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    deliverer.deliver.mockClear();
    delivered.length = 0;
  });

  async function pairMachine(): Promise<{ token: string; machineId: string }> {
    const code = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: {},
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code.json().code as string, machine: { name: "test-machine" } },
    });
    return res.json();
  }

  function getMonitor() {
    return app.inject({ method: "GET", url: "/v1/monitor", headers: { authorization: `Bearer ${ADMIN}` } });
  }

  it("delivers a newly-opened firing exactly once; a second read does NOT re-deliver", async () => {
    const { machineId } = await pairMachine();
    // An old heartbeat (>5 min) → the read-time reconcile opens a collector.offline firing.
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 0,
      queueInflight: 0,
      collectorVersion: "0.9.1",
      now: new Date(Date.now() - 10 * 60 * 1000),
    });

    const first = await getMonitor();
    expect(first.statusCode).toBe(200);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(delivered[0]!.code).toBe("collector.offline");
    expect(delivered[0]!.machineId).toBe(machineId);
    expect(delivered[0]!.status).toBe("open");

    // Second read: delivery_attempted_at is stamped → no re-delivery (at-most-once attempt).
    const second = await getMonitor();
    expect(second.statusCode).toBe(200);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
  });

  it("ingest.auth_failure surfaces once ≥3 failures are recorded in-window", async () => {
    await pairMachine(); // a user must exist for the read to resolve + reconcile

    // Below threshold first → no alert.
    await recordIngestAuthFailure(dbh.db, { remoteIp: "1.1.1.1" });
    await recordIngestAuthFailure(dbh.db, { remoteIp: "1.1.1.1" });
    const below = (await getMonitor()).json() as LiveMonitorSnapshot;
    expect(below.alerts.some((a) => a.code === "ingest.auth_failure")).toBe(false);

    // Crossing the threshold → a GLOBAL ingest.auth_failure warning + persisted firing.
    await recordIngestAuthFailure(dbh.db, { remoteIp: "2.2.2.2" });
    const body = (await getMonitor()).json() as LiveMonitorSnapshot;
    const alert = body.alerts.find((a) => a.code === "ingest.auth_failure");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
    expect(body.alertFirings.some((f) => f.code === "ingest.auth_failure" && f.status === "open")).toBe(true);
  });

  it("archive.unreachable surfaces for an online machine reporting ≥3 consecutive sync failures", async () => {
    const { machineId } = await pairMachine();
    // A FRESH heartbeat (online) carrying the failure count → archive.unreachable, not collector.offline.
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 0,
      queueInflight: 0,
      collectorVersion: "0.9.1",
      consecutiveSyncFailures: 3,
    });

    const body = (await getMonitor()).json() as LiveMonitorSnapshot;
    expect(body.machines[0]!.status).toBe("online");
    expect(body.machines[0]!.consecutiveSyncFailures).toBe(3);
    const alert = body.alerts.find((a) => a.code === "archive.unreachable" && a.machineId === machineId);
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });
});
