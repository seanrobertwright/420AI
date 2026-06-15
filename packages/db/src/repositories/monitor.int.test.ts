import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { deriveMachineStatus, isBacklogHigh } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines, events } from "../schema.js";
import { recordHeartbeat } from "./machines.js";
import { machineStatuses, activeSessions } from "./monitor.js";

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
      sql`TRUNCATE workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
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
});
