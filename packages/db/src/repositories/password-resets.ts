import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { passwordResetTokens } from "../schema.js";
import { generateToken, hashToken } from "../tokens.js";

/**
 * M15 15.5 — single-use password-reset tokens (D-M15-5). Same mint/redeem pair as
 * `repositories/pairing.ts`, with two deliberate differences:
 *
 *   1. `password_reset_tokens` is an IDENTITY table — no `org_id`, and therefore NO RLS policy at
 *      all (D-15.3-4 / D-15.5-1). It is read at the one moment before any identity, and hence any
 *      org context, is established. The explicit `token_hash` lookup IS the whole scoping.
 *   2. The TTL is ONE HOUR, not 15 minutes and not 7 days. A reset link travels by email: short
 *      enough to bound the exposure window of a leaked mailbox, long enough to survive a slow
 *      mail hop.
 *
 * Silent library (CLAUDE.md): throws typed errors, never logs. Only `hashToken(token)` is stored
 * (D-15.5-8) — the plaintext exists in the mail body and nowhere else.
 */

/** Thrown when a reset token is unknown, already consumed, or expired. */
export class PasswordResetError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown" | "consumed" | "expired",
  ) {
    super(message);
    this.name = "PasswordResetError";
  }
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Mint a reset token for a user; the plaintext is returned exactly once (D-15.5-8).
 *
 * ONE LIVE TOKEN PER USER, always: every outstanding unconsumed token is stamped consumed BEFORE the
 * new one is inserted. OWASP's Forgot-Password guidance requires it, and the 15.5 review measured
 * why it matters here specifically — without this, two reset requests left TWO rows usable for the
 * full hour, which multiplies the number of stale links the 1-hour TTL is the only bound on. A user
 * who requests twice, uses the second link, and later has the first scraped out of mail history
 * stays compromisable until that first token expires.
 *
 * The stamp and the insert are two statements; callers pass the pool handle, so they are not atomic
 * with each other. That is fine — the failure mode of a crash between them is ZERO live tokens (the
 * user re-requests), never two.
 */
export async function createPasswordReset(
  db: DbClient,
  userId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ token: string; expiresAt: Date }> {
  await db
    .update(passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)));

  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(passwordResetTokens).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

/**
 * Consume a reset token: validate + stamp `consumed_at`, returning the user it belongs to.
 *
 * MUST run in the SAME transaction as the caller's `updatePasswordHash`, which is why it takes a
 * `DbClient` (a `Tx`). Stamping in a separate transaction from the password write makes a leaked
 * token replayable in the window between them — and a reset token is a full account-takeover
 * primitive, so that window must not exist.
 */
export async function consumePasswordReset(
  tx: DbClient,
  token: string,
): Promise<{ userId: string }> {
  const [row] = await tx
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      consumedAt: passwordResetTokens.consumedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) throw new PasswordResetError("unknown reset token", "unknown");
  if (row.consumedAt) throw new PasswordResetError("reset token already used", "consumed");
  if (row.expiresAt.getTime() < Date.now()) {
    throw new PasswordResetError("reset token expired", "expired");
  }

  await tx
    .update(passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(eq(passwordResetTokens.id, row.id));

  return { userId: row.userId };
}
