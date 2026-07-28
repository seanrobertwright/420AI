import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "@420ai/db";
import { rollbackLast } from "./rollback.js";
import { provisionAppRole } from "./provision-app-role.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
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
    // M15 15.3: 0015's down SQL revokes the app role's privileges (`DROP OWNED BY`) without
    // dropping the role, and the re-migrate re-grants them — but NEITHER touches LOGIN or the
    // password, because the migration deliberately never handles a secret (it is committed to
    // git). Without re-provisioning, every later two-role RLS suite fails to authenticate.
    await restoreAppRole();
  });

  /** Re-grant LOGIN + the password to the app role after a 0015 down/up cycle. */
  async function restoreAppRole(): Promise<void> {
    if (APP_PASSWORD) await provisionAppRole(TEST_URL!, APP_PASSWORD);
  }

  async function policyCount(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_policies where schemaname = 'public'",
    );
    return Number(r.rows[0]!.n);
  }

  /**
   * Does the app role hold any privilege in THIS database? The down migration deliberately does
   * NOT drop the role (it is cluster-wide, but a migration is per-database — see the down SQL's
   * header), so "rolled back" means privilege-less, not absent.
   */
  async function appRoleHasPrivileges(): Promise<boolean> {
    const r = await pool.query<{ ok: boolean }>(
      "select has_table_privilege('420ai_app', 'events', 'SELECT') as ok",
    );
    return r.rows[0]!.ok;
  }

  /** Is RLS both ENABLED and FORCED on `events`? Two separate exemptions, two switches. */
  async function eventsRlsFlags(): Promise<{ enabled: boolean; forced: boolean }> {
    const r = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'events'",
    );
    return { enabled: r.rows[0]!.relrowsecurity, forced: r.rows[0]!.relforcerowsecurity };
  }

  async function trackedCount(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    return Number(r.rows[0]!.n);
  }

  /** Does `events` carry the M15 15.1 `org_id` column (added by 0014)? */
  async function orgIdColumnExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.columns where table_name = 'events' and column_name = 'org_id'",
    );
    return r.rowCount === 1;
  }

  /** The column list of `search_documents_entity` — 0014 re-scopes it by org (audit B.1). */
  async function searchEntityIndexColumns(): Promise<string> {
    const r = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'search_documents_entity'",
    );
    return r.rows[0]?.indexdef ?? "";
  }

  /** Does `project_grants` exist? 0016 creates it; its down drops it. */
  async function projectGrantsExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'project_grants'",
    );
    return r.rowCount === 1;
  }

  /** How many RESTRICTIVE policies exist (the 15.4 role-write backstop; 0 before 0016). */
  async function restrictivePolicyCount(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "select count(*) as n from pg_policies where schemaname = 'public' and permissive = 'RESTRICTIVE'",
    );
    return Number(r.rows[0]!.n);
  }

  it("rolls back the latest migration (0016 RBAC) and a re-migrate restores it", async () => {
    // M15 15.4 D-M15-13 drill, run in CI rather than by hand. The load-bearing assertion is NOT
    // that 0016 reverses cleanly — it is that reversing it leaves 15.3's TENANCY layer entirely
    // alone. 0016 never modified the 15 permissive policies (restrictive policies AND with them
    // rather than replacing them), so its down must not either.
    expect(await trackedCount()).toBe(17);
    expect(await policyCount()).toBe(55); // 15 org + 1 new org + 39 restrictive
    expect(await restrictivePolicyCount()).toBe(39);
    expect(await projectGrantsExists()).toBe(true);
    expect(await appRoleHasPrivileges()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });

    const result = await rollbackLast(TEST_URL!, { downDir, journalPath });
    expect(result).toEqual({ rolledBack: "0016_strong_magus" });
    expect(await trackedCount()).toBe(16);
    // Exactly 0015's 15 policies remain — the role backstop is gone, tenancy is untouched.
    expect(await policyCount()).toBe(15);
    expect(await restrictivePolicyCount()).toBe(0);
    expect(await projectGrantsExists()).toBe(false);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    expect(await appRoleHasPrivileges()).toBe(true);
    // …and 0014's tenancy schema likewise. Rolling back RBAC must not touch either the data
    // model the PRIMARY defence depends on, or the backstop below it.
    expect(await orgIdColumnExists()).toBe(true);
    expect(await searchEntityIndexColumns()).toContain("(org_id, entity_type, entity_id)");

    // Re-apply: an idempotent re-migrate brings 0016 back + restores the tracking row.
    await runMigrations(TEST_URL!);
    expect(await trackedCount()).toBe(17);
    expect(await policyCount()).toBe(55);
    expect(await restrictivePolicyCount()).toBe(39);
    expect(await projectGrantsExists()).toBe(true);
    expect(await appRoleHasPrivileges()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    await restoreAppRole();
  });
});
