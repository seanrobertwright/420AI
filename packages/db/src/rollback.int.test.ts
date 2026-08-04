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

  /** Do the M15 15.5 identity tables exist? 0017 creates them; its down drops them. */
  async function identityTablesExist(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_name in ('invites', 'password_reset_tokens')`,
    );
    return Number(r.rows[0]!.n);
  }

  /** Are every `users.email` already lowercase? 0017 normalizes them and its down does NOT undo it. */
  async function mixedCaseEmailCount(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from users where email <> lower(email)`,
    );
    return Number(r.rows[0]!.n);
  }

  /** Does the M15 15.6 `sessions` table exist? 0018 creates it; its down drops it. */
  async function sessionsTableExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'sessions'",
    );
    return r.rowCount === 1;
  }

  /** Does the M15 15.7 `sso_identities` table exist? 0019 creates it; its down drops it. */
  async function ssoIdentitiesTableExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'sso_identities'",
    );
    return r.rowCount === 1;
  }

  /** Does 0022's per-user live-name unique index exist? Its down drops it; 0021 is untouched. */
  async function apiKeyNameIndexExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from pg_indexes where schemaname = 'public' and indexname = 'api_keys_user_live_name'",
    );
    return r.rowCount === 1;
  }

  /** Does the M15 15.10 `audit_events` table exist? 0023 creates it; its down DROPS it. */
  async function auditEventsTableExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'audit_events'",
    );
    return r.rowCount === 1;
  }

  /**
   * The `audit_events` APPEND-ONLY policy (M15 15.10, D-15.10-2). Counted on its own rather than
   * folded into `policyCount()` because its SHAPE is the decision: exactly one, PERMISSIVE, INSERT.
   */
  async function auditPolicyCmds(): Promise<string[]> {
    const r = await pool.query<{ cmd: string }>(
      "select cmd from pg_policies where tablename = 'audit_events' order by cmd",
    );
    return r.rows.map((x) => x.cmd);
  }

  /** Does the M15 15.9 `api_keys` table exist? 0021 creates it; its down drops it. */
  async function apiKeysTableExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'api_keys'",
    );
    return r.rowCount === 1;
  }

  /** How many of the M15 15.8 MFA tables exist? 0020 creates both; its down drops both. */
  async function mfaTablesExist(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_name in ('totp_credentials', 'mfa_recovery_codes')`,
    );
    return Number(r.rows[0]!.n);
  }

  /** How many of the M16 16.1 label tables exist? 0024 creates both; its down drops both. */
  async function outcomeLabelTablesExist(): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_name in ('outcome_labels', 'outcome_label_revisions')`,
    );
    return Number(r.rows[0]!.n);
  }

  /**
   * The M16 16.1 label policies, by (table, permissive, cmd). Counted by SHAPE rather than folded
   * into `policyCount()` because the shape is the decision: per table one PERMISSIVE/ALL org policy
   * plus three RESTRICTIVE write policies — the ordinary 0015/0016 STRICT pattern, deliberately NOT
   * 0023's append-only shape.
   */
  async function outcomeLabelPolicyShape(): Promise<string[]> {
    const r = await pool.query<{ s: string }>(
      `select tablename || ':' || permissive || ':' || cmd as s from pg_policies
       where tablename like 'outcome_label%' order by s`,
    );
    return r.rows.map((x) => x.s);
  }

  it("rolls back the latest migration (0024 outcome labels) and a re-migrate restores it", async () => {
    // M15 D-M15-13 drill, run in CI rather than by hand. `rollbackLast` reverses THE LATEST
    // migration, so this test retargets with every slice that adds one — 15.5's version named 0017,
    // 15.6's named 0018, 15.7's named 0019 and 15.8's named 0020. The assertions those made survive
    // here as UNTOUCHED-BY-0021 invariants below, which is the whole value of retargeting rather
    // than rewriting: the drill gets stricter with every slice instead of just moving.
    //
    // The load-bearing assertion for 15.9 was the POLICY COUNT NOT MOVING: 0021/0022 were the
    // fourth and fifth migrations in a row that touch `api_keys` and add NO policy (D-15.9-1 — it
    // is an identity table read inside `resolvePrincipal` before any org context exists), so "59
    // before, 59 after" pinned that absence as a decision. That invariant survives here: `api_keys`
    // still has no policy, and the ONLY new one below belongs to `audit_events`. If a future reader
    // adds a policy to `api_keys`, this drill still fails before `rls.int.test.ts` even runs — and
    // the production symptom would be every API key silently 401ing.
    //
    // 0022 is INDEX-ONLY, so unlike 0021 its rollback is lossless: `api_keys` and every row in it
    // survive. That asymmetry survives here as an untouched-by-0023 invariant.
    //
    // M15 15.10 retargeted the drill to 0023, the first retarget where the policy count moved — by
    // exactly one, the single append-only `PERMISSIVE / INSERT / WITH CHECK (true)` policy
    // (D-15.10-2). That assertion survives below as an untouched-by-0024 invariant.
    //
    // M16 16.1 RETARGETS THE DRILL TO 0024, and the interesting number is again the policy count —
    // this time **+8**, and the split between them is the decision worth pinning: two PERMISSIVE org
    // policies and SIX RESTRICTIVE write policies, i.e. the ordinary 0015/0016 STRICT pattern
    // applied twice, NOT 0023's append-only shape. `outcome_label_revisions` is the one that could
    // plausibly have gone the other way — it IS an immutable history — and it takes STRICT because
    // it has a real per-tenant read path and its rows must be deletable with their label (D-16.1-6).
    // So the numbers are 68 → 60 → 68, and RESTRICTIVE moves 48 → 42 → 48 for the first time since
    // 0016. If a future reader converts either table to append-only, this drill fails here first.
    expect(await trackedCount()).toBe(25);
    expect(await policyCount()).toBe(68); // 60 through 0023 + 2 org + 6 restrictive from 0024
    expect(await restrictivePolicyCount()).toBe(48); // 42 through 0023 + 3 per label table
    expect(await outcomeLabelTablesExist()).toBe(2);
    expect(await outcomeLabelPolicyShape()).toEqual([
      "outcome_label_revisions:PERMISSIVE:ALL",
      "outcome_label_revisions:RESTRICTIVE:DELETE",
      "outcome_label_revisions:RESTRICTIVE:INSERT",
      "outcome_label_revisions:RESTRICTIVE:UPDATE",
      "outcome_labels:PERMISSIVE:ALL",
      "outcome_labels:RESTRICTIVE:DELETE",
      "outcome_labels:RESTRICTIVE:INSERT",
      "outcome_labels:RESTRICTIVE:UPDATE",
    ]);
    expect(await auditEventsTableExists()).toBe(true);
    expect(await auditPolicyCmds()).toEqual(["INSERT"]);
    expect(await apiKeysTableExists()).toBe(true);
    expect(await apiKeyNameIndexExists()).toBe(true);
    expect(await mfaTablesExist()).toBe(2);
    expect(await ssoIdentitiesTableExists()).toBe(true);
    expect(await sessionsTableExists()).toBe(true);
    expect(await identityTablesExist()).toBe(2);
    expect(await projectGrantsExists()).toBe(true);
    expect(await appRoleHasPrivileges()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    expect(await mixedCaseEmailCount()).toBe(0);

    const result = await rollbackLast(TEST_URL!, { downDir, journalPath });
    expect(result).toEqual({ rolledBack: "0024_lowly_logan" });
    expect(await trackedCount()).toBe(24);
    // BOTH TABLES ARE GONE, AND WITH THEM EVERY HUMAN OUTCOME LABEL AND ITS EDIT HISTORY —
    // irrecoverably, on the same terms as `audit_events` below and for the same reason. Almost every
    // other destructive down in this repo drops a PROJECTION (`events` re-derive from
    // `raw_source_records`); a label is derived from NOTHING and is re-creatable only by the human
    // who gave it, so rolling forward again produces EMPTY tables rather than the old ones. All
    // eight policies drop with their tables, which is why the counts return to 60/42 and there is no
    // policy-ordering hazard in the down file.
    expect(await outcomeLabelTablesExist()).toBe(0);
    expect(await outcomeLabelPolicyShape()).toEqual([]);
    expect(await policyCount()).toBe(60);
    expect(await restrictivePolicyCount()).toBe(42);
    // 0023's audit table is UNTOUCHED — 0024 names it nowhere, so rolling back the labels does not
    // cost the audit history as well.
    expect(await auditEventsTableExists()).toBe(true);
    expect(await auditPolicyCmds()).toEqual(["INSERT"]);
    // 0022's index and 0021's table are likewise untouched, so no credential stops working when
    // only the label tables are rolled back.
    expect(await apiKeyNameIndexExists()).toBe(true);
    expect(await apiKeysTableExists()).toBe(true);
    // 15.8's MFA tables, 15.7's identities, 15.6's sessions, 15.5's identity core, 15.4's table and
    // 15.3's flags are all untouched.
    expect(await mfaTablesExist()).toBe(2);
    expect(await ssoIdentitiesTableExists()).toBe(true);
    expect(await sessionsTableExists()).toBe(true);
    expect(await identityTablesExist()).toBe(2);
    expect(await projectGrantsExists()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    expect(await appRoleHasPrivileges()).toBe(true);
    // …and 0014's tenancy schema likewise.
    expect(await orgIdColumnExists()).toBe(true);
    expect(await searchEntityIndexColumns()).toContain("(org_id, entity_type, entity_id)");
    // Emails stay lowercased across the rollback (0017's down deliberately does not undo it).
    expect(await mixedCaseEmailCount()).toBe(0);

    // Re-apply: an idempotent re-migrate brings 0024 back + restores the tracking row. The tables
    // return EMPTY — asserted, because "the rollback round-trips" must not be read as "the labels
    // came back". Note also that the hand-appended policy block survives the round trip, which is
    // what proves the migration FILE (not `db:generate`) is the source of truth for it — the same
    // property 0023 established, now checked for a second hand-edited migration.
    await runMigrations(TEST_URL!);
    expect(await trackedCount()).toBe(25);
    expect(await outcomeLabelTablesExist()).toBe(2);
    expect(await outcomeLabelPolicyShape()).toEqual([
      "outcome_label_revisions:PERMISSIVE:ALL",
      "outcome_label_revisions:RESTRICTIVE:DELETE",
      "outcome_label_revisions:RESTRICTIVE:INSERT",
      "outcome_label_revisions:RESTRICTIVE:UPDATE",
      "outcome_labels:PERMISSIVE:ALL",
      "outcome_labels:RESTRICTIVE:DELETE",
      "outcome_labels:RESTRICTIVE:INSERT",
      "outcome_labels:RESTRICTIVE:UPDATE",
    ]);
    expect((await pool.query("select count(*)::int as n from outcome_labels")).rows[0].n).toBe(0);
    expect(await auditEventsTableExists()).toBe(true);
    expect(await auditPolicyCmds()).toEqual(["INSERT"]);
    expect((await pool.query("select count(*)::int as n from audit_events")).rows[0].n).toBe(0);
    expect(await apiKeyNameIndexExists()).toBe(true);
    expect(await apiKeysTableExists()).toBe(true);
    expect(await mfaTablesExist()).toBe(2);
    expect(await ssoIdentitiesTableExists()).toBe(true);
    expect(await sessionsTableExists()).toBe(true);
    expect(await policyCount()).toBe(68);
    expect(await restrictivePolicyCount()).toBe(48);
    expect(await identityTablesExist()).toBe(2);
    expect(await projectGrantsExists()).toBe(true);
    expect(await appRoleHasPrivileges()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    await restoreAppRole();
  });
});
