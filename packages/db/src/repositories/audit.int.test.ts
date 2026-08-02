import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, withOrg } from "../index.js";
import { users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { recordAuditEvent } from "./audit.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M15 15.10 — THE APPEND-ONLY PROOF. A TWO-ROLE suite, and it has to be: RLS is INERT against the
 * owner (`rolbypassrls`), so an owner-only version of this file would report green while proving
 * nothing at all — the exact shape this repo has been burned by three times.
 *
 * These five assertions ARE the planning spike, re-expressed as a regression test. The negative
 * control was run: with the policy replaced by `FOR ALL USING (true)` and the REVOKE dropped, tests
 * 3 and 4 below FAIL (the app role reads its rows back and deletes them). A negative test nobody has
 * watched fail is not evidence.
 *
 *   - `owner`   (DATABASE_URL_TEST)     — setup only (TRUNCATE requires table OWNERSHIP), plus the
 *                                          break-glass read-back in tests 4 and 5. Never used to
 *                                          assert something the app role is supposed to be able to do.
 *   - `appRole` (DATABASE_URL_TEST_APP) — every claim about what the APPLICATION can and cannot do.
 */
/**
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose `message` is the SQL text and
 * hangs the real Postgres error off `.cause` — so a plain `.rejects.toThrow(/permission denied/)`
 * fails even when the REVOKE fired exactly as intended. Asserting the SPECIFIC Postgres error
 * matters here rather than merely "it threw": a syntax error would also throw, and would mean the
 * privilege check never ran. Same helper `rls.int.test.ts` needs, for the same reason.
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

async function expectPermissionDenied(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected a permission error, but the statement SUCCEEDED").toBeDefined();
  expect(errorChain(thrown)).toMatch(/permission denied/i);
}

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.10 audit_events is append-only (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;

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
    await owner.db.execute(
      sql`TRUNCATE audit_events, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await owner.db
      .insert(users)
      .values({ email: "audit-a@example.com" })
      .returning({ id: users.id });
    userA = u!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "audit-a@example.com");
    const [u2] = await owner.db
      .insert(users)
      .values({ email: "audit-b@example.com" })
      .returning({ id: users.id });
    orgB = await ensurePersonalOrg(owner.db, u2!.id, "audit-b@example.com");
    expect(orgA).not.toBe(orgB);
  });

  // 0 ── ROLE IDENTITY. Without this the whole file is theatre: point the "app" handle at the owner
  //      URL by mistake and every assertion below still passes while enforcing nothing.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
    const who = await appRole.db.execute<{ u: string }>(sql`select current_user as u`);
    expect(who.rows[0]!.u).toBe("420ai_app");
  });

  // 1 ── THE DESIGN'S CENTRAL CLAIM. `routes/api-keys.ts`, `auth.ts` and `sso.ts` are identity
  //      routes with NO org context, by design. If the append needed one, every `api_key.minted`
  //      audit would be a 500 — which is exactly what SPIKE check 8's strict-policy control showed.
  it("the app role appends with NO org context set", async () => {
    await expect(
      recordAuditEvent(appRole.db, {
        orgId: orgA,
        actorUserId: userA,
        actorEmail: "audit-a@example.com",
        action: "api_key.minted",
        metadata: { keyName: "laptop" },
      }),
    ).resolves.toBeUndefined();

    const seen = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_events where action = 'api_key.minted'`,
    );
    expect(seen.rows[0]!.n).toBe(1);
  });

  // 2 ── AND NO ROLE POLICY BLOCKS IT. A `viewer` is explicitly permitted to revoke their own API
  //      key, and that must produce an audit row rather than a 500 — which rules out the 15.4
  //      RESTRICTIVE role policies as a design here just as firmly as check 1 rules out the strict
  //      org policy.
  it("the app role appends inside withOrg at role=viewer", async () => {
    await withOrg(appRole.db, orgA, "viewer", (tx) =>
      recordAuditEvent(tx, {
        orgId: orgA,
        actorUserId: userA,
        actorEmail: "audit-a@example.com",
        action: "api_key.revoked",
        metadata: { keyId: "k1" },
      }),
    );
    const seen = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_events where action = 'api_key.revoked'`,
    );
    expect(seen.rows[0]!.n).toBe(1);
  });

  // 3 ── WRITE-ONLY IS A DATABASE GUARANTEE, NOT A CONVENTION. The second half — "still zero WITH a
  //      matching org context" — is the one that proves it: it is the ABSENT SELECT policy doing the
  //      work, not a predicate that happens to fail.
  it("the app role reads ZERO rows, with and without a matching org context", async () => {
    await recordAuditEvent(appRole.db, {
      orgId: orgA,
      actorUserId: userA,
      actorEmail: "audit-a@example.com",
      action: "org.renamed",
      metadata: { from: "x", to: "y" },
    });

    const blind = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_events`,
    );
    expect(blind.rows[0]!.n).toBe(0);

    const withContext = await withOrg(appRole.db, orgA, "owner", (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_events`),
    );
    expect(withContext.rows[0]!.n).toBe(0);

    // …and the row is genuinely there. Without this the test above would pass against an empty
    // table, which is the vacuous-green shape the whole file exists to avoid.
    const asOwner = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_events`,
    );
    expect(asOwner.rows[0]!.n).toBe(1);
  });

  // 4 ── THE APPLICATION CANNOT REWRITE OR ERASE HISTORY.
  //
  //      ASSERTED ON THE ROW SURVIVING, not only on the error, and the distinction is load-bearing
  //      because the failure MODE differs by layer: with the migration's `REVOKE` in place it is a
  //      loud `permission denied`; with the grant restored but the policy absent it degrades to a
  //      SILENT 0-row no-op. Asserting survival holds either way, so this test cannot be defeated by
  //      someone "fixing" the REVOKE back out.
  it("the app role cannot UPDATE or DELETE, and the rows survive the attempt", async () => {
    await recordAuditEvent(appRole.db, {
      orgId: orgA,
      actorUserId: userA,
      actorEmail: "audit-a@example.com",
      action: "member.removed",
      targetEmail: "gone@example.com",
      metadata: { role: "member" },
    });

    await expectPermissionDenied(
      appRole.db.execute(sql`update audit_events set action = 'org.renamed'`),
    );
    await expectPermissionDenied(appRole.db.execute(sql`delete from audit_events`));

    const survivors = await owner.db.execute<{ action: string }>(
      sql`select action from audit_events`,
    );
    expect(survivors.rows.map((r) => r.action)).toEqual(["member.removed"]);
  });

  // 4b ── D-15.10-3: an audit row is ATOMIC with the action it records.
  //
  //       BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT DISCRIMINATE, because the obvious reading is
  //       wrong and was measured to be wrong. It does NOT catch `recordAuditEvent` wrapping itself
  //       in a transaction: drizzle turns a nested `transaction()` on a `Tx` into a SAVEPOINT, and
  //       a savepoint rolls back with its parent — the negative control was run, and this test kept
  //       passing with the function wrapped. What it DOES pin is that the write travels on the
  //       caller's connection at all: an implementation that acquired its own pool connection would
  //       commit independently and this would fail.
  //
  //       THE FAILURE MODE THAT ACTUALLY MATTERS is a CALL SITE passing `app.db` instead of its
  //       `tx` — invisible to `tsc`, since `DbClient` accepts either by design. That is guarded
  //       structurally in `apps/ingest/src/routes/audit-call-sites.test.ts`, because no
  //       repository-level test can see a route's argument.
  it("an audit row rolls back with its caller's transaction", async () => {
    await expect(
      appRole.db.transaction(async (tx) => {
        await recordAuditEvent(tx, {
          orgId: orgA,
          actorUserId: userA,
          actorEmail: "audit-a@example.com",
          action: "member.removed",
          targetEmail: "rolled-back@example.com",
        });
        throw new Error("the action failed after its audit write");
      }),
    ).rejects.toThrow(/the action failed/);

    // Read on the OWNER handle — the app role reads zero rows by design, so asserting through it
    // would pass vacuously whether or not the row survived.
    const rows = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_events`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  // 5 ── THE BREAK-GLASS CHANNEL IS INTACT (D-M15-7 / D-15.10-4). There is no audit VIEWER by
  //      decision, so this read path is the only one — and `FORCE ROW LEVEL SECURITY` is omitted
  //      from the migration precisely to keep the owner's exemption that makes it work.
  it("the OWNER reads every row, across orgs", async () => {
    await recordAuditEvent(appRole.db, {
      orgId: orgA,
      actorUserId: userA,
      actorEmail: "audit-a@example.com",
      action: "member.invited",
      // The case a normalized-only schema could not record at all: an invited address has no
      // `users` row yet, so `target_user_id` is NULL and `target_email` carries the identity.
      targetEmail: "new@example.com",
      metadata: { role: "member" },
    });
    await recordAuditEvent(appRole.db, {
      orgId: orgB,
      actorUserId: userA,
      actorEmail: "audit-a@example.com",
      action: "member.joined",
      metadata: { role: "owner" },
    });

    const rows = await owner.db.execute<{
      action: string;
      target_user_id: string | null;
      target_email: string | null;
    }>(sql`select action, target_user_id, target_email from audit_events order by action`);
    expect(rows.rows.map((r) => r.action)).toEqual(["member.invited", "member.joined"]);
    const invited = rows.rows.find((r) => r.action === "member.invited")!;
    expect(invited.target_user_id).toBeNull();
    expect(invited.target_email).toBe("new@example.com");
  });
});
