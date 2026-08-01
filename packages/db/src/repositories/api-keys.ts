import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { apiKeys } from "../schema.js";
import { API_KEY_PREFIX, generateToken, hashToken } from "../tokens.js";

/**
 * M15 15.9 — named, hashed, revocable, per-user API KEYS (D-M15-7). The mint/look-up/revoke surface
 * behind the third credential tier, and the one that lets `ADMIN_TOKEN` be retired.
 *
 * Structurally the twin of `repositories/sessions.ts` — same silent-library discipline, same
 * `DbClient` parameter so a caller can pass a `Tx`, same `undefined`/`false`/count returns and no
 * typed error — with two deliberate differences:
 *
 *   1. THERE IS a `token_hash` (D-15.9-2), unlike `sessions`. A session's credential is the HMAC
 *      over its payload, so its `id` is a lookup key rather than a secret. An API key's plaintext
 *      IS the whole credential, exactly as `password_reset_tokens` / `ingest_tokens` / `invites`
 *      hold one — so only its sha256 is stored, and the plaintext is returned EXACTLY ONCE from
 *      `createApiKey` and is unrecoverable thereafter.
 *   2. THERE IS a `last_used_at`, which `sessions` deliberately omits. See `touchApiKeyLastUsed`.
 *
 * `api_keys` is an IDENTITY table with no `org_id` and no RLS policy (D-15.9-1), so no function
 * below takes an `orgId`. Where scoping is needed it is `userId`, and it is always the SECOND
 * parameter for the same reason `orgId` is elsewhere: a transposed argument between two adjacent
 * `string` params must be visible in review.
 */

/**
 * Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). NO `token_hash`: no
 * route declares a Fastify `response` schema, so nothing strips extra properties and a bare
 * `select()` would put the credential's hash on the wire.
 */
const apiKeyRowColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  role: apiKeys.role,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  createdAt: apiKeys.createdAt,
};

export interface ApiKeyRow {
  id: string;
  name: string;
  /** null = "inherit the owner's membership role exactly" (D-15.9-4). */
  role: string | null;
  lastUsedAt: Date | null;
  /** null = never expires (D-15.9-8). */
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Mint a key. The plaintext is returned ONCE and never stored — only its sha256 is persisted, so
 * this return value is the ONLY moment the credential exists outside the caller's client.
 *
 * `role` is optional and means "inherit the owner's membership role" when omitted. It is NOT
 * validated here: this is a silent library, and the CEILING (you may not mint above your own rung)
 * is a route-layer authorization decision that needs the caller's principal, which the repository
 * does not have. `resolvePrincipal` independently rejects a stored role outside `ROLES`, so a
 * hand-edited row fails closed regardless of how it got there.
 */
export async function createApiKey(
  db: DbClient,
  userId: string,
  opts: { name: string; role?: string | null; expiresAt?: Date | null },
): Promise<{ key: ApiKeyRow; token: string }> {
  const token = API_KEY_PREFIX + generateToken();
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: opts.name,
      // The WHOLE composed token is hashed, prefix included (D-15.9-3) — so the lookup below
      // hashes the whole presented bearer too, and there is nothing to strip on either side.
      tokenHash: hashToken(token),
      role: opts.role ?? null,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning(apiKeyRowColumns);
  // No `!`: a single-row `INSERT ... RETURNING` always yields one row, and drizzle types it
  // non-optional here. An assertion would read as a suppressed check that is not being made.
  return { key, token };
}

/**
 * Resolve a presented bearer token to its live key by hash lookup, or `undefined` when it is
 * unknown, revoked or expired. THE hot path for a machine client — one indexed probe on the unique
 * `token_hash`, mirroring `findMachineIdByToken`.
 *
 * M15 15.9 AUTH BOUNDARY — deliberately org-AGNOSTIC. This read happens BEFORE any org context
 * exists; it is part of what establishes the context. Do not scope it by org (D-15.9-1).
 *
 * The three rejection reasons collapse into one `undefined` ON PURPOSE, exactly as `findLiveSession`
 * collapses its three: the caller (`resolvePrincipal`) answers 401 for all of them, and
 * distinguishing them at the API would tell an attacker whether a guessed value exists.
 */
export async function findLiveApiKey(
  db: DbClient,
  token: string,
): Promise<{ id: string; userId: string; role: string | null } | undefined> {
  const [row] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, role: apiKeys.role })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tokenHash, hashToken(token)),
        isNull(apiKeys.revokedAt),
        // App clock, matching `findLiveSession` — see the comment there for why not `now()`.
        //
        // `expires_at IS NULL` means "never expires" (D-15.9-8), so this MUST be an OR and not a
        // bare `gt`. A bare `gt` evaluates to NULL for every never-expiring key, which drops it
        // from the result set — every such key would 401 and the failure would present as "API
        // keys don't work at all". Pinned by a regression test in api-keys.int.test.ts.
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Probe a key id for liveness WITHOUT touching `last_used_at`. Exists for the SSE stream's per-tick
 * re-check (`routes/monitor.ts`), which must not become a per-tick WRITE per connected client —
 * that is precisely the audit-B.4 shape 15.4 had to throttle back out.
 *
 * A separate function rather than a flag on `findLiveApiKey`, for the reason
 * `findLiveSessionCreatedAt` is separate: the hot path stays one shape, and a caller cannot pass
 * the flag the wrong way round.
 */
