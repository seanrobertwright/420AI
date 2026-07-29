import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { users } from "../schema.js";
import {
  findUserIdBySsoIdentity,
  linkSsoIdentity,
  listSsoIdentities,
  SsoIdentityError,
  unlinkSsoIdentity,
} from "./sso-identities.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M15 15.7 — the MECHANISM half of the slice's proof, at the repository layer.
 *
 * The HTTP suite (`apps/ingest/src/sso.int.test.ts`) proves the POLICY; this one proves the things
 * a policy test cannot see: that the app role can touch the table at all (`sso_identities` gets its
 * grants implicitly from 0015's `ALTER DEFAULT PRIVILEGES`, and a missing GRANT is a real shippable
 * bug only a NON-OWNER handle can catch), that `(provider, subject)` isolates providers, and that
 * the last-credential guard holds under two CONCURRENT transactions — which, per CLAUDE.md's 15.5
 * corollary, is a fact no HTTP-layer test can discriminate.
 *
 * TWO ROLES: `owner` for setup only (TRUNCATE requires ownership), `appRole` for every assertion.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.7 sso_identities (two-role, repository)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let userA: string;
  let userB: string;
  /** A user with NO password — the SSO-created shape the unlink guard exists for. */
  let userSsoOnly: string;

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
      sql`TRUNCATE sso_identities, sessions, invites, password_reset_tokens, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([
        { email: "a@example.com", passwordHash: "scrypt$fake$a" },
        { email: "b@example.com", passwordHash: "scrypt$fake$b" },
        // password_hash deliberately absent — this is what `createUserWithoutPassword` produces.
        { email: "sso@example.com" },
      ])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    userSsoOnly = seeded.find((u) => u.email === "sso@example.com")!.id;
  });

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre: point the "app" handle at the
  // owner URL by mistake and every assertion below still passes.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
  });

  // 2 ── THE GRANT. 0019 ships no explicit GRANT because 0015's ALTER DEFAULT PRIVILEGES covers
  // it. This is the test that keeps that true — under a missing grant every other test in this
  // file would fail with a permissions error rather than an assertion.
  it("the app role can INSERT, SELECT and DELETE with no explicit grant in 0019", async () => {
    await linkSsoIdentity(appRole.db, userA, {
      provider: "google",
      subject: "g-1",
      email: "a@example.com",
    });
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "g-1")).toBe(userA);
    expect(await unlinkSsoIdentity(appRole.db, userA, "google")).toBe(true);
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "g-1")).toBeUndefined();
  });

  it("normalizes the stored email and reports `undefined` for an unlinked identity", async () => {
    await linkSsoIdentity(appRole.db, userA, {
      provider: "google",
      subject: "g-2",
      email: "MixedCase@Example.COM",
    });
    const [row] = await listSsoIdentities(appRole.db, userA);
    expect(row!.email).toBe("mixedcase@example.com");
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "never-linked")).toBeUndefined();
  });

  it("omits `subject` from the listed rows (it never belongs on the wire)", async () => {
    await linkSsoIdentity(appRole.db, userA, { provider: "google", subject: "g-3" });
    const [row] = await listSsoIdentities(appRole.db, userA);
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(["createdAt", "email", "id", "provider"]);
  });

  // 3 ── ISOLATION. `(provider, subject)` is the key, so two providers may share a subject string.
  // A resolver keyed on `subject` alone would pass every other test in this file.
  it("treats the same subject on two providers as two independent identities", async () => {
    await linkSsoIdentity(appRole.db, userA, { provider: "google", subject: "12345" });
    await linkSsoIdentity(appRole.db, userB, { provider: "github", subject: "12345" });
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "12345")).toBe(userA);
    expect(await findUserIdBySsoIdentity(appRole.db, "github", "12345")).toBe(userB);
  });

  it("re-linking the SAME identity to the SAME user is a no-op success", async () => {
    // A user who double-clicks "Connect Google" must not get a 409 for the state they asked for.
    const first = await linkSsoIdentity(appRole.db, userA, {
      provider: "google",
      subject: "g-4",
      email: "old@example.com",
    });
    const again = await linkSsoIdentity(appRole.db, userA, {
      provider: "google",
      subject: "g-4",
      email: "new@example.com",
    });
    expect(again.id).toBe(first.id);
    const rows = await listSsoIdentities(appRole.db, userA);
    expect(rows).toHaveLength(1);
    // The provider-side email change is absorbed, which is the login-path behaviour too.
    expect(rows[0]!.email).toBe("new@example.com");
  });

  it("refuses to move an identity that belongs to somebody else", async () => {
    await linkSsoIdentity(appRole.db, userA, { provider: "google", subject: "g-5" });
    await expect(
      linkSsoIdentity(appRole.db, userB, { provider: "google", subject: "g-5" }),
    ).rejects.toThrow(SsoIdentityError);
    // …and NO row moved. A refusal that had already re-pointed the row would be the takeover.
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "g-5")).toBe(userA);
  });

  /**
   * THE LINK RACE, at the only layer that can see it. Review finding 2.
   *
   * The original guard was a `SELECT` followed by an unguarded upsert. `SELECT` takes no locks, so
   * two concurrent linkers both passed the read and the loser's `ON CONFLICT DO UPDATE` updated
   * THE WINNER'S ROW, returning its id — a FALSE SUCCESS, with the route answering 204 to a user
   * who was not linked. Sequential calls could never show it (the read sees the committed row), so
   * this needs the interleaving spelled out.
   *
   * The fix makes the UNIQUE INDEX the mechanism via `setWhere`, so no lock is involved here — but
   * the test still has to hold a transaction open to create the window.
   */
  it("refuses a CONCURRENT link of the same identity to a different user", async () => {
    const t1 = await appRole.pool.connect();
    let outcome: string;
    try {
      await t1.query("BEGIN");
      // T1 claims the identity for userA but does not commit.
      await t1.query(
        "insert into sso_identities (user_id, provider, subject) values ($1, 'google', 'g-race2')",
        [userA],
      );

      // T2 runs the real repository function for userB. Its INSERT blocks on the unique index.
      const t2 = linkSsoIdentity(appRole.db, userB, {
        provider: "google",
        subject: "g-race2",
      }).then(
        () => "SUCCEEDED",
        (e: unknown) => `THREW:${e instanceof SsoIdentityError ? e.reason : String(e)}`,
      );
      await new Promise((r) => setTimeout(r, 300));
      await t1.query("COMMIT");
      outcome = await t2;
    } finally {
      // Released in a `finally` — a held connection starves the pool and turns one real failure
      // into a string of fake timeouts in later tests (CLAUDE.md 15.5).
      t1.release();
    }

    expect(outcome, "the losing linker must be refused, not silently told it succeeded").toBe(
      "THREW:identity_taken",
    );
    // …and the row still belongs to the WINNER. A refusal that re-pointed it would be the takeover.
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "g-race2")).toBe(userA);
  });

  // 4 ── THE LAST-CREDENTIAL GUARD, in BOTH directions. The negative half alone would pass for an
  // implementation that refuses everything.
  it("refuses to unlink the ONLY credential of a password-less account", async () => {
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "google", subject: "g-6" });
    await expect(unlinkSsoIdentity(appRole.db, userSsoOnly, "google")).rejects.toMatchObject({
      reason: "last_credential",
    });
    // The link survives the refusal — a guard that threw after deleting would still lock them out.
    expect(await findUserIdBySsoIdentity(appRole.db, "google", "g-6")).toBe(userSsoOnly);
  });

  it("ALLOWS the unlink once a password exists", async () => {
    // `userA` has a password hash; unlinking their only provider leaves them a way in.
    await linkSsoIdentity(appRole.db, userA, { provider: "google", subject: "g-7" });
    expect(await unlinkSsoIdentity(appRole.db, userA, "google")).toBe(true);
  });

  it("ALLOWS the unlink once a SECOND provider is linked", async () => {
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "google", subject: "g-8" });
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "github", subject: "gh-8" });
    expect(await unlinkSsoIdentity(appRole.db, userSsoOnly, "google")).toBe(true);
    // …and the SECOND unlink is now the last-credential case, so it must refuse.
    await expect(unlinkSsoIdentity(appRole.db, userSsoOnly, "github")).rejects.toMatchObject({
      reason: "last_credential",
    });
  });

  /**
   * THE DEADLOCK ORDERING — the one the existing concurrency test above does NOT exercise.
   *
   * That test hand-drives the interleaving where the winner has ALREADY DELETED before the loser
   * reads, which is the ordering in which EvalPlanQual genuinely fires. The dangerous ordering is
   * the other one: BOTH transactions complete their locking read first. With the old code each
   * locked a disjoint row (unlinking `google` locked the `github` row and vice versa), so neither
   * blocked, both saw a surviving credential, and the two DELETEs deadlocked — 40P01, unmapped,
   * surfacing to the user as a 500 rather than the documented 409.
   *
   * Both unlinks are launched with NO hand-holding here, precisely so the read-read interleaving is
   * reachable. The assertion is deliberately about the OUTCOME CLASS, not about which one wins:
   * exactly one must succeed, the other must be refused with `last_credential`, and neither may
   * fail with a deadlock.
   */
  it("does not DEADLOCK when two different providers are unlinked concurrently", async () => {
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "google", subject: "g-dl" });
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "github", subject: "gh-dl" });

    const settle = (p: Promise<boolean>) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    const [a, b] = await Promise.all([
      settle(unlinkSsoIdentity(appRole.db, userSsoOnly, "google")),
      settle(unlinkSsoIdentity(appRole.db, userSsoOnly, "github")),
    ]);

    for (const r of [a, b]) {
      if (!r.ok) {
        const msg =
          r.e instanceof Error ? `${r.e.message} ${String(r.e.cause ?? "")}` : String(r.e);
        expect(msg, "a deadlock is not an acceptable outcome — it surfaces as a 500").not.toMatch(
          /deadlock|40P01/i,
        );
        expect(r.e).toBeInstanceOf(SsoIdentityError);
        expect((r.e as SsoIdentityError).reason).toBe("last_credential");
      }
    }
    // Exactly one succeeded, so the account keeps exactly one credential and is still openable.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await listSsoIdentities(appRole.db, userSsoOnly)).toHaveLength(1);
  });

  it("returns false when nothing was linked for that provider", async () => {
    await linkSsoIdentity(appRole.db, userA, { provider: "google", subject: "g-9" });
    expect(await unlinkSsoIdentity(appRole.db, userA, "github")).toBe(false);
  });

  /**
   * 5 ── THE RACE, AT THE ONLY LAYER THAT CAN SEE IT (CLAUDE.md 15.5's corollary).
   *
   * Two concurrent unlinks of two DIFFERENT providers each read "one other credential exists" and,
   * without the `FOR UPDATE`, both proceed — leaving zero credentials on an account that cannot be
   * opened. Two HTTP requests would NOT discriminate: they serialise on their own at that
   * granularity and the test passes identically with and without the lock.
   *
   * So: two hand-held transactions. The first takes the lock and holds it; the second must still
   * be UNSETTLED after a wait, which is the fact that proves it blocked rather than raced past.
   * Released in a `finally` — 15.5's failure to do so turned one real failure into five fake
   * timeouts in later tests sharing the pool.
   */
  it("serialises two concurrent unlinks so exactly one succeeds", async () => {
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "google", subject: "g-race" });
    await linkSsoIdentity(appRole.db, userSsoOnly, { provider: "github", subject: "gh-race" });

    const first = await appRole.pool.connect();
    let settled = false;
    try {
      await first.query("BEGIN");
      // The winner's locking read + delete, by hand so the transaction stays open.
      await first.query(
        "select id from sso_identities where user_id = $1 and provider <> $2 for update",
        [userSsoOnly, "google"],
      );
      await first.query("select password_hash from users where id = $1 for share", [userSsoOnly]);
      await first.query("delete from sso_identities where user_id = $1 and provider = $2", [
        userSsoOnly,
        "google",
      ]);

      // The loser, through the real repository function, racing the still-open transaction.
      const loser = unlinkSsoIdentity(appRole.db, userSsoOnly, "github").then(
        (v) => {
          settled = true;
          return { ok: true as const, v };
        },
        (e: unknown) => {
          settled = true;
          return { ok: false as const, e };
        },
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(settled, "the second unlink must BLOCK on the lock, not race past it").toBe(false);

      await first.query("COMMIT");
      const outcome = await loser;
      // Having re-evaluated under EvalPlanQual, the loser sees the google row is gone and
      // correctly refuses: `github` is now the last credential.
      // A `throw` rather than `expect(outcome.ok).toBe(false)`: vitest's matcher does not narrow
      // the discriminated union for TypeScript, and this file IS in the root `tsc -b` graph.
      if (outcome.ok) throw new Error("the losing unlink SUCCEEDED — the guard did not hold");
      expect(outcome.e).toBeInstanceOf(SsoIdentityError);
      expect((outcome.e as SsoIdentityError).reason).toBe("last_credential");
    } finally {
      // MUST release, or this connection stays checked out of the pool and every later test in
      // the file times out at 10 s — one real failure wearing five fake ones.
      first.release();
    }

    // Exactly one credential survives; the account is still openable.
    const remaining = await listSsoIdentities(appRole.db, userSsoOnly);
    expect(remaining.map((r) => r.provider)).toEqual(["github"]);
  });
});
