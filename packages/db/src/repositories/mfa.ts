import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { mfaRecoveryCodes, totpCredentials, users } from "../schema.js";
import { decryptField, encryptField } from "../crypto.js";

/**
 * M15 15.8 — the TOTP credential + recovery-code surface behind `POST /v1/auth/mfa/*` (D-M15-5).
 *
 * Structurally the twin of `repositories/sso-identities.ts`: silent library (CLAUDE.md) — returns
 * `undefined`/`boolean`/a count for the ordinary outcomes and throws exactly one typed error, never
 * logs.
 *
 * BOTH TABLES ARE IDENTITY TABLES with no `org_id` and no RLS policy (D-15.8-13), exactly as
 * `sessions` and `sso_identities` are, so no function below takes an `orgId`. Where scoping is
 * needed it is `userId`, and it is always the SECOND parameter for the same reason `orgId` is
 * elsewhere: a transposed argument between two adjacent `string` params must be visible in review.
 *
 * THE SECRET IS DECRYPTED HERE AND NOWHERE ELSE. `findTotpCredential` returns a plaintext `Buffer`,
 * so the `encryptField` trio never leaves this file and no route can accidentally hold, log or
 * serialise a ciphertext/IV/tag. Recovery codes travel the other way — this file only ever sees
 * their sha256 (`hashToken` is applied by the caller, so the plaintext never enters `packages/db`).
 *
 * CONCURRENCY, WITH THE MECHANISM NAMED IN EVERY CASE (CLAUDE.md 15.5 — never "it's in a
 * transaction"). There are exactly three shapes in this file:
 *
 *   1. BLIND UPDATE, whole predicate in the WHERE — `confirmTotp`, `recordTotpUse`,
 *      `redeemRecoveryCode`. No read-then-write window exists at all. A blocked transaction
 *      re-evaluates the predicate after the lock releases (EvalPlanQual), so a row the winner
 *      mutated drops out of the loser's result set and `returning()` comes back EMPTY. Exactly one
 *      caller wins, and the emptiness IS the signal. Measured with two hand-held transactions in
 *      `mfa.int.test.ts`, not theorised.
 *   2. ATOMIC INCREMENT EXPRESSION — `recordMfaFailure`. The new value is computed by Postgres from
 *      the old row inside one statement, so two concurrent failures land as 2, never as 1.
 *   3. A `FOR UPDATE` LOCK — `replaceRecoveryCodes` and `clearMfa`, the only read-then-write /
 *      multi-statement decisions here. `SELECT` takes no locks, so without it two concurrent
 *      regenerations interleave into a MIXED set of codes and the user's printed list is wrong.
 */

/**
 * The ONE exceptional condition in this repository. Everything else is an `undefined`/boolean a
 * route turns into a status code; these are different because the caller must be able to say WHY,
 * and "you already have a working authenticator" is not something a boolean conveys.
 *
 * Mirrors `SsoIdentityError`/`MemberError`. `app.ts` maps `locked` to 429 and the other two to 409.
 */
export class MfaError extends Error {
  constructor(
    message: string,
    readonly reason: "already_enrolled" | "not_enrolled" | "locked",
  ) {
    super(message);
    this.name = "MfaError";
  }
}