export async function isApiKeyLive(db: DbClient, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, id),
        isNull(apiKeys.revokedAt),
        // App clock + the NULL-means-never rule, matching `findLiveApiKey` exactly. These two
        // predicates are the definition of "live" and must not drift between the connect-time
        // check and the per-tick re-check — a re-check that is laxer than the original gate is
        // the same hole 15.6 closed for sessions.
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Stamp `last_used_at`. Called FIRE-AND-FORGET from `resolvePrincipal` and THROTTLED IN PROCESS by
 * the caller (`API_KEY_TOUCH_THROTTLE_MS`), never on every request.
 *
 * WHY THE COLUMN EXISTS HERE AND NOT ON `sessions`. That table's comment gives the reason it has
 * none: touching it puts a WRITE on every authenticated read. That reasoning is not weaker here —
 * it is exactly why the write is throttled and unawaited rather than why the column is absent.
 * Without it, "is this key still in use?" is unanswerable and every revocation is a guess; the
 * throttle is what stops the desktop app's monitor poll writing on every tick.
 *
 * Deliberately NOT scoped by `userId`: the caller has already resolved this id from a presented
 * secret, so there is nothing to authorize. It is a bookkeeping write about the key that just
 * authenticated, not an action on a user-supplied id.
 */
export async function touchApiKeyLastUsed(db: DbClient, id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

/** List a user's LIVE keys, newest first. Explicit columns; rows reach the wire. */
export async function listApiKeys(db: DbClient, userId: string): Promise<ApiKeyRow[]> {
  return db
    .select(apiKeyRowColumns)
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt),
        // App clock + NULL-means-never, matching `findLiveApiKey`. An expired key is not listed
        // because it cannot authenticate — listing it would invite "revoking" something that is
        // already inert and make the list a poor answer to "what can reach my data?".
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revoke ONE key, scoped to its owner. Returns false when the id is unknown, already revoked, or
 * belongs to somebody else — collapsed so the route can answer 404 for all three (a 403 would be an
 * enumeration oracle telling a caller that an id they guessed exists).
 *
 * `userId` is the second parameter and is NOT optional — the `revokeSession` rule. Without it any
 * authenticated caller could revoke any key id they could guess, and the route has no other
 * ownership check.
 */
export async function revokeApiKey(db: DbClient, userId: string, id: string): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/**
 * Revoke every live key for a user. Called on MEMBER REMOVAL (D-15.9-9), inside the same
 * transaction as `revokeAllSessions` — "remove an employee, sign them out" is strictly STRONGER for
 * a key, which has no expiry to save you. Deliberately NOT called on a password change: a key is
 * not derived from the password, and revoking on a routine rotation would silently break the
 * desktop app and every scheduled script, which is a worse outcome than the threat it addresses.
 *
 * Both halves carry the 15.10 revisit note `revokeAllSessions` already carries: multi-org
 * membership inverts the reasoning, because removing someone from ONE org would then revoke a key
 * they legitimately use against another.
 *
 * IDEMPOTENT by construction: the `revoked_at IS NULL` predicate means a second call updates zero
 * rows rather than re-stamping, so the returned count is "how many were live", not "how many exist".
 *
 * NAME THE RACE THIS EXCLUDES, because it does not exclude all of them (CLAUDE.md 15.5: "name the
 * mechanism — a lock, a unique index, or an isolation level"; "it's in a transaction" almost never
 * is):
 *
 *   EXCLUDED — revoke vs revoke. This is a blind UPDATE with its whole predicate in the WHERE
 *   clause, so there is no read-then-write window. A blocked transaction re-evaluates
 *   `revoked_at IS NULL` after the lock releases (EvalPlanQual) and correctly counts zero.
 *
 *   NOT EXCLUDED — revoke vs INSERT. An UPDATE cannot see a row a concurrent transaction has not
 *   inserted yet, so a mint racing a member removal could create a key this revoke runs straight
 *   past. Nothing in THIS function can fix that. Unlike the session case it is not closed at the
 *   other end either — but the exposure is bounded differently: the racing key's owner has just
 *   lost their membership, so `findPrincipalByEmail` resolves no principal on the very next
 *   request and the survivor authenticates as nobody (401). The row is orphaned, not usable.
 */
export async function revokeAllApiKeys(db: DbClient, userId: string): Promise<number> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length;
}
