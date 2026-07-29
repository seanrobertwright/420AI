import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { IngestBatch } from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import { events, machines, reportArtifacts, searchDocuments, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { issueIngestToken } from "./tokens.js";
import { findMachineIdByToken } from "./tokens.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M15 15.3 — THE MILESTONE'S PROOF. A TWO-ROLE suite.
 *
 * Every other `*.int.test.ts` in this repo connects as the OWNER, which has `rolbypassrls`.
 * Against that role RLS is INERT, so an owner-only suite would report green while enforcing
 * absolutely nothing (15.0 Finding 1). This file is the only place the policies are actually
 * exercised, and it needs BOTH handles:
 *
 *   - `owner` (DATABASE_URL_TEST)     — setup only: TRUNCATE (which requires table ownership)
 *                                       and seeding. Never used for an assertion.
 *   - `appRole` (DATABASE_URL_TEST_APP) — EVERY assertion. Non-owner, no bypass.
 *
 * Test 1 (role identity) is the reason the other tests mean anything: if the "app" handle were
 * accidentally pointed at the owner URL, every isolation test below would still pass — while
 * proving nothing. `repo-health --require-db` asserts the integration tests RAN; only this
 * assertion proves they ran as a NON-BYPASSING role.
 */

/** The SAME fingerprints regardless of which machine uploads them (PRD §12). */
function convergingBatch(machineTag: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId: "rls-s1",
        sourceRecordId: `raw-${machineTag}`,
        payload: JSON.stringify({ from: machineTag }),
      },
    ],
    events: [
      {
        fingerprint: "rls-fp-1",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: `raw-${machineTag}`,
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "rls-s1",
        ts: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Flatten an error and its `cause` chain into one searchable string.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose `message` is the SQL text
 * ("Failed query: insert into …") and hangs the real Postgres error off `.cause`. So a plain
 * `.rejects.toThrow(/row-level security policy/)` FAILS even when the policy fired exactly as
 * intended — it matches against the wrapper. Asserting the specific Postgres error (rather
 * than merely "it threw") is the whole point of these negative tests: a NOT NULL or FK
 * violation would also throw, and would mean the policy never ran.
 */
function errorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 10; depth++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** Assert a promise rejects with a Postgres row-level-security violation, at any cause depth. */
async function expectRlsRejection(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected an RLS rejection, but the statement SUCCEEDED").toBeDefined();
  expect(errorChain(thrown)).toMatch(/row-level security policy/i);
}

/**
 * M15 15.4 — the role this file's `withOrg` calls run under. Every assertion here is about
 * TENANCY, not roles, so it uses a non-viewer role throughout: the 0016 restrictive policies
 * must be invisible to these tests. `rbac.int.test.ts` is where the viewer path is proven.
 */
const WRITE_ROLE = "member";

/** STRICT policy: unset context ⇒ 0 rows. These hold tenant content. */
const STRICT_TABLES = [
  "raw_source_records",
  "events",
  "projects",
  "workspaces",
  "workspace_keys",
  "report_artifacts",
  "git_commits",
  "git_commit_files",
  "session_git_links",
  "machine_heartbeats",
  "alert_firings",
  "search_documents",
  // M15 15.4: a new tenant table with the same strict org policy as the other twelve.
  "project_grants",
] as const;

/** BOOTSTRAP-PERMISSIVE policy (D-15.3-3): enforced with a context, open without one. */
const BOOTSTRAP_TABLES = ["machines", "ingest_tokens", "pairing_codes"] as const;

/**
 * M15 15.5 (D-15.5-2) — a THIRD classification, and it exists because `invites` is the first table
 * in the repo that needs both halves at once:
 *
 *   - BOOTSTRAP-PERMISSIVE on the ORG axis, exactly like `pairing_codes`: accepting an invite reads
 *     the row IN ORDER TO discover the org, so a strict policy reads zero rows under the app role.
 *   - RESTRICTIVE on the ROLE axis, unlike all three bootstrap tables: those are written by machine
 *     paths with no membership role, whereas an invite is written by a principal and GRANTS
 *     PRIVILEGE. A viewer minting `role: 'owner'` is precisely the escalation the 15.4 backstop is
 *     for.
 *
 * Postgres makes the combination sound rather than contradictory: RESTRICTIVE policies combine with
 * AND, PERMISSIVE ones with OR, so the two layer instead of fighting. The classification is its own
 * constant rather than being forced into one of the existing two, because the inventory test below
 * asserts a DIFFERENT expectation for each axis.
 */
const ROLE_GATED_BOOTSTRAP_TABLES = ["invites"] as const;

/** No policy at all: identity tables (D-15.3-4) + deployment-global tables (D-M15-9). */
const NO_RLS_TABLES = [
  "users",
  "organizations",
  "memberships",
  // M15 15.5 (D-15.5-1): keyed by `user_id`, no `org_id`. Read at the one moment before any
  // identity — and therefore any org context — is established, exactly like the three above.
  "password_reset_tokens",
  // M15 15.6 (D-15.6-3): keyed by `user_id`, no `org_id`. Read INSIDE `resolvePrincipal` — the one
  // moment before any org context exists, because resolving this row is part of what establishes
  // it. Adding it here changes no derived policy COUNT (this list's expectation is "carries no
  // policy at all"), which is exactly the assertion 0018's missing policy block needs.
  "sessions",
  "pricing_catalogs",
  "connector_catalogs",
  "ingest_auth_failures",
] as const;

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.3 RLS enforcement (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let machineA: string;
  let machineB: string;
  let tokenB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // TRUNCATE requires table OWNERSHIP — on the app handle this fails with a permissions
    // error, not an RLS error, which is a confusing way to discover the rule. Owner only.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const [mA] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await owner.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });
    machineA = mA!.id;
    machineB = mB!.id;
    tokenB = (await issueIngestToken(owner.db, machineB)).token;
  });

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");

    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);

    // And it is genuinely a different role from the one that owns the tables.
    const who = await appRole.db.execute<{ u: string }>(sql`select current_user as u`);
    expect(who.rows[0]!.u).toBe("420ai_app");
  });

  // 2 ── FAILS CLOSED. An unset context is 0 rows — not an error, not data.
  it("with NO org context every strict table reads 0 rows (and does not error)", async () => {
    await ingestBatch(owner.db, machineA, convergingBatch("a"));
    // The owner sees the seeded row…
    const ownerCount = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from events`,
    );
    expect(ownerCount.rows[0]!.n).toBeGreaterThan(0);

    for (const table of STRICT_TABLES) {
      const r = await appRole.db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)}`,
      );
      // 0, NOT an `invalid input syntax for type uuid` 500 — that is what the policy's
      // `nullif(current_setting(...), '')` guard buys. A backstop must fail closed and QUIET.
      expect(r.rows[0]!.n, `${table} must read 0 rows with no context`).toBe(0);
    }
  });

  // 3 ── CROSS-TENANT READ. Org A's context sees org A only.
  it("an org-A context sees org A's rows and NONE of org B's", async () => {
    await ingestBatch(owner.db, machineA, convergingBatch("a"));
    await owner.db.insert(events).values({
      orgId: orgB,
      fingerprint: "rls-b-only",
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "raw-b",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "rls-s-b",
      // `ts` is a mode:"string" column — pass ISO verbatim, never a Date (CLAUDE.md).
      ts: "2026-07-01T00:00:00.000Z",
      machineId: machineB,
    });
    await owner.db.insert(reportArtifacts).values([
      {
        orgId: orgA,
        userId: userA,
        reportType: "project.cost_over_time",
        scopeKind: "project",
        scopeId: "s-a",
        version: 1,
        metrics: {},
        params: {},
        reportVersion: "1",
        markdown: "a",
      },
      {
        orgId: orgB,
        userId: userB,
        reportType: "project.cost_over_time",
        scopeKind: "project",
        scopeId: "s-b",
        version: 1,
        metrics: {},
        params: {},
        reportVersion: "1",
        markdown: "b",
      },
    ]);
    await owner.db.insert(searchDocuments).values([
      {
        orgId: orgA,
        userId: userA,
        entityType: "session",
        entityId: "shared-session",
        title: "A",
        body: "org a body",
        redactionVersion: "1",
      },
      {
        orgId: orgB,
        userId: userB,
        entityType: "session",
        entityId: "shared-session",
        title: "B",
        body: "org b body",
        redactionVersion: "1",
      },
    ]);

    const seen = await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => ({
      events: await tx.execute<{ n: number }>(sql`select count(*)::int as n from events`),
      reports: await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from report_artifacts`,
      ),
      // The audit-B.1 shape: both orgs hold the SAME (entity_type, entity_id). Org A must see
      // exactly its own document — never a merged row, never org B's decrypted body.
      docs: await tx.execute<{ n: number; body: string }>(
        sql`select count(*)::int as n, min(body) as body from search_documents`,
      ),
    }));
    expect(seen.events.rows[0]!.n).toBe(1);
    expect(seen.reports.rows[0]!.n).toBe(1);
    expect(seen.docs.rows[0]!.n).toBe(1);
    expect(seen.docs.rows[0]!.body).toBe("org a body");

    // …and symmetrically for org B.
    const bSees = await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      tx.execute<{ n: number; body: string }>(
        sql`select count(*)::int as n, min(body) as body from search_documents`,
      ),
    );
    expect(bSees.rows[0]!.n).toBe(1);
    expect(bSees.rows[0]!.body).toBe("org b body");
  });

  // 4 ── CONTAINMENT. The 15.0 Finding-3 leak, pinned. A plain `SET` would survive the
  //      connection's return to the pool and hand the next request the previous org.
  it("the org context does not survive COMMIT, a THROW, or reuse of the pooled connection", async () => {
    await ingestBatch(owner.db, machineA, convergingBatch("a"));

    // (a) after a COMMITted withOrg
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      const inside = await tx.execute<{ n: number }>(sql`select count(*)::int as n from events`);
      expect(inside.rows[0]!.n).toBe(1);
    });
    const afterCommit = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from events`,
    );
    expect(afterCommit.rows[0]!.n).toBe(0);

    // (b) after a THROWN callback (drizzle rolls back; the setting must go with it)
    await expect(
      withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const afterThrow = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from events`,
    );
    expect(afterThrow.rows[0]!.n).toBe(0);

    // (c) a subsequent transaction that never calls set_config sees nothing either.
    const bare = await appRole.db.transaction((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from events`),
    );
    expect(bare.rows[0]!.n).toBe(0);
  });

  // 5 ── CROSS-TENANT WRITE. A USING-only policy is applied as the WITH CHECK too.
  it("inserting a row owned by ANOTHER org is rejected by the database", async () => {
    // Assert the ERROR, not merely that it threw — a not-null or FK violation would also
    // "throw" and would mean the policy never ran. Hence `expectRlsRejection`.
    await expectRlsRejection(
      withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        tx.insert(events).values({
          orgId: orgB, // ← org A's context, org B's row
          fingerprint: "rls-cross-write",
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: "raw-x",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: "rls-x",
          ts: "2026-07-01T00:00:00.000Z",
        }),
      ),
    );
  });

  // 6 ── THE SPIKE-6 BEHAVIOUR CHANGE. Today (superuser) a converging cross-org upsert
  //      SILENTLY overwrites the other org's row. D-M15-2's `set:`-block omission protects
  //      only `org_id`; `parser_version`/`tokens`/`cost`/`machine_id` all cross the boundary.
  it("a CROSS-ORG converging ingest is rejected, while a SAME-ORG one still upserts cleanly", async () => {
    // Org A ingests the fingerprint first (as org A, through the wrapper).
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      ingestBatch(tx, machineA, convergingBatch("a")),
    );

    // Org B converges on the same fingerprint → rejected, not silently overwritten.
    await expectRlsRejection(
      withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
        ingestBatch(tx, machineB, convergingBatch("b")),
      ),
    );

    // Org A's row is intact and still org A's.
    const after = await owner.db.select().from(events);
    expect(after).toHaveLength(1);
    expect(after[0]!.orgId).toBe(orgA);
    expect(after[0]!.machineId).toBe(machineA);

    // The POSITIVE case: a SAME-ORG converging re-ingest is unaffected — this must not have
    // become a general "converging ingest is broken" regression.
    await expect(
      withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        ingestBatch(tx, machineA, convergingBatch("a2")),
      ),
    ).resolves.toBeDefined();
    const afterSameOrg = await owner.db.select().from(events);
    expect(afterSameOrg).toHaveLength(1);
    expect(afterSameOrg[0]!.orgId).toBe(orgA);
  });

  // 7 ── BOOTSTRAP-PERMISSIVE (D-15.3-3). The credential lookup that DISCOVERS the org must
  //      run before any org is known; inside a context it still enforces.
  it("credential lookups work with NO context, yet enforce inside one", async () => {
    // No context: `findMachineIdByToken` (ingest_tokens → machines) resolves. A STRICT policy
    // here would 401 every collector at pairing/ingest time — that is the whole exemption.
    const resolved = await findMachineIdByToken(appRole.db, tokenB);
    expect(resolved).toBe(machineB);

    const allMachines = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from machines`,
    );
    expect(allMachines.rows[0]!.n).toBe(2); // permissive with no context

    // WITH org A's context, org B's machine is invisible — the exemption is bounded.
    const scoped = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from machines`),
    );
    expect(scoped.rows[0]!.n).toBe(1);

    const bHidden = await withOrg(appRole.db, orgA, WRITE_ROLE, () =>
      findMachineIdByToken(appRole.db, tokenB),
    );
    // NOTE: `findMachineIdByToken` above is deliberately given the POOL handle, not `tx` — it
    // therefore runs on a different connection with no context and still resolves. The scoped
    // count assertion is what pins the enforcement; this line pins that a call OUTSIDE the
    // transaction is unaffected by it (contexts are per-transaction, not per-process).
    expect(bHidden).toBe(machineB);
  });

  // 8 ── THE POLICY INVENTORY IS EXACTLY AS DECIDED. Mirrors tenancy.int.test.ts's precedent
  //      of asserting a schema-level DECISION in a test, so the exemption cannot silently grow.
  it("pg_policies contains exactly the org policies + the 15.4 role-write backstop", async () => {
    // M15 15.4 — this query and its keying were BOTH changed, and the keying is the important
    // half. It used to build `new Map(rows.map(r => [r.tablename, r.qual]))`. With three
    // restrictive policies added per table that Map SILENTLY COLLAPSES four rows per table into
    // one: `byTable.size` would still read 15 and the test would stay green while `qual` became
    // whichever row the planner returned last. That is the same class of meaningless green as
    // `skipped ≠ passed` and `bypassed ≠ enforced` — so the fix is to re-key on
    // (tablename, policyname), NOT to bump the expected number.
    const rows = await owner.db.execute<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      sql`select tablename, policyname, permissive, cmd, qual, with_check
          from pg_policies where schemaname = 'public'`,
    );
    const all = rows.rows;
    const byKey = new Map(all.map((r) => [`${r.tablename}.${r.policyname}`, r]));
    // Nothing collapsed: one map entry per row.
    expect(byKey.size).toBe(all.length);

    const org = all.filter((r) => r.permissive === "PERMISSIVE");
    const restrictive = all.filter((r) => r.permissive === "RESTRICTIVE");

    // ── the 15.3 tenancy layer, unchanged by 15.4/15.5 except for the new tenant tables ──
    expect(org).toHaveLength(
      STRICT_TABLES.length + BOOTSTRAP_TABLES.length + ROLE_GATED_BOOTSTRAP_TABLES.length,
    );
    const orgByTable = new Map(org.map((r) => [r.tablename, r.qual!]));
    expect(orgByTable.size).toBe(org.length); // exactly one org policy per table

    for (const t of STRICT_TABLES) {
      const qual = orgByTable.get(t);
      expect(qual, `${t} must carry an org policy`).toBeTruthy();
      // A strict policy has NO "IS NULL" escape hatch — that is what makes an unset context
      // read zero rows rather than everything.
      expect(qual!.toUpperCase(), `${t} must be STRICT`).not.toContain("IS NULL");
    }
    for (const t of [...BOOTSTRAP_TABLES, ...ROLE_GATED_BOOTSTRAP_TABLES]) {
      const qual = orgByTable.get(t);
      expect(qual, `${t} must carry an org policy`).toBeTruthy();
      // M15 15.5: `invites` is asserted here, with the bootstrap tables, because it is PERMISSIVE
      // on the ORG axis — the "IS NULL" escape hatch is what lets the accept path discover the org.
      // Its restrictive ROLE policies are asserted in the restrictive block below.
      expect(qual!.toUpperCase(), `${t} must be BOOTSTRAP-PERMISSIVE`).toContain("IS NULL");
    }
    for (const t of NO_RLS_TABLES) {
      expect(orgByTable.has(t), `${t} must have NO policy (D-15.3-4 / D-M15-9)`).toBe(false);
    }

    // ── the 15.4 role-write backstop: 3 per STRICT table, plus (15.5) 3 on `invites` ──
    expect(restrictive).toHaveLength(
      (STRICT_TABLES.length + ROLE_GATED_BOOTSTRAP_TABLES.length) * 3,
    );
    for (const t of [...STRICT_TABLES, ...ROLE_GATED_BOOTSTRAP_TABLES]) {
      const forTable = restrictive.filter((r) => r.tablename === t);
      expect(forTable.map((r) => r.cmd).sort(), `${t} restrictive commands`).toEqual([
        "DELETE",
        "INSERT",
        "UPDATE",
      ]);
      // INSERT/UPDATE carry the test in WITH CHECK, which makes a blocked write LOUD.
      // DELETE has no WITH CHECK in Postgres, so it must be in USING — silently, unavoidably.
      for (const r of forTable) {
        if (r.cmd === "DELETE") {
          expect(r.qual, `${t} DELETE must test in USING`).toContain("app.current_role");
          expect(r.with_check).toBeNull();
        } else {
          expect(r.with_check, `${t} ${r.cmd} must test in WITH CHECK`).toContain(
            "app.current_role",
          );
        }
      }
    }
    // The three original BOOTSTRAP tables get NO role policy (D-15.4-3): machine/bootstrap writers
    // have no principal and therefore no membership role. `invites` is the deliberate exception
    // (D-15.5-2) and is asserted above — which is exactly why it is a separate constant rather than
    // an extra entry in this list, where it would have been silently exempted from both checks.
    for (const t of BOOTSTRAP_TABLES) {
      expect(
        restrictive.some((r) => r.tablename === t),
        `${t} must have NO role policy`,
      ).toBe(false);
    }
    // And NONE on SELECT, anywhere — a viewer is entitled to read their own org, so a role
    // predicate there would buy nothing while making every read more expensive.
    expect(restrictive.some((r) => r.cmd === "SELECT" || r.cmd === "ALL")).toBe(false);
  });

  // 9 ── FORCE, not merely ENABLE. Two distinct exemptions, two distinct switches: ENABLE
  //      turns the policy on, FORCE removes the TABLE-OWNER exemption (15.0 Finding 1).
  it("all 17 tenant tables have relrowsecurity AND relforcerowsecurity", async () => {
    // The count in the title is 17 as of 15.5 (`invites`). A number in a title that disagrees with
    // the arrays is precisely the drift this file exists to prevent — keep them in step.
    const all = [...STRICT_TABLES, ...BOOTSTRAP_TABLES, ...ROLE_GATED_BOOTSTRAP_TABLES];
    const rows = await owner.db.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relname in ${sql.raw(`(${all.map((t) => `'${t}'`).join(",")})`)}`,
    );
    expect(rows.rows).toHaveLength(all.length);
    for (const r of rows.rows) {
      expect(r.relrowsecurity, `${r.relname} ENABLE`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} FORCE`).toBe(true);
    }
  });
});