/** The decrypted credential. NOT a wire shape — `secret` must never reach `reply.send()`. */
export interface TotpCredential {
  secret: Buffer;
  confirmedAt: Date | null;
  lastStep: number | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Explicit column list (CLAUDE.md 15.1). These rows do NOT reach the wire, but the list is still
 * explicit for the second half of that rule: it stops `TotpCredential` from lying about the runtime
 * shape the day a column is added.
 */
const totpCredentialColumns = {
  secretCiphertext: totpCredentials.secretCiphertext,
  secretIv: totpCredentials.secretIv,
  secretTag: totpCredentials.secretTag,
  confirmedAt: totpCredentials.confirmedAt,
  lastStep: totpCredentials.lastStep,
  failedAttempts: totpCredentials.failedAttempts,
  lockedUntil: totpCredentials.lockedUntil,
};

/**
 * Resolve a user's TOTP credential, DECRYPTED, or `undefined` when they have none.
 *
 * The caller must still check `confirmedAt` — an unconfirmed row exists but gates nothing
 * (D-15.8-10). This function deliberately does NOT filter on it: `POST /v1/auth/mfa/enroll/confirm`
 * needs precisely the unconfirmed secret, and a filtered read would force a second function whose
 * only difference is which half of the two-phase enrolment it serves.
 *
 * `decryptField` THROWS on a tampered ciphertext or a missing key (AES-256-GCM auth tag), and that
 * is deliberately not caught here: a credential we cannot decrypt is an operator problem
 * (`ARCHIVE_ENCRYPTION_KEY` rotated away without running `reencryptAll`), and swallowing it would
 * silently disable MFA for that user — which is exactly the class of failure D-15.8-6 exists to
 * prevent. It surfaces as a 500 the operator can act on.
 */
export async function findTotpCredential(
  db: DbClient,
  userId: string,
): Promise<TotpCredential | undefined> {
  const [row] = await db
    .select(totpCredentialColumns)
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1);
  if (!row) return undefined;
  return {
    secret: Buffer.from(
      decryptField({ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag }),
      "base64",
    ),
    confirmedAt: row.confirmedAt,
    lastStep: row.lastStep,
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
  };
}

/**
 * Store an UNCONFIRMED secret for a user, replacing any previous unconfirmed one (D-15.8-10).
 *
 * Throws `already_enrolled` when the user already has a CONFIRMED credential. That refusal is a
 * security property, not tidiness: silently rotating a working second factor from a session that
 * has not re-proved anything is a takeover primitive — steal a session cookie, re-enrol, and the
 * victim's authenticator stops working while yours starts. Disabling first (which requires a live
 * code, D-15.8-12) is the supported path.
 *
 * THE MECHANISM IS `setWhere`, NOT A READ (the `linkSsoIdentity` lesson, applied on purpose). A
 * `SELECT` guard followed by an upsert would let two concurrent enrolments both pass the read, and
 * the loser's unguarded `DO UPDATE` would overwrite a secret the winner had already confirmed. With
 * `setWhere: isNull(confirmedAt)` the update fires only against an unconfirmed row; otherwise it
 * matches nothing, `returning()` comes back EMPTY, and that emptiness is the conflict signal. One
 * statement, no lock, no retry — Postgres resolves it at the primary key.
 *
 * The reset of `last_step`/`failed_attempts`/`locked_until` is part of the same statement: a NEW
 * secret has a new step timeline, and carrying a stale `last_step` forward would refuse the user's
 * first genuine code from a lower step.
 */
export async function upsertUnconfirmedTotp(
  db: DbClient,
  userId: string,
  secret: Buffer,
): Promise<void> {
  // base64 rather than utf8: `encryptField` takes a string, and a raw 20-byte buffer is not valid
  // UTF-8. `findTotpCredential` decodes with the same encoding — the pair is the whole contract.
  const enc = encryptField(secret.toString("base64"));
  const values = {
    secretCiphertext: enc.ciphertext,
    secretIv: enc.iv,
    secretTag: enc.tag,
    lastStep: null,
    failedAttempts: 0,
    lockedUntil: null,
  };
  const rows = await db
    .insert(totpCredentials)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: totpCredentials.userId,
      set: values,
      // The whole guard. Without it a confirmed credential is silently replaced.
      setWhere: isNull(totpCredentials.confirmedAt),
    })
    .returning({ userId: totpCredentials.userId });
  if (rows.length === 0) {
    // `setWhere` matched nothing ⇒ the row exists AND is confirmed. This cannot be confused with
    // "the insert affected nothing" — an unconflicted insert always returns its row.
    throw new MfaError("two-factor authentication is already enabled", "already_enrolled");
  }
}

