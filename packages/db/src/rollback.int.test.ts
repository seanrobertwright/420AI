import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "@420ai/db";
import { rollbackLast } from "./rollback.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const downDir = fileURLToPath(new URL("../drizzle/down", import.meta.url));
const journalPath = fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url));

// Schema-mutating: safe because vitest runs files sequentially (fileParallelism:false) and we
// re-migrate in afterAll so any later file sees the full schema.
describe.skipIf(!TEST_URL)("migration rollback (rollbackLast, integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    // Ensure full schema in case a prior run left the DB rolled back.
    await runMigrations(TEST_URL!);
    pool = new Pool({ connectionString: TEST_URL! });
  });

  afterAll(async () => {
    await pool.end();
    // Leave the DB fully-migrated for any file that runs after this one.
    await runMigrations(TEST_URL!);
  });

  async function trackedCount(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    return Number(r.rows[0]!.n);
  }

  async function passwordHashExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.columns where table_name = 'users' and column_name = 'password_hash'",
    );
    return r.rowCount === 1;
  }

  it("rolls back the latest migration (0009) and a re-migrate restores it", async () => {
    expect(await trackedCount()).toBe(10);
    expect(await passwordHashExists()).toBe(true);

    const result = await rollbackLast(TEST_URL!, { downDir, journalPath });
    expect(result).toEqual({ rolledBack: "0009_exotic_ben_grimm" });
    expect(await trackedCount()).toBe(9);
    expect(await passwordHashExists()).toBe(false); // down SQL dropped the column

    // Re-apply: an idempotent re-migrate brings 0009 back + restores the tracking row.
    await runMigrations(TEST_URL!);
    expect(await trackedCount()).toBe(10);
    expect(await passwordHashExists()).toBe(true);
  });
});
