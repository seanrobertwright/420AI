import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { sessions } from "../schema.js";

/**
 * M15 15.6 — STATEFUL sessions (D-M15-12). The mint/look-up/revoke surface behind the `sid` claim
 * that `apps/ingest/src/session.ts` now carries.
 *
 * Structurally the twin of `repositories/password-resets.ts` — same silent-library discipline, same
 * `DbClient` parameter so a caller can pass a `Tx` — with two deliberate differences:
 *
 *   1. NO `token_hash` (D-15.6-2). `password_reset_tokens` stores only a hash because the plaintext
 *      token IS the whole credential. A session's credential is the HMAC over the payload, which
 *      requires `SESSION_SECRET` to produce; the `id` here is a LOOKUP KEY, not a secret. Hashing it
 *      would buy nothing while implying a protection that is not there.
 *   2. NO typed error. A revoked session is not an exceptional condition — it is a `null` principal
 *      and a 401, exactly as an expired one already is. Everything here returns `undefined` /
 *      `false` / a count instead.
 *
 * `sessions` is an IDENTITY table with no `org_id` and no RLS policy (D-15.6-3), so no function
 * below takes an `orgId`. Where scoping is needed it is `userId`, and it is always the SECOND
 * parameter for the same reason `orgId` is elsewhere: a transposed argument between two adjacent
 * `string` params must be visible in review.
 */

/** Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). */
const sessionRowColumns = {
  id: sessions.id,
  createdAt: sessions.createdAt,
  expiresAt: sessions.expiresAt,
  userAgent: sessions.userAgent,
};

export interface SessionRow {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
}

/** Mint a session row; the caller signs a token carrying the returned id as its `sid`. */
export async function createSession(
  db: DbClient,
  userId: string,
  expiresAt: Date,
  userAgent?: string | null,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt, userAgent: userAgent ?? null })
    .returning({ id: sessions.id });
  // No `!`: a single-row `INSERT … RETURNING` always yields one row, and drizzle types it
  // non-optional here. An assertion would read as a suppressed check that is not being made.
  return row;
}

/**
 * Resolve a session id to its owner, or `undefined` when it is unknown, revoked or expired.
 * THE hot path — one primary-key probe on every authenticated request.
 *
 * The three rejection reasons collapse into one `undefined` ON PURPOSE: the caller
 * (`resolvePrincipal`) answers 401 for all of them, and distinguishing them at the API would
 * tell an attacker whether a guessed id exists.
 */
export async function findLiveSession(
  db: DbClient,
  sessionId: string,
): Promise<{ userId: string } | undefined> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        // Compared against the APP clock, deliberately — and an earlier version of this comment
        // had the reasoning exactly backwards, claiming `now()` avoided clock skew when it was the
        // thing INTRODUCING it. `expires_at` is written from `Date.now()` (see `mintSession`) and
        // the token's `exp` is checked against `Date.now()` by `verifySession`, so comparing the
        // stored value against Postgres `now()` was the ONE place the two clocks met. A database
        // running ahead would expire the row before the token — a 401 with no explanation, which is
        // precisely what deriving both from one TTL is supposed to prevent. App clock on both sides
        // keeps the row and the token agreeing exactly.
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Revoke ONE session, scoped to its owner. Returns false when the id is unknown, already
 * revoked, or belongs to somebody else.
 *
 * `userId` is the second parameter and is NOT optional — the same discipline `orgId` follows
 * elsewhere. Without it any authenticated caller could revoke any session id they could guess,
 * and the route has no other ownership check.
 */
export async function revokeSession(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length > 0;
}

/**
 * Revoke every live session for a user, optionally sparing one (the caller's own).
 *
 * IDEMPOTENT by construction: the `revoked_at IS NULL` predicate means a second call updates
 * zero rows rather than re-stamping, so the returned count is "how many were live", not "how
 * many exist" — verified against the live test DB during planning.
 *
 * NAME THE RACE THIS EXCLUDES, because it does not exclude all of them (CLAUDE.md 15.5: "name the
 * mechanism — a lock, a unique index, or an isolation level"):
 *
 *   EXCLUDED — revoke vs revoke. This is a blind UPDATE with its whole predicate in the WHERE
 *   clause, so there is no read-then-write window. A blocked transaction re-evaluates
 *   `revoked_at IS NULL` after the lock releases (EvalPlanQual) and correctly counts zero. No
 *   `FOR UPDATE` needed, unlike `createPasswordReset`, whose guard SELECTs first.
 *
 *   NOT EXCLUDED — revoke vs INSERT. An UPDATE cannot see a row a concurrent transaction has not
 *   inserted yet, so a login racing a credential change could mint a session this revoke runs
 *   straight past. Nothing in THIS function can fix that; it is closed at the other end, by the
 *   `FOR SHARE` lock the login path takes on the user row (see `findAdminCredential`). Measured,
 *   not theorised — it was reproducible at the HTTP layer before that lock existed.
 */
export async function revokeAllSessions(
  db: DbClient,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        // The `::uuid` cast is required — a bound parameter compared to a `uuid` column is
        // inferred as `text` and Postgres rejects the operator.
        ...(exceptSessionId ? [sql`${sessions.id} <> ${exceptSessionId}::uuid`] : []),
      ),
    )
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * M15 15.8 — when was this session established? Used by the ONE re-authentication gate that cannot
 * ask for a password: `POST /v1/auth/mfa/enroll` for an SSO-only account (`password_hash IS NULL`).
 *
 * A SEPARATE FUNCTION rather than a column added to `findLiveSession`, deliberately. `findLiveSession`
 * is THE hot path — one probe on every authenticated request — and this is needed on exactly one rare
 * route. Widening the hot path's return type to serve a cold caller is how a hot path accumulates
 * fields nobody can later prove are unused.
 *
 * `userId` is the second parameter and is NOT optional, for the reason the whole file states: without
 * it a caller could age-check a session id belonging to somebody else. Returns `undefined` when the
 * session is unknown, revoked, expired, or not this user's — collapsed, exactly as `findLiveSession`
 * collapses them, because the caller answers the same 401 for all four.
 */
export async function findLiveSessionCreatedAt(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<Date | undefined> {
  const [row] = await db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        // App clock, matching `findLiveSession` — see the comment there.
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row?.createdAt;
}

/** List a user's LIVE sessions, newest first. Explicit columns; rows reach the wire. */
export async function listSessions(db: DbClient, userId: string): Promise<SessionRow[]> {
  return db
    .select(sessionRowColumns)
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        // App clock, matching `findLiveSession` — see the comment there.
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.createdAt));
}