/**
 * Confirm the pending credential, stamping the step the confirming code matched so that same code
 * cannot immediately be replayed at login (RFC 6238 §5.2 / D-15.8-8). Returns false when there is
 * no unconfirmed row — an already-confirmed credential, or none at all.
 *
 * BLIND UPDATE (shape 1 in the header): `confirmed_at IS NULL` lives in the WHERE, so two
 * concurrent confirms cannot both succeed and the loser sees an empty `returning()`.
 *
 * `new Date()` and not Postgres `now()`, matching `sessions.ts`: every timestamp this slice compares
 * — `locked_until`, the challenge `exp`, the session `expires_at` — is written and read against the
 * APP clock, so mixing in the database clock would introduce exactly the skew that discipline
 * exists to remove.
 */
export async function confirmTotp(db: DbClient, userId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(totpCredentials)
    .set({ confirmedAt: new Date(), lastStep: step, failedAttempts: 0, lockedUntil: null })
    .where(and(eq(totpCredentials.userId, userId), isNull(totpCredentials.confirmedAt)))
    .returning({ userId: totpCredentials.userId });
  return rows.length > 0;
}

/**
 * Record a SUCCESSFUL TOTP use at `step`, and refuse a REPLAY. Returns false when this step (or a
 * later one) has already been spent — the caller treats that exactly as a wrong code (D-15.8-8).
 *
 * BLIND UPDATE, whole predicate in the WHERE (shape 1). `last_step IS NULL OR last_step < $step` is
 * monotonic, so a code accepted at step N is never accepted again, and the ±1-step skew window
 * cannot be used to re-spend the previous step's code either. Two concurrent verifies presenting the
 * SAME code both attempt the update; one wins, the loser re-evaluates under EvalPlanQual, finds
 * `last_step = N`, matches nothing, and returns false. No lock, no retry.
 *
 * `confirmed_at IS NOT NULL` is deliberately NOT in this predicate: the caller has already refused
 * an unconfirmed credential (it must, because an unconfirmed one gates nothing), and duplicating the
 * check here would imply this function is safe to call without that gate. It is not — it is the
 * WRITE half of a decision made above it.
 */
export async function recordTotpUse(db: DbClient, userId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(totpCredentials)
    .set({ lastStep: step, failedAttempts: 0, lockedUntil: null })
    .where(
      and(
        eq(totpCredentials.userId, userId),
        sql`(${totpCredentials.lastStep} is null or ${totpCredentials.lastStep} < ${step})`,
      ),
    )
    .returning({ userId: totpCredentials.userId });
  return rows.length > 0;
}

/**
 * Count one failed second-factor attempt, and lock the credential when the threshold is reached
 * (RFC 4226 §7.3 / D-15.8-9). Returns the post-write state, or `undefined` if there is no row.
 *
 * ATOMIC INCREMENT EXPRESSION (shape 2 in the header), and this is why it is one statement rather
 * than a read followed by a write. Postgres evaluates every SET right-hand side against the OLD row,
 * so `failed_attempts + 1` is computed inside the row's own lock: two concurrent failures land as 2.
 * A `SELECT` then `UPDATE … SET failed_attempts = $n` would lose one of them, and losing failures is
 * precisely how a throttle stops throttling under the parallel attack it exists to stop.
 *
 * On reaching `maxAttempts` the counter RESETS and `locked_until` is stamped, so the next window
 * starts from zero rather than locking again on the very first attempt after expiry.
 */
export async function recordMfaFailure(
  db: DbClient,
  userId: string,
  maxAttempts: number,
  lockMs: number,
): Promise<{ failedAttempts: number; lockedUntil: Date | null } | undefined> {
  const lockedUntil = new Date(Date.now() + lockMs);
  const reached = sql`${totpCredentials.failedAttempts} + 1 >= ${maxAttempts}`;
  const [row] = await db
    .update(totpCredentials)
    .set({
      failedAttempts: sql`case when ${reached} then 0 else ${totpCredentials.failedAttempts} + 1 end`,
      lockedUntil: sql`case when ${reached} then ${lockedUntil}::timestamptz else ${totpCredentials.lockedUntil} end`,
    })
    .where(eq(totpCredentials.userId, userId))
    .returning({
      failedAttempts: totpCredentials.failedAttempts,
      lockedUntil: totpCredentials.lockedUntil,
    });
  return row;
}

