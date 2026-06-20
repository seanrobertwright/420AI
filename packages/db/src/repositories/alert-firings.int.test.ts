import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { OperationalAlert } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines, alertFirings } from "../schema.js";
import {
  reconcileAlertFirings,
  listAlertFirings,
  ackAlertFiring,
} from "./alert-firings.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/** A fixed clock; firings are reconciled at explicit t0…t4 for determinism. */
const t0 = new Date("2026-06-15T12:00:00.000Z");
const t1 = new Date("2026-06-15T12:01:00.000Z");
const t2 = new Date("2026-06-15T12:02:00.000Z");
const t3 = new Date("2026-06-15T12:03:00.000Z");
const t4 = new Date("2026-06-15T12:04:00.000Z");

describe.skipIf(!TEST_URL)("alert-firings repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let userId: string;
  let machineId: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE alert_firings, machine_heartbeats, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId, name: "laptop", os: "win32", hostname: "host-1" })
      .returning({ id: machines.id });
    machineId = m!.id;
  });

  /** Build an offline-collector alert fixture for this machine. */
  function offlineAlert(): OperationalAlert {
    return {
      code: "collector.offline",
      severity: "critical",
      message: `Collector "laptop" is offline (no heartbeat for >5 min)`,
      machineId,
      machineName: "laptop",
      since: "2026-06-15T11:50:00.000Z",
    };
  }

  /** Count rows for a given alert_key (across statuses). */
  async function keyCount(alertKeyVal: string): Promise<number> {
    const rows = await dbh.db
      .select({ id: alertFirings.id })
      .from(alertFirings)
      .where(and(eq(alertFirings.userId, userId), eq(alertFirings.alertKey, alertKeyVal)));
    return rows.length;
  }

  it("opens a firing: status open, first_fired_at ≈ t0, acked_at null, derived alert_key", async () => {
    const firings = await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    expect(firings).toHaveLength(1);
    const f = firings[0]!;
    expect(f.status).toBe("open");
    expect(f.alertKey).toBe(`collector.offline:${machineId}`);
    expect(f.firstFiredAt).toBe(t0.toISOString());
    expect(f.lastSeenAt).toBe(t0.toISOString());
    expect(f.ackedAt).toBeNull();
    expect(f.resolvedAt).toBeNull();
    expect(f.machineId).toBe(machineId);
    expect(f.severity).toBe("critical");
  });

  it("idempotent re-fire: ONE row, first_fired_at unchanged, last_seen_at advances", async () => {
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    const after = await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t1);
    // The partial unique index holds: still exactly one row for the key.
    expect(await keyCount(`collector.offline:${machineId}`)).toBe(1);
    const f = after.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f.firstFiredAt).toBe(t0.toISOString()); // NOT overwritten (D4)
    expect(f.lastSeenAt).toBe(t1.toISOString()); // advanced
    expect(f.status).toBe("open");
  });

  it("resolve: reconciling [] resolves the open firing (notInArray([]) → true); a 2nd [] is a no-op", async () => {
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    const resolved = await reconcileAlertFirings(dbh.db, userId, [], t2);
    const f = resolved.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f.status).toBe("resolved");
    expect(f.resolvedAt).toBe(t2.toISOString());
    // A second reconcile with [] doesn't touch the already-resolved row.
    const again = await reconcileAlertFirings(dbh.db, userId, [], t3);
    const f2 = again.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f2.status).toBe("resolved");
    expect(f2.resolvedAt).toBe(t2.toISOString()); // still t2, not t3
  });

  it("re-fire after resolve: a NEW open row with a fresh first_fired_at (the resolved row stays)", async () => {
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    await reconcileAlertFirings(dbh.db, userId, [], t2); // resolve
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t3); // re-fire
    // Two rows now exist for the key: the resolved one + the new open one.
    expect(await keyCount(`collector.offline:${machineId}`)).toBe(2);
    const current = await listAlertFirings(dbh.db, userId, t3);
    const open = current.find(
      (x) => x.alertKey === `collector.offline:${machineId}` && x.status === "open",
    )!;
    expect(open.firstFiredAt).toBe(t3.toISOString());
    expect(open.ackedAt).toBeNull();
  });

  it("ack: sets acked_at, stays open; unknown id and other-user id → undefined (scoped)", async () => {
    const [opened] = await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    const acked = await ackAlertFiring(dbh.db, userId, opened!.id, t4);
    expect(acked).toBeDefined();
    expect(acked!.ackedAt).toBe(t4.toISOString());
    expect(acked!.status).toBe("open"); // ack does NOT resolve

    // Unknown id → undefined.
    expect(
      await ackAlertFiring(dbh.db, userId, "00000000-0000-0000-0000-000000000000", t4),
    ).toBeUndefined();

    // Another user cannot ack this firing (userId-scoped).
    const [u2] = await dbh.db
      .insert(users)
      .values({ email: "other@example.com" })
      .returning({ id: users.id });
    expect(await ackAlertFiring(dbh.db, u2!.id, opened!.id, t4)).toBeUndefined();
  });

  it("list window: a firing resolved beyond the resolved-window is excluded; an open one is always included", async () => {
    // Open + resolve at t0/t2.
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], t0);
    await reconcileAlertFirings(dbh.db, userId, [], t2);
    // A `now` far past the resolved window (> 1h after t2) drops the resolved firing.
    const farLater = new Date(t2.getTime() + 2 * 60 * 60_000);
    const listed = await listAlertFirings(dbh.db, userId, farLater);
    expect(listed.find((x) => x.alertKey === `collector.offline:${machineId}`)).toBeUndefined();

    // A still-open firing is always listed regardless of `now`.
    await reconcileAlertFirings(dbh.db, userId, [offlineAlert()], farLater);
    const withOpen = await listAlertFirings(dbh.db, userId, new Date(farLater.getTime() + 60_000));
    expect(
      withOpen.find(
        (x) => x.alertKey === `collector.offline:${machineId}` && x.status === "open",
      ),
    ).toBeDefined();
  });

  it("connector firing: machine_id NULL, alert_key keyed on connector", async () => {
    const connectorAlert: OperationalAlert = {
      code: "connector.failing",
      severity: "warning",
      message: `Connector "claude-code" is failing (6/10 tool calls failed)`,
      connector: "claude-code",
      since: "2026-06-15T11:59:00.000Z",
    };
    const [f] = await reconcileAlertFirings(dbh.db, userId, [connectorAlert], t0);
    expect(f!.alertKey).toBe("connector.failing:claude-code");
    expect(f!.machineId).toBeNull();
    expect(f!.connector).toBe("claude-code");
  });
});
