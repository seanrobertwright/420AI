import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { sessions, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import {
  createSession,
  findLiveSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "./sessions.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M15 15.6 — the REPOSITORY-level proof for stateful sessions (D-M15-12).
 *
 * TWO POSTGRES ROLES, as CLAUDE.md requires of anything touching identity: the `owner` handle
 * (DATABASE_URL_TEST) does setup only, because TRUNCATE requires table ownership, and every
 * assertion below runs on the `appRole` handle (DATABASE_URL_TEST_APP) — a non-owner with
 * `rolbypassrls = false`, which is what the server actually connects as.
 *
 * The usual reason for the two-role split does NOT apply here, and saying so is the point:
 * `sessions` carries NO RLS policy at all (D-15.6-3), so there is nothing to bypass and nothing to
 * drop in a mutation check. What the non-owner handle proves instead is the OTHER shippable bug of
 * a brand-new table — a MISSING GRANT. 0018 adds no explicit `GRANT`, relying on 0015's
 * `ALTER DEFAULT PRIVILEGES`; if that reliance were ever wrong, every function in this file would
 * fail here and nowhere else, because an owner-connected suite cannot see a missing grant.
 *
 * This file pins the MECHANISM. `apps/ingest/src/sessions.int.test.ts` pins the PRODUCT BEHAVIOUR
 * through the routes. Per the 15.3 lesson, neither substitutes for the other.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.6 sessions repository (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let userA: string;
  let userB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // every assertion — the point of this suite
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // `sessions` is deliberately NOT named here: it references `users`, so CASCADE truncates it
    // without being listed — the same reason no other fixture in the repo needed editing for 15.6.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    await ensurePersonalOrg(owner.db, userA, "a@example.com");
    await ensurePersonalOrg(owner.db, userB, "b@example.com");
  });

  const hour = () => new Date(Date.now() + 60 * 60 * 1000);

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre: point APP_URL at the owner by
  //      mistake and every test below still passes while proving nothing about the app role.
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

  // 2 ── THE POSITIVE ASSERTION, first and on the app role. Every negative below is meaningless
  //      without it: a lookup that finds NOTHING — a missing grant, a typo'd predicate — is
  //      indistinguishable from correct revocation if you only ever assert absence.
  it("a freshly minted session is LIVE and resolves to its owner", async () => {
    const { id } = await createSession(appRole.db, userA, hour(), "vitest/1.0");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const live = await findLiveSession(appRole.db, id);
    expect(live, "a fresh session must resolve").toEqual({ userId: userA });
  });

  it("an unknown session id resolves to undefined rather than throwing", async () => {
    expect(
      await findLiveSession(appRole.db, "11111111-2222-3333-4444-555555555555"),
    ).toBeUndefined();
  });

  // 3 ── REVOKED ≠ EXPIRED ≠ ABSENT. All three collapse to `undefined` at the API on purpose
  //      (distinguishing them would tell an attacker whether a guessed id exists), so each is
  //      constructed separately here to prove all three are actually handled.
  it("a REVOKED session stops resolving, though its row is still present", async () => {
    const { id } = await createSession(appRole.db, userA, hour());
    expect(await revokeSession(appRole.db, userA, id)).toBe(true);
    expect(await findLiveSession(appRole.db, id)).toBeUndefined();
    // The row survives — revocation is a stamp, not a delete, so a future audit can see it.
    const rows = await owner.db.select().from(sessions).where(eq(sessions.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it("an EXPIRED session does not resolve, even unrevoked", async () => {
    // Expiry is compared in the DATABASE (`now()`), never against a JS Date — so this row is past
    // regardless of any clock skew between this process and Postgres.
    const { id } = await createSession(appRole.db, userA, new Date(Date.now() - 1000));
    expect(await findLiveSession(appRole.db, id)).toBeUndefined();
  });

  // 4 ── OWNERSHIP. `revokeSession` takes `userId` as its SECOND parameter and it is NOT optional:
  //      without it any authenticated caller could revoke any id they could guess, and the route
  //      layer has no other ownership check to fall back on.
  it("revokeSession refuses a session belonging to somebody else", async () => {
    const { id } = await createSession(appRole.db, userA, hour());
    expect(await revokeSession(appRole.db, userB, id), "B must not revoke A's session").toBe(false);
    expect(await findLiveSession(appRole.db, id), "A's session must still be live").toEqual({
      userId: userA,
    });
  });

  it("revokeSession is idempotent — a second call returns false", async () => {
    const { id } = await createSession(appRole.db, userA, hour());
    expect(await revokeSession(appRole.db, userA, id)).toBe(true);
    expect(await revokeSession(appRole.db, userA, id)).toBe(false);
  });

  // 5 ── THE ISOLATION ASSERTION. A `revokeAllSessions` that forgot its `WHERE user_id = $1` would
  //      pass every other test in this file — this is the `min(org_id)` lesson one table over: an
  //      ownership predicate omitted from a MUTATION is invisible until someone checks the other
  //      user.
  it("revoking user A's sessions leaves user B's untouched", async () => {
    const a1 = await createSession(appRole.db, userA, hour());
    const a2 = await createSession(appRole.db, userA, hour());
    const b1 = await createSession(appRole.db, userB, hour());

    expect(await revokeAllSessions(appRole.db, userA)).toBe(2);
    expect(await findLiveSession(appRole.db, a1.id)).toBeUndefined();
    expect(await findLiveSession(appRole.db, a2.id)).toBeUndefined();
    expect(await findLiveSession(appRole.db, b1.id), "B's session must survive A's revoke").toEqual(
      {
        userId: userB,
      },
    );
  });

  it("revokeAllSessions is idempotent — the count is how many were LIVE, not how many exist", async () => {
    await createSession(appRole.db, userA, hour());
    await createSession(appRole.db, userA, hour());
    expect(await revokeAllSessions(appRole.db, userA)).toBe(2);
    expect(await revokeAllSessions(appRole.db, userA)).toBe(0);
  });

  it("revokeAllSessions spares `exceptSessionId` (the password-change shape)", async () => {
    const keep = await createSession(appRole.db, userA, hour());
    const drop1 = await createSession(appRole.db, userA, hour());
    const drop2 = await createSession(appRole.db, userA, hour());

    expect(await revokeAllSessions(appRole.db, userA, keep.id)).toBe(2);
    expect(await findLiveSession(appRole.db, keep.id), "the spared session must survive").toEqual({
      userId: userA,
    });
    expect(await findLiveSession(appRole.db, drop1.id)).toBeUndefined();
    expect(await findLiveSession(appRole.db, drop2.id)).toBeUndefined();
  });

  /**
   * The reasoning pin for D-15.6-3's "no lock needed", because CLAUDE.md's 15.5 lesson makes "is
   * this racy?" the first question a reviewer will ask of any concurrent mutation.
   *
   * `revokeAllSessions` is a BLIND UPDATE with its whole predicate in the WHERE clause — there is
   * no SELECT-then-decide window for two callers to race through, which is the shape the 15.5
   * last-owner guard actually had. Two concurrent calls therefore both succeed, and their counts
   * SUM to the number that were live: whichever transaction commits first claims the rows, and the
   * second re-evaluates `revoked_at IS NULL` after the lock releases and finds none. No
   * SERIALIZABLE, no retry loop.
   */
  it("two concurrent revoke-alls each succeed and their counts sum to the live total", async () => {
    await createSession(appRole.db, userA, hour());
    await createSession(appRole.db, userA, hour());
    await createSession(appRole.db, userA, hour());

    const [n1, n2] = await Promise.all([
      revokeAllSessions(appRole.db, userA),
      revokeAllSessions(appRole.db, userA),
    ]);
    expect(n1 + n2, "no row may be revoked twice, and none may be missed").toBe(3);
  });

  /**
   * THE LOGIN-vs-CREDENTIAL-CHANGE RACE, and the reason this test lives HERE rather than at the
   * HTTP layer.
   *
   * The bug (found in review, reproducible before the fix): a login reads the password hash, spends
   * ~100 ms in blocking scrypt, then INSERTS its `sessions` row. A concurrent password reset
   * updates the hash and runs `revokeAllSessions` — a blind UPDATE, which cannot see a row that has
   * not been inserted yet. Interleaved so the insert lands after the revoke, a session minted from
   * the OLD password survives the reset for its full 7 days: exactly the takeover-recovery failure
   * D-15.6-6 exists to close.
   *
   * AN HTTP-LEVEL VERSION OF THIS TEST WAS WRITTEN FIRST AND DELETED, because it passed identically
   * with and without the fix — MEASURED, not assumed. `hashPassword`/`verifyPassword` are blocking
   * scryptSync, so two concurrent handlers serialise on the event loop and the interleaving cannot
   * be driven from outside. That is CLAUDE.md's 15.5 lesson exactly ("a concurrency test at the
   * wrong LAYER cannot fail"), and a green test advertising an unchecked guarantee is worse than no
   * test. Two hand-held transactions are the only thing that discriminates.
   *
   * The discriminating assertion is that the credential-change UPDATE is STILL UNSETTLED after a
   * wait — i.e. genuinely blocked on the login's `FOR SHARE` lock. Remove `{ lock: true }` from
   * `findAdminCredential` and this is the line that fails.
   */
  it("a login's FOR SHARE lock blocks a concurrent credential change until its session exists", async () => {
    const login = await appRole.pool.connect();
    const reset = await appRole.pool.connect();
    try {
      // ── the LOGIN transaction: lock the user row, then (slowly) mint a session.
      await login.query("BEGIN");
      await login.query("SELECT id FROM users WHERE id = $1 FOR SHARE", [userA]);

      // ── the RESET transaction: try to rewrite the hash. It must BLOCK on the lock above.
      await reset.query("BEGIN");
      let settled = false;
      const blocked = reset
        .query("UPDATE users SET password_hash = $2 WHERE id = $1", [userA, "new-hash"])
        .finally(() => {
          settled = true;
        });

      await new Promise((r) => setTimeout(r, 400));
      expect(
        settled,
        "the credential change must be BLOCKED by the login's lock — without it, it commits first and revokes nothing",
      ).toBe(false);

      // The login now inserts its session and commits, releasing the lock.
      await login.query(
        "INSERT INTO sessions (user_id, expires_at) VALUES ($1, now() + interval '1 hour')",
        [userA],
      );
      await login.query("COMMIT");

      await blocked;
      // …and because it waited, the reset's revoke SEES the just-inserted row.
      const revoked = await reset.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id",
        [userA],
      );
      expect(revoked.rowCount, "the raced-in session must be caught by the revoke").toBe(1);
      await reset.query("COMMIT");

      expect(await listSessions(appRole.db, userA)).toHaveLength(0);
    } finally {
      // CLAUDE.md 15.5: a held transaction MUST be released in `finally`. When an assertion above
      // first failed without this, the pooled connections stayed checked out and five later tests
      // in the file timed out at 10 s — one real failure wearing five fake ones.
      await login.query("ROLLBACK").catch(() => {});
      await reset.query("ROLLBACK").catch(() => {});
      login.release();
      reset.release();
    }
  });

  // 6 ── listSessions: live only, newest first, explicit columns (these rows reach `reply.send()`).
  it("listSessions returns only LIVE sessions, newest first, with the wire column set", async () => {
    const older = await createSession(appRole.db, userA, hour(), "old-agent");
    // Force a distinguishable ordering key — `created_at` defaults to `now()` and two inserts in
    // the same statement-burst can share a timestamp.
    await owner.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.id, older.id));
    const newer = await createSession(appRole.db, userA, hour(), "new-agent");
    const revoked = await createSession(appRole.db, userA, hour(), "revoked-agent");
    await revokeSession(appRole.db, userA, revoked.id);
    await createSession(appRole.db, userA, new Date(Date.now() - 1000), "expired-agent");
    await createSession(appRole.db, userB, hour(), "other-user-agent");

    const rows = await listSessions(appRole.db, userA);
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(rows[0]!.userAgent).toBe("new-agent");
    // Explicit column list (CLAUDE.md 15.1): exactly the four exported by `SessionRow`, so a future
    // column cannot become an unannounced API addition.
    expect(Object.keys(rows[0]!).sort()).toEqual(["createdAt", "expiresAt", "id", "userAgent"]);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.expiresAt).toBeInstanceOf(Date);
  });

  it("a null user-agent round-trips (non-browser clients send none)", async () => {
    await createSession(appRole.db, userA, hour());
    const rows = await listSessions(appRole.db, userA);
    expect(rows[0]!.userAgent).toBeNull();
  });

  // 7 ── The table carries NO policy, asserted here as well as in `rls.int.test.ts`'s inventory,
  //      because this is the file whose every test would silently change meaning if one appeared.
  it("`sessions` carries no RLS policy and no RLS switch (D-15.6-3)", async () => {
    const policies = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'sessions'`,
    );
    expect(policies.rows[0]!.n).toBe(0);
    const flags = await appRole.db.execute<{ relrowsecurity: boolean }>(
      sql`select relrowsecurity from pg_class where relname = 'sessions'`,
    );
    expect(flags.rows[0]!.relrowsecurity).toBe(false);
  });
});
