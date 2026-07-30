import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { hashToken } from "../tokens.js";
import { ensurePersonalOrg } from "./organizations.js";
import { setUserPassword } from "./users.js";
import {
  MfaError,
  confirmTotp,
  countUnusedRecoveryCodes,
  findTotpCredential,
  recordMfaFailure,
  recordTotpUse,
  redeemRecoveryCode,
  replaceRecoveryCodes,
  clearMfa,
  upsertUnconfirmedTotp,
} from "./mfa.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const HASH = "scrypt$c2FsdA$ZGs"; // never verified here — these tests never log in
const SECRET = Buffer.from("12345678901234567890", "ascii");

/**
 * M15 15.8 — the REPOSITORY-level proof. TWO ROLES, and the split with
 * `apps/ingest/src/mfa.int.test.ts` is deliberate:
 *
 *   - the HTTP suite validates the PRIMARY defence (route gates, the challenge exchange, the
 *     end-to-end flows);
 *   - THIS file validates the CONCURRENCY MECHANISMS, because CLAUDE.md's 15.5 lesson says a
 *     concurrency test at the wrong LAYER cannot fail. 15.5's first regression test drove two
 *     concurrent HTTP requests and passed identically with and without the lock, since requests
 *     serialise on their own at that granularity — a green test advertising a guarantee nobody had
 *     checked. Only two hand-held transactions discriminate.
 *
 * EVERY TEST THAT HOLDS A TRANSACTION OPEN RELEASES IT IN A `finally`. When 15.5's equivalent
 * assertion first failed it skipped the release, the held transaction kept its pooled connection, and
 * five later tests in the file timed out at 10 s — one real failure wearing five fake ones.
 *
 * Two roles nonetheless, because `bypassed ≠ enforced` is a habit and not a case-by-case judgement:
 * the owner handle does setup only (TRUNCATE requires ownership) and every assertion runs on the
 * non-owner handle the server actually connects as. Here it also proves the implicit GRANTs on the
 * two new tables are real (migration 0020's header claims them).
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.8 MFA repository (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let userA: string;
  let userB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // Neither MFA table is named: both carry an FK to `users`, so the CASCADE clears them.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    userA = await setUserPassword(owner.db, "a@example.com", HASH);
    userB = await setUserPassword(owner.db, "b@example.com", HASH);
    await ensurePersonalOrg(owner.db, userA, "a@example.com");
    await ensurePersonalOrg(owner.db, userB, "b@example.com");
  });

  /** An enrolled, confirmed credential at `step`, written through the real repository functions. */
  async function enrol(userId: string, step = 100): Promise<void> {
    await upsertUnconfirmedTotp(appRole.db, userId, SECRET);
    expect(await confirmTotp(appRole.db, userId, step)).toBe(true);
  }

  // 1 ── ROLE IDENTITY. First, and non-negotiable: without it this whole file is theatre.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ b: boolean }>(
      sql`select rolbypassrls as b from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.b).toBe(false);
  });

  // ── the encryption round trip ─────────────────────────────────────────────────────────────

  it("the secret round-trips through encryption and is NOT stored in the clear", async () => {
    await enrol(userA);
    const cred = await findTotpCredential(appRole.db, userA);
    expect(cred!.secret.equals(SECRET)).toBe(true);
    // The stored ciphertext must not contain the plaintext, base32 or base64 of the secret — the
    // assertion that a "field encryption" that silently stored the plaintext would fail.
    const row = await owner.db.execute<{ ct: string }>(
      sql`select secret_ciphertext as ct from totp_credentials where user_id = ${userA}`,
    );
    expect(row.rows[0]!.ct).not.toContain(SECRET.toString("base64"));
    expect(row.rows[0]!.ct).not.toContain("12345678901234567890");
  });

  it("upsertUnconfirmedTotp replaces an UNCONFIRMED secret and refuses a CONFIRMED one", async () => {
    await upsertUnconfirmedTotp(appRole.db, userA, SECRET);
    const other = Buffer.from("09876543210987654321", "ascii");
    await upsertUnconfirmedTotp(appRole.db, userA, other);
    expect((await findTotpCredential(appRole.db, userA))!.secret.equals(other)).toBe(true);

    expect(await confirmTotp(appRole.db, userA, 100)).toBe(true);
    // Confirmed now. A silent rotation from here would be a takeover primitive (D-15.8-10).
    await expect(upsertUnconfirmedTotp(appRole.db, userA, SECRET)).rejects.toThrow(MfaError);
    expect((await findTotpCredential(appRole.db, userA))!.secret.equals(other)).toBe(true);
  });

  it("confirmTotp is idempotent-refusing: a second confirm returns false", async () => {
    await upsertUnconfirmedTotp(appRole.db, userA, SECRET);
    expect(await confirmTotp(appRole.db, userA, 100)).toBe(true);
    expect(await confirmTotp(appRole.db, userA, 101)).toBe(false);
  });

  // ── the monotonic replay guard ─────────────────────────────────────────────────────────────

  it("recordTotpUse is MONOTONIC: the same and earlier steps are refused", async () => {
    await enrol(userA, 100);
    expect(await recordTotpUse(appRole.db, userA, 100)).toBe(false); // the confirming step is spent
    expect(await recordTotpUse(appRole.db, userA, 99)).toBe(false); // and so is anything before it
    expect(await recordTotpUse(appRole.db, userA, 101)).toBe(true);
    expect(await recordTotpUse(appRole.db, userA, 101)).toBe(false);
  });

  /**
   * THE RACE: two verifies presenting the SAME code at the SAME step.
   *
   * The mechanism is a BLIND UPDATE with the whole predicate in the WHERE, so the loser blocks on the
   * row lock, re-evaluates under EvalPlanQual, finds `last_step = 101`, matches nothing and returns
   * false. Held open with a gate so the contention is real rather than accidental.
   */
  it("two concurrent recordTotpUse at the same step produce EXACTLY ONE winner", async () => {
    await enrol(userA, 100);
    let releaseTx1: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    let firstResult: boolean | undefined;
    const tx1 = appRole.db.transaction(async (tx) => {
      firstResult = await recordTotpUse(tx, userA, 101);
      await gate; // HOLD the row lock
    });
    await new Promise((r) => setTimeout(r, 200));

    let tx2Settled = false;
    const tx2 = appRole.db
      .transaction((tx) => recordTotpUse(tx, userA, 101))
      .then((v) => {
        tx2Settled = true;
        return v;
      });

    // A failing assertion must still release tx1, or its connection stays checked out and every
    // later test in this file times out (the 15.5 "one real failure wearing five fake ones" shape).
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(tx2Settled, "tx2 must be BLOCKED on tx1's row lock").toBe(false);
    } finally {
      releaseTx1!();
      await tx1.catch(() => {});
    }
    expect(firstResult).toBe(true);
    expect(await tx2, "the loser must observe the spent step and refuse").toBe(false);
  });

  // ── recovery codes ─────────────────────────────────────────────────────────────────────────

  it("redeemRecoveryCode spends a code once and refuses it thereafter", async () => {
    await enrol(userA);
    await replaceRecoveryCodes(appRole.db, userA, ["h1", "h2", "h3"].map(hashToken));
    expect(await countUnusedRecoveryCodes(appRole.db, userA)).toBe(3);
    expect(await redeemRecoveryCode(appRole.db, userA, hashToken("h1"))).toBe(true);
    expect(await redeemRecoveryCode(appRole.db, userA, hashToken("h1"))).toBe(false);
    expect(await countUnusedRecoveryCodes(appRole.db, userA)).toBe(2);
    // `count(*)::int` — a number, not the string node-postgres returns for a bare bigint.
    expect(typeof (await countUnusedRecoveryCodes(appRole.db, userA))).toBe("number");
  });

  it("a recovery code belonging to ANOTHER user is refused", async () => {
    // `code_hash` is unique only WITHIN a user, so the `userId` predicate is what makes this true —
    // and the same value is deliberately given to both users to prove the predicate is doing it.
    await enrol(userA);
    await enrol(userB);
    await replaceRecoveryCodes(appRole.db, userA, [hashToken("shared")]);
    await replaceRecoveryCodes(appRole.db, userB, [hashToken("shared")]);
    expect(await redeemRecoveryCode(appRole.db, userA, hashToken("shared"))).toBe(true);
    // A's redemption must not have spent B's identically-hashed row.
    expect(await countUnusedRecoveryCodes(appRole.db, userB)).toBe(1);
  });

  /** THE RACE: two redemptions of the SAME code. Blind UPDATE + `used_at IS NULL` in the WHERE. */
  it("two concurrent redemptions of one recovery code produce EXACTLY ONE winner", async () => {
    await enrol(userA);
    await replaceRecoveryCodes(appRole.db, userA, [hashToken("only")]);
    let releaseTx1: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    let firstResult: boolean | undefined;
    const tx1 = appRole.db.transaction(async (tx) => {
      firstResult = await redeemRecoveryCode(tx, userA, hashToken("only"));
      await gate;
    });
    await new Promise((r) => setTimeout(r, 200));

    let tx2Settled = false;
    const tx2 = appRole.db
      .transaction((tx) => redeemRecoveryCode(tx, userA, hashToken("only")))
      .then((v) => {
        tx2Settled = true;
        return v;
      });

    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(tx2Settled, "tx2 must be BLOCKED on tx1's row lock").toBe(false);
    } finally {
      releaseTx1!();
      await tx1.catch(() => {});
    }
    expect(firstResult).toBe(true);
    expect(await tx2, "the loser must observe used_at and refuse").toBe(false);
    expect(await countUnusedRecoveryCodes(appRole.db, userA)).toBe(0);
  });

  /**
   * THE RACE: two regenerations. This is the ONE read-then-write decision in the repository, and the
   * mechanism is the `FOR UPDATE` lock on the `users` row — NOT the transaction.
   *
   * Remove `.for("update")` from `replaceRecoveryCodes` and this test fails: tx2 sails past the lock,
   * deletes tx1's uncommitted-then-committed rows or has its own deleted, and the surviving set is a
   * MIX of the two — a user holding a printed list that is partly dead, with no error anywhere.
   */
  it("a second replaceRecoveryCodes BLOCKS on the users-row lock, and the sets never mix", async () => {
    await enrol(userA);
    const first = ["a1", "a2", "a3"].map(hashToken);
    const second = ["b1", "b2", "b3"].map(hashToken);
    let releaseTx1: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    const tx1 = appRole.db.transaction(async (tx) => {
      await replaceRecoveryCodes(tx, userA, first);
      await gate; // HOLD the users-row lock
    });
    await new Promise((r) => setTimeout(r, 200));

    let tx2Settled = false;
    const tx2 = appRole.db
      .transaction((tx) => replaceRecoveryCodes(tx, userA, second))
      .then(
        () => {
          tx2Settled = true;
          return "resolved" as const;
        },
        () => {
          tx2Settled = true;
          return "rejected" as const;
        },
      );

    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(tx2Settled, "tx2 must be BLOCKED on tx1's users-row lock").toBe(false);
    } finally {
      releaseTx1!();
      await tx1.catch(() => {});
    }
    expect(await tx2).toBe("resolved");

    // THE ASSERTION THAT MATTERS: exactly one set survives, whole. Not four rows, not six.
    const rows = await owner.db.execute<{ h: string }>(
      sql`select code_hash as h from mfa_recovery_codes where user_id = ${userA}`,
    );
    const hashes = rows.rows.map((r) => r.h).sort();
    expect(hashes).toHaveLength(3);
    expect(hashes).toEqual([...second].sort());
  });

  // ── the throttle ──────────────────────────────────────────────────────────────────────────

  /**
   * THE RACE: two concurrent failures. The mechanism is an ATOMIC INCREMENT EXPRESSION — Postgres
   * evaluates `failed_attempts + 1` against the OLD row inside the row's own lock — so both land.
   *
   * A read-then-write version (`SELECT`, then `SET failed_attempts = $n`) would LOSE one of them, and
   * losing failures is exactly how a throttle stops throttling under the parallel attack it exists to
   * stop.
   *
   * THE BLOCKING PRELUDE IS WHAT MAKES THIS TEST ABLE TO FAIL, and it was added after the obvious
   * version — a bare `Promise.all` of two calls — PASSED against a deliberately broken read-then-write
   * implementation. That is CLAUDE.md's 15.5 lesson exactly: two unsynchronised calls on a pool
   * serialise on their own at that granularity (the second's SELECT lands after the first's UPDATE has
   * committed), so the test could not discriminate and was advertising a guarantee nobody had checked.
   *
   * Holding a `FOR UPDATE` lock on the row while both calls are issued fixes that DETERMINISTICALLY,
   * because it separates the two implementations at the point where they differ:
   *   - correct   → each call is ONE statement, so both block on the lock, then run in series against
   *                 the live row: 0→1 and 1→2. Results {1,2}.
   *   - broken    → `SELECT` takes no lock, so BOTH reads complete immediately and both see 0; only
   *                 the writes block, and both then write the literal 1. Results {1,1}.
   * Verified in both directions before this comment was written.
   */
  it("two concurrent recordMfaFailure calls land as 2, never as 1", async () => {
    await enrol(userA);
    let releaseLock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = appRole.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from totp_credentials where user_id = ${userA} for update`);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 200));

    const both = Promise.all([
      recordMfaFailure(appRole.db, userA, 10, 60_000),
      recordMfaFailure(appRole.db, userA, 10, 60_000),
    ]);
    // Both calls are now issued and (correctly) queued on the lock. Release in a `finally` so a
    // failure cannot leave the transaction holding a pooled connection — the 15.5 "one real failure
    // wearing five fake ones" shape.
    try {
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      releaseLock!();
      await holder.catch(() => {});
    }
    const results = await both;
    expect(results.map((r) => r!.failedAttempts).sort()).toEqual([1, 2]);
    // And the row agrees — the returned values are not two views of one lost update.
    expect((await findTotpCredential(appRole.db, userA))!.failedAttempts).toBe(2);
  });

  it("reaching the threshold stamps locked_until and RESETS the counter", async () => {
    await enrol(userA);
    let last: { failedAttempts: number; lockedUntil: Date | null } | undefined;
    for (let i = 0; i < 3; i++) last = await recordMfaFailure(appRole.db, userA, 3, 60_000);
    // Reset, so the next window starts from zero rather than re-locking on the first attempt after
    // expiry.
    expect(last!.failedAttempts).toBe(0);
    expect(last!.lockedUntil).toBeInstanceOf(Date);
    expect(last!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a SUCCESS clears the counter and the lock", async () => {
    await enrol(userA, 100);
    await recordMfaFailure(appRole.db, userA, 3, 60_000);
    await recordMfaFailure(appRole.db, userA, 3, 60_000);
    expect(await recordTotpUse(appRole.db, userA, 101)).toBe(true);
    const cred = await findTotpCredential(appRole.db, userA);
    expect(cred!.failedAttempts).toBe(0);
    expect(cred!.lockedUntil).toBeNull();
  });

  it("recordMfaFailure on a user with no credential returns undefined, never throws", async () => {
    expect(await recordMfaFailure(appRole.db, userA, 10, 60_000)).toBeUndefined();
  });

  // ── teardown ──────────────────────────────────────────────────────────────────────────────

  it("clearMfa removes the credential AND every recovery code, for that user only", async () => {
    await enrol(userA);
    await enrol(userB);
    await replaceRecoveryCodes(appRole.db, userA, ["a1", "a2"].map(hashToken));
    await replaceRecoveryCodes(appRole.db, userB, ["b1", "b2"].map(hashToken));

    await clearMfa(appRole.db, userA);
    expect(await findTotpCredential(appRole.db, userA)).toBeUndefined();
    expect(await countUnusedRecoveryCodes(appRole.db, userA)).toBe(0);
    // Orphaned codes would be silently inherited by a later re-enrolment — the reason the delete is
    // paired with the credential rather than left to a separate call.
    const orphans = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from mfa_recovery_codes where user_id = ${userA}`,
    );
    expect(orphans.rows[0]!.n).toBe(0);
    // B is untouched.
    expect(await findTotpCredential(appRole.db, userB)).toBeDefined();
    expect(await countUnusedRecoveryCodes(appRole.db, userB)).toBe(2);
  });
});
