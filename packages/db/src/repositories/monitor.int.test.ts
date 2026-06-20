import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { deriveMachineStatus, isBacklogHigh } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines, events, machineHeartbeats } from "../schema.js";
import { recordHeartbeat } from "./machines.js";
import { machineStatuses, activeSessions, recentBacklogSamples } from "./monitor.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const SESSION = "sess-monitor-1";
// A fixed reference clock — events are seeded relative to it so the window cases are deterministic.
const NOW = new Date("2026-06-14T12:00:00.000Z");
const LAST_EVENT = "2026-06-14T12:00:00.000Z";

describe.skipIf(!TEST_URL)("monitor repository (integration)", () => {
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
      sql`TRUNCATE machine_heartbeats, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
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

  /** Seed one active session: a usage event + a message event at LAST_EVENT. */
  async function seedSession(): Promise<void> {
    await dbh.db.insert(events).values([
      {
        fingerprint: "mon-u1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "usage.reported",
        sessionId: SESSION,
        machineId,
        projectPath: "/home/a/420ai",
        gitBranch: "main",
        model: "claude-opus-4-8",
        ts: "2026-06-14T11:59:00.000Z",
      },
      {
        fingerprint: "mon-m1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r2",
        eventIndex: 1,
        eventType: "message.user",
        sessionId: SESSION,
        machineId,
        projectPath: "/home/a/420ai",
        gitBranch: "main",
        ts: LAST_EVENT,
      },
    ]);
  }

  it("machineStatuses returns the persisted heartbeat backlog + version (Date→ISO normalized)", async () => {
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 142,
      queueInflight: 3,
      collectorVersion: "0.9.0",
      now: NOW,
    });
    const rows = await machineStatuses(dbh.db, userId);
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.id).toBe(machineId);
    expect(m.name).toBe("laptop");
    expect(m.os).toBe("win32");
    expect(m.hostname).toBe("host-1");
    expect(m.queuePending).toBe(142);
    expect(m.queueInflight).toBe(3);
    expect(m.collectorVersion).toBe("0.9.0");
    // normalized to an ISO string (not a Date) so the wire shape matches MachineStatusRow
    expect(typeof m.lastHeartbeatAt).toBe("string");
    expect(m.lastHeartbeatAt).toBe(NOW.toISOString());
    // derivation over the persisted row: fresh heartbeat → online; high backlog flagged
    expect(deriveMachineStatus(m, NOW.getTime())).toBe("online");
    expect(isBacklogHigh(m.queuePending)).toBe(true);
  });

  it("machine with no heartbeat yet → null heartbeat columns, never crashes", async () => {
    const rows = await machineStatuses(dbh.db, userId);
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.lastHeartbeatAt).toBeNull();
    expect(m.queuePending).toBeNull();
    expect(m.queueInflight).toBeNull();
    expect(m.collectorVersion).toBeNull();
    expect(m.lastSeenAt).toBeNull();
    // no heartbeat AND no lastSeenAt → offline (D5 fallback, no crash)
    expect(deriveMachineStatus(m, NOW.getTime())).toBe("offline");
    expect(isBacklogHigh(m.queuePending)).toBe(false);
  });

  it("activeSessions includes a session inside the window, excludes it for a later since", async () => {
    await seedSession();

    // since = 15 min before the last event → included
    const within = await activeSessions(dbh.db, userId, "2026-06-14T11:45:00.000Z");
    expect(within).toHaveLength(1);
    const s = within[0]!;
    expect(s.sessionId).toBe(SESSION);
    expect(s.sourceConnector).toBe("claude-code");
    expect(s.eventCount).toBe(2);
    expect(s.models).toEqual(["claude-opus-4-8"]);
    expect(s.projectPath).toBe("/home/a/420ai");
    expect(s.gitBranch).toBe("main");
    expect(s.startedAt).toBe("2026-06-14T11:59:00.000Z");
    expect(s.lastEventAt).toBe(LAST_EVENT);

    // since = AFTER the last event → excluded
    const after = await activeSessions(dbh.db, userId, "2026-06-14T12:30:00.000Z");
    expect(after).toEqual([]);
  });

  it("activeSessions is scoped to the user (another user's events do not leak)", async () => {
    await seedSession();
    const [u2] = await dbh.db
      .insert(users)
      .values({ email: "other@example.com" })
      .returning({ id: users.id });
    const other = await activeSessions(dbh.db, u2!.id, "2026-06-14T11:45:00.000Z");
    expect(other).toEqual([]);
  });

  it("recordHeartbeat appends a machine_heartbeats sample AND updates the machine latest columns", async () => {
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 42,
      queueInflight: 1,
      collectorVersion: "0.9.0",
      now: NOW,
    });
    // The time-series sample was appended.
    const samples = await dbh.db
      .select({
        machineId: machineHeartbeats.machineId,
        ts: machineHeartbeats.ts,
        queuePending: machineHeartbeats.queuePending,
        queueInflight: machineHeartbeats.queueInflight,
      })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, machineId));
    expect(samples).toHaveLength(1);
    expect(samples[0]!.queuePending).toBe(42);
    expect(samples[0]!.queueInflight).toBe(1);
    expect(samples[0]!.ts.toISOString()).toBe(NOW.toISOString());
    // The machine latest columns are still updated (M9 read path unchanged).
    const rows = await machineStatuses(dbh.db, userId);
    expect(rows[0]!.queuePending).toBe(42);
    expect(rows[0]!.lastHeartbeatAt).toBe(NOW.toISOString());
  });

  it("recentBacklogSamples returns the machine's samples sorted asc, ISO ts, grouped, user-scoped, windowed", async () => {
    // Three samples at NOW-2min / NOW-1min / NOW (rising backlog).
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 10,
      queueInflight: 0,
      collectorVersion: "0.9.0",
      now: new Date(NOW.getTime() - 2 * 60_000),
    });
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 60,
      queueInflight: 0,
      collectorVersion: "0.9.0",
      now: new Date(NOW.getTime() - 60_000),
    });
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 110,
      queueInflight: 0,
      collectorVersion: "0.9.0",
      now: NOW,
    });

    const since = new Date(NOW.getTime() - 10 * 60_000);
    const byMachine = await recentBacklogSamples(dbh.db, userId, since);
    const list = byMachine.get(machineId)!;
    expect(list).toHaveLength(3);
    // Sorted ascending by ts; queuePending in insertion order.
    expect(list.map((s) => s.queuePending)).toEqual([10, 60, 110]);
    expect(typeof list[0]!.ts).toBe("string");
    expect(list[2]!.ts).toBe(NOW.toISOString());

    // A `since` after all samples excludes them.
    const empty = await recentBacklogSamples(dbh.db, userId, new Date(NOW.getTime() + 60_000));
    expect(empty.get(machineId)).toBeUndefined();

    // Another user's view does not leak this machine's samples.
    const [u2] = await dbh.db
      .insert(users)
      .values({ email: "other@example.com" })
      .returning({ id: users.id });
    const other = await recentBacklogSamples(dbh.db, u2!.id, since);
    expect(other.get(machineId)).toBeUndefined();
  });

  it("recordHeartbeat prunes samples older than the retention window", async () => {
    // Insert an OLD sample directly (well beyond the 24h retention window).
    const old = new Date(NOW.getTime() - 48 * 60 * 60_000);
    await dbh.db.insert(machineHeartbeats).values({
      machineId,
      ts: old,
      queuePending: 1,
      queueInflight: 0,
    });
    // A fresh heartbeat at NOW appends + prunes anything older than retention.
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 5,
      queueInflight: 0,
      collectorVersion: "0.9.0",
      now: NOW,
    });
    const remaining = await dbh.db
      .select({ ts: machineHeartbeats.ts })
      .from(machineHeartbeats)
      .where(and(eq(machineHeartbeats.machineId, machineId)));
    // Only the fresh sample survives; the 48h-old one is pruned.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.ts.toISOString()).toBe(NOW.toISOString());
  });
});
