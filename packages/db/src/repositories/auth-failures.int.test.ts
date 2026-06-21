import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../index.js";
import { recordIngestAuthFailure, countRecentAuthFailures } from "./auth-failures.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/** Fixed clock — failures recorded at explicit times for deterministic window/prune assertions. */
const base = new Date("2026-06-15T12:00:00.000Z");
const at = (msAgo: number): Date => new Date(base.getTime() - msAgo);

describe.skipIf(!TEST_URL)("auth-failures repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(sql`TRUNCATE ingest_auth_failures RESTART IDENTITY`);
  });

  it("counts only failures at/after `since` (windowed)", async () => {
    // Three within a 15-min window, one well outside it.
    await recordIngestAuthFailure(dbh.db, { remoteIp: "1.1.1.1", now: at(1 * 60_000) });
    await recordIngestAuthFailure(dbh.db, { remoteIp: "1.1.1.1", now: at(5 * 60_000) });
    await recordIngestAuthFailure(dbh.db, { remoteIp: "2.2.2.2", now: at(14 * 60_000) });
    await recordIngestAuthFailure(dbh.db, { remoteIp: "3.3.3.3", now: at(60 * 60_000) }); // 1h ago

    const since = new Date(base.getTime() - 15 * 60_000);
    expect(await countRecentAuthFailures(dbh.db, since)).toBe(3);

    // A tighter 2-min window catches only the most recent one.
    expect(await countRecentAuthFailures(dbh.db, new Date(base.getTime() - 2 * 60_000))).toBe(1);
  });

  it("prunes failures older than the 7-day retention on append", async () => {
    // Seed one 8-day-old row, then append a fresh one — the append prunes the stale row.
    await recordIngestAuthFailure(dbh.db, { now: at(8 * 24 * 60 * 60_000) });
    await recordIngestAuthFailure(dbh.db, { now: base });
    // Count from the epoch: only the fresh row survives the prune.
    expect(await countRecentAuthFailures(dbh.db, new Date(0))).toBe(1);
  });

  it("records a null remote_ip when none is given (no throw)", async () => {
    await recordIngestAuthFailure(dbh.db);
    expect(await countRecentAuthFailures(dbh.db, new Date(0))).toBe(1);
  });
});