/**
 * Remove a user's second factor entirely: the credential AND every recovery code.
 *
 * THE MECHANISM IS THE `FOR UPDATE` LOCK ON THE `users` ROW (shape 3), not the transaction. Two
 * statements need atomicity — a credential deleted with codes left behind would have a later
 * re-enrolment silently inherit the old recovery codes — and the transaction gives that. But the
 * lock is what serialises this against a concurrent `replaceRecoveryCodes`, which locks the same
 * row: without it, a regeneration committing between these two DELETEs would leave orphaned codes
 * for a credential that no longer exists.
 *
 * Takes a `DbClient` so the route can compose it with `revokeAllSessions` in ONE transaction; it
 * opens its own (a SAVEPOINT when handed a `Tx`) so a standalone caller is atomic too, exactly as
 * `unlinkSsoIdentity` does.
 */
export async function clearMfa(db: DbClient, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
  });
}

/**
 * Replace a user's recovery codes with exactly `hashes` — the only way the set ever changes.
 *
 * THE MECHANISM IS THE `FOR UPDATE` LOCK ON THE `users` ROW, and it is the SAME lock
 * `createPasswordReset` takes for the same class of reason (`password-resets.ts:57-59`). This is the
 * one genuine read-then-write decision in the file: "delete what is there, then insert ten". A
 * shared transaction gives ATOMICITY but not ISOLATION (CLAUDE.md 15.5) — under READ COMMITTED two
 * concurrent regenerations would each delete the other's freshly-inserted rows and the user would be
 * left holding a printed list that is partly or wholly dead, with no error anywhere. With the lock
 * the second blocks, then runs its delete against the first's committed set and inserts its own; the
 * loser's printed list is the live one and the winner's is entirely gone, which is the only outcome
 * a user can reason about.
 *
 * Note there is no `used_at IS NULL` filter on the DELETE, deliberately: regenerating means "the old
 * set no longer exists", and keeping spent rows around would make `countUnusedRecoveryCodes` correct
 * but the table unbounded for no reader.
 */
export async function replaceRecoveryCodes(
  db: DbClient,
  userId: string,
  hashes: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    if (hashes.length > 0) {
      await tx.insert(mfaRecoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
    }
  });
}

/**
 * Spend ONE recovery code. Returns false when the presented hash is unknown to this user or already
 * used — collapsed into one answer on purpose, because the route answers the same generic 401 for
 * both and distinguishing them would tell an attacker which of their guesses existed.
 *
 * BLIND UPDATE, whole predicate in the WHERE (shape 1). `used_at IS NULL` in the predicate is what
 * makes single-use real: two concurrent redemptions of the same code both attempt the stamp, one
 * wins, and the loser re-evaluates under EvalPlanQual, matches nothing, and returns false. Measured
 * with two hand-held transactions during planning (SPIKE 3) and pinned in `mfa.int.test.ts`.
 *
 * The `userId` predicate is not redundant with the hash: `code_hash` alone is unique only WITHIN a
 * user (`mfa_recovery_codes_user_hash`), and a lookup keyed on a caller-supplied string without an
 * owner predicate is exactly the cross-tenant merge CLAUDE.md's 15.2 rule describes.
 */
export async function redeemRecoveryCode(
  db: DbClient,
  userId: string,
  hash: string,
): Promise<boolean> {
  const rows = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, hash),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return rows.length > 0;
}

/**
 * How many of a user's recovery codes are still spendable — the number the Settings card shows.
 *
 * `count(*)::int`, never a bare `count(*)`: Postgres `count` is `bigint` and node-postgres returns
 * `int8` as a JavaScript STRING (CLAUDE.md). The `::int` cast makes it arrive as a number, so
 * `remaining === 0` means what it appears to.
 */
export async function countUnusedRecoveryCodes(db: DbClient, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return row?.n ?? 0;
}
