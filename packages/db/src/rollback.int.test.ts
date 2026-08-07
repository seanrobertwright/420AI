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

  /** Does the M16 16.3 `machine_connectors` table exist? 0025 creates it; its down drops it. */
  async function machineConnectorsTableExists(): Promise<boolean> {
    const r = await pool.query(
      "select 1 from information_schema.tables where table_name = 'machine_connectors'",
    );
    return r.rowCount === 1;
  }

  /** The M16 16.3 policies by (permissive, cmd) — the ordinary STRICT shape, 1 org + 3 write. */
  async function machineConnectorPolicyShape(): Promise<string[]> {
    const r = await pool.query<{ s: string }>(
      `select permissive || ':' || cmd as s from pg_policies
       where tablename = 'machine_connectors' order by s`,
    );
    return r.rows.map((x) => x.s);
  }

  /** Is the M16 16.5 `rawRecordTotals` covering index present? 0026 creates it; its down drops it. */
  async function rawRecordIndexExists(): Promise<boolean> {
    const r = await pool.query(
      `select 1 from pg_indexes where schemaname = 'public' and tablename = 'events'
         and indexdef like '%(org_id, source_connector, raw_record_id)%'`,
    );
    return r.rowCount === 1;
  }

  /** The `alert_firings` indexes, sorted — the 16.7 shape lives here. */
  async function alertFiringIndexes(): Promise<string[]> {
    const r = await pool.query(
      `select indexname from pg_indexes where schemaname = 'public'
         and tablename = 'alert_firings' order by indexname`,
    );
    return (r.rows as { indexname: string }[]).map((x) => x.indexname);
  }

  /** Whether `alert_firings.org_id` is nullable — the property 0027 exists to create. */
  async function alertFiringsOrgIdNullable(): Promise<boolean> {
    const r = await pool.query(
      `select is_nullable from information_schema.columns
         where table_name = 'alert_firings' and column_name = 'org_id'`,
    );
    return (r.rows[0] as { is_nullable: string }).is_nullable === "YES";
  }

  /** Whether the org policy admits the deployment scope (`OR org_id IS NULL`). */
  async function alertFiringsPolicyAdmitsDeployment(): Promise<boolean> {
    const r = await pool.query(
      `select qual from pg_policies where tablename = 'alert_firings'
         and policyname = 'alert_firings_org_isolation'`,
    );
    const qual = (r.rows[0] as { qual: string } | undefined)?.qual ?? "";
    return /org_id IS NULL/i.test(qual);
  }

  it("rolls back the latest migration (0027 deployment-scoped alert firings) and a re-migrate restores it", async () => {
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
    // So the numbers were 68 → 60 → 68, and RESTRICTIVE moved 48 → 42 → 48 for the first time since
    // 0016. If a future reader converts either table to append-only, this drill fails here first.
    // That whole assertion survives below as an UNTOUCHED-BY-0025 invariant.
    //
    // M16 16.3 RETARGETS THE DRILL TO 0025, and this one is deliberately UNDRAMATIC in the place the
    // last few were dramatic. The policy count moves +4 (one PERMISSIVE org policy + three
    // RESTRICTIVE write policies — the ordinary 0015/0016 STRICT pattern, once), and the DATA LOSS is
    // genuinely mild for the first time in several slices: `machine_connectors` is a projection of a
    // LIVE signal, re-reported in full by every collector on its next heartbeat (≤30 s), so the rows
    // rebuild themselves. Asserting that plainly matters as much as the loud warnings above do — a
    // drill whose every table is irreplaceable teaches the reader to skip the distinction.
    //
    // M16 16.5 RETARGETS THE DRILL TO 0026, and it is the mildest retarget the file has ever had:
    // ONE `CREATE INDEX`, no table, no column, no policy. The policy counts therefore do NOT move
    // (72/51 before and after), which makes 0026 the second INDEX-ONLY migration after 0022 and the
    // second whose rollback is genuinely LOSSLESS — an index holds no rows, so nothing needs
    // rebuilding and no dump is required. 0022's "index-only ⇒ lossless" asymmetry survives here as
    // an untouched-by-0026 invariant, now checked for a second such migration.
    //
    // WHAT MAKES 0026 WORTH DRILLING IS THE OPPOSITE OF EVERY ENTRY ABOVE. Those roll back LOUDLY:
    // a dropped table 500s, a dropped policy denies, a dropped column fails to parse. Dropping this
    // index changes NO answer anywhere — every query still returns exactly the same rows. What it
    // changes is whether `POST /v1/audit/data-quality` ever RETURNS: without it `rawRecordTotals`
    // degrades to one seq scan of `events` per raw record (measured on the real archive at plan cost
    // 446,378,008, no result in seven minutes), so the endpoint hangs, writes nothing, logs nothing,
    // and the operator sees a spinner. A rollback of 0026 is therefore SILENT in production, which
    // is precisely why it is pinned here — this drill is the only place that can notice.
    //
    // M16 16.7 RETARGETS THE DRILL TO 0027, and it is the first retarget whose down-migration
    // ORDER is the hazard rather than its content. `alert_firings.org_id` becomes NULLABLE, and
    // `ALTER COLUMN … SET NOT NULL` FAILS while any NULL row exists — at the END of the down
    // script, after the indexes have already been swapped. So the deployment rows must be disposed
    // of FIRST. Nothing in `tsc` or in any other suite can notice a mis-ordered down script; this
    // drill is the only place that runs one.
    //
    // The POLICY COUNT DOES NOT MOVE (72/51 both ways) even though 0027 does touch a policy, and
    // that is the interesting number: 0027 DROPs and re-CREATEs `alert_firings_org_isolation`
    // rather than adding one, so the count is unchanged while the QUAL is not. A count-only
    // assertion would therefore have passed against a migration that never ran — hence
    // `alertFiringsPolicyAdmitsDeployment()` beside it, which reads the qual.
    //
    // The DATA LOSS is real, deliberate and bounded: rolling back deletes the open deployment-
    // scoped firings, because the pre-16.7 schema has no honest place to put them (`org_id` is NOT
    // NULL there, and re-homing them onto an arbitrary org recreates the very defect 0027 removed).
    // `alert_firings` is a re-derivable projection of a projection, so the next reconcile re-opens
    // the condition within one tick; what is lost is the `first_fired_at` of at most two rows.
    expect(await trackedCount()).toBe(28);
    expect(await policyCount()).toBe(72); // UNMOVED by 0027 — it REPLACES a policy, not adds one
    expect(await restrictivePolicyCount()).toBe(51); // likewise unmoved (the role policies stay)
    expect(await alertFiringsOrgIdNullable()).toBe(true);
    expect(await alertFiringsPolicyAdmitsDeployment()).toBe(true);
    expect(await alertFiringIndexes()).toEqual([
      "alert_firings_by_org",
      "alert_firings_by_org_status",
      "alert_firings_open_global_key",
      "alert_firings_open_key",
      "alert_firings_pkey",
    ]);
    expect(await rawRecordIndexExists()).toBe(true);
    expect(await machineConnectorsTableExists()).toBe(true);
    expect(await machineConnectorPolicyShape()).toEqual([
      "PERMISSIVE:ALL",
      "RESTRICTIVE:DELETE",
      "RESTRICTIVE:INSERT",
      "RESTRICTIVE:UPDATE",
    ]);
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
    expect(result).toEqual({ rolledBack: "0027_strange_white_queen" });
    expect(await trackedCount()).toBe(27);
    // THE DEPLOYMENT SCOPE IS GONE, and the schema is genuinely back to its pre-16.7 shape. The
    // ORDER assertion is implicit but total: if the down script had restored the indexes or the
    // policy before disposing of the NULL-org rows, `SET NOT NULL` would have raised
    // `column "org_id" ... contains null values` and `rollbackLast` above would have thrown.
    expect(await alertFiringsOrgIdNullable()).toBe(false);
    expect(await alertFiringsPolicyAdmitsDeployment()).toBe(false); // strict again
    expect(await alertFiringIndexes()).toEqual([
      "alert_firings_by_org",
      "alert_firings_by_user_status",
      "alert_firings_open_key",
      "alert_firings_pkey",
    ]);
    // The policy was REPLACED, not dropped — so the counts are the same on both sides of the
    // rollback while the behaviour is not. This is why the qual assertion above exists.
    expect(await policyCount()).toBe(72);
    expect(await restrictivePolicyCount()).toBe(51);
    // 0026's index is UNTOUCHED — 0027 names `events` nowhere.
    expect(await rawRecordIndexExists()).toBe(true);
    // 0025's table and all four of its policies are UNTOUCHED — 0026 names them nowhere — so the
    // counts that moved for 0025 stay put. An index-only migration must not disturb them.
    expect(await machineConnectorsTableExists()).toBe(true);
    expect(await machineConnectorPolicyShape()).toEqual([
      "PERMISSIVE:ALL",
      "RESTRICTIVE:DELETE",
      "RESTRICTIVE:INSERT",
      "RESTRICTIVE:UPDATE",
    ]);
    expect(await policyCount()).toBe(72);
    expect(await restrictivePolicyCount()).toBe(51);
    // 0024's label tables are UNTOUCHED — 0026 names them nowhere, so rolling back the audit index
    // does not cost the human ground truth. This is the assertion 16.1 made as its headline; it
    // survives here as an untouched-by-0026 invariant.
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
    // 0023's audit table is likewise UNTOUCHED.
    expect(await auditEventsTableExists()).toBe(true);
    expect(await auditPolicyCmds()).toEqual(["INSERT"]);
    // 0022's index and 0021's table are likewise untouched, so no credential stops working when
    // only capture health is rolled back.
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

    // Re-apply: an idempotent re-migrate brings 0025 back + restores the tracking row. The table
    // returns EMPTY — asserted, because "the rollback round-trips" must not be read as "the rows
    // came back". For THIS table that distinction is unusually benign (a heartbeat refills it), but
    // the assertion is the same one, and asserting it uniformly is what keeps the drill honest.
    // Note also that the hand-appended policy block survives the round trip, which is what proves
    // the migration FILE (not `db:generate`) is the source of truth for it — the property 0023
    // established and 0024 confirmed, now checked for a THIRD hand-edited migration.
    await runMigrations(TEST_URL!);
    expect(await trackedCount()).toBe(28);
    // 0027 comes back, WHOLE — the nullable column, BOTH partial unique indexes, the re-keyed
    // status index and the amended policy. This is the forward half of the D-M15-13 drill and the
    // acceptance criterion the 16.7 plan calls "run it, forward and back, with matching schema":
    // the index list and the policy qual here are byte-identical to the pre-rollback assertions
    // above.
    //
    // …but the deployment-scoped ROWS do not come back, which the down script deleted on purpose.
    // For this table that is benign (the next reconcile re-opens the condition within a tick), and
    // it is asserted rather than assumed for the same reason every other re-apply in this file
    // asserts emptiness: "the rollback round-trips" must never be read as "the rows came back".
    expect(await alertFiringsOrgIdNullable()).toBe(true);
    expect(await alertFiringsPolicyAdmitsDeployment()).toBe(true);
    expect(await alertFiringIndexes()).toEqual([
      "alert_firings_by_org",
      "alert_firings_by_org_status",
      "alert_firings_open_global_key",
      "alert_firings_open_key",
      "alert_firings_pkey",
    ]);
    expect(
      (await pool.query("select count(*)::int as n from alert_firings where org_id is null"))
        .rows[0].n,
    ).toBe(0);
    expect(await rawRecordIndexExists()).toBe(true);
    expect(await machineConnectorsTableExists()).toBe(true);
    expect(await machineConnectorPolicyShape()).toEqual([
      "PERMISSIVE:ALL",
      "RESTRICTIVE:DELETE",
      "RESTRICTIVE:INSERT",
      "RESTRICTIVE:UPDATE",
    ]);
    expect((await pool.query("select count(*)::int as n from machine_connectors")).rows[0].n).toBe(
      0,
    );
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
    expect(await policyCount()).toBe(72);
    expect(await restrictivePolicyCount()).toBe(51);
    expect(await identityTablesExist()).toBe(2);
    expect(await projectGrantsExists()).toBe(true);
    expect(await appRoleHasPrivileges()).toBe(true);
    expect(await eventsRlsFlags()).toEqual({ enabled: true, forced: true });
    await restoreAppRole();
  });
});
