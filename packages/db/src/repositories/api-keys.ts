import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DbClient, Tx } from "../client.js";
import { apiKeys, users } from "../schema.js";
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

/** Why a mint was refused. Both map to 409; the route sends the discriminant as `reason`. */
export type MintRefusal = "at_capacity" | "duplicate_name";

/**
 * Mint a key with BOTH guards applied — the per-user cap and the per-user live-name uniqueness.
 * The route calls this; `createApiKey` above stays the unguarded primitive that tests and the
 * bootstrap seeder use, so neither guard has to be bypassed with a flag.
 *
 * TYPED `Tx`, NOT `DbClient`, so "this runs in a transaction" is unrepresentable-if-false rather
 * than merely documented — the same discipline `consumeSecondFactor` uses. The count and the insert
 * MUST commit together or the cap is advisory.
 *
 * THE TWO GUARDS USE TWO DIFFERENT MECHANISMS, and each is named because "it's in a transaction"
 * is not one (CLAUDE.md 15.5):
 *
 *   CAP — an exclusive `SELECT … FOR UPDATE` on the OWNER'S `users` ROW. `SELECT count(*)` takes no
 *   locks, so under READ COMMITTED two concurrent mints would both read `n` and both insert,
 *   landing at `n + 2` over a cap of `n + 1`. Locking the *existing key rows* would not help — the
 *   race is two INSERTs, and an INSERT is invisible to a lock on rows that already exist. Locking
 *   the single `users` row is what serialises them: the second mint blocks until the first commits,
 *   then counts a state that already includes it. THIS CLOSES MINT vs MINT, AND NOTHING ELSE — an
 *   earlier version of this comment claimed it also closed the revoke-vs-INSERT gap
 *   `revokeAllApiKeys` documents, and that was false in the way CLAUDE.md 15.5 warns about: a
 *   concurrent revoke is a blind `UPDATE api_keys`, and `removeMember` touches `memberships`, so
 *   NEITHER ever requests a lock on this `users` row and neither can block on it. That gap stays
 *   open, exactly as `revokeAllApiKeys`'s own comment says it does — believe that one.
 *
 *   NAME — the `api_keys_user_live_name` PARTIAL UNIQUE INDEX (migration 0022). No read-then-write
 *   guard at all: the index refuses the second inserter at the storage layer. The `23505` is caught
 *   below and converted, because a unique violation escaping as a 500 would be a correctness bug
 *   wearing a server error.
 *
 * The name guard is deliberately NOT also done with a SELECT. Two mechanisms for one invariant is
 * how they drift; the index is the one that cannot be raced.
 */
export async function mintApiKey(
  tx: Tx,
  userId: string,
  opts: { name: string; role?: string | null; expiresAt?: Date | null },
  maxPerUser: number,
): Promise<{ ok: true; key: ApiKeyRow; token: string } | { ok: false; reason: MintRefusal }> {
  // The serialisation point. Discard the result — we want the LOCK, not the row.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1);

  const live = await countLiveApiKeys(tx, userId);
  if (live >= maxPerUser) return { ok: false, reason: "at_capacity" };

  // RECLAIM AN EXPIRED KEY'S NAME. Without this the slice shipped a dead end, reproduced against a
  // live database: the partial index is `WHERE revoked_at IS NULL` and CANNOT also test expiry — a
  // partial-index predicate must be IMMUTABLE and `now()` is only STABLE — while every other
  // definition of "live" here DOES exclude expired rows. So an expired-but-unrevoked key was
  // invisible to `listApiKeys`, consumed no cap slot, could not be revoked (the list never yields
  // its id) and still refused its own name with `duplicate_name`. That is exactly the day-91
  // "my `desktop` key expired, mint a new `desktop`" path, with no in-product remedy.
  //
  // Revoking it is honest rather than a workaround: the row is already inert — it cannot
  // authenticate, `isApiKeyLive` is false for it — so stamping `revoked_at` changes no capability
  // and simply makes the storage layer agree with every other predicate in this file.
  //
  // SAFE UNDER CONCURRENCY because it runs inside the `FOR UPDATE` critical section above: two
  // mints of the same name serialise, so the second sees the first's committed row and is correctly
  // refused by the index rather than reclaiming a name that is now live again.
  await tx
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.name, opts.name),
        isNull(apiKeys.revokedAt),
        // Strictly expired — never a live key. `IS NOT NULL` matters: a never-expiring key must
        // NOT be swept, or minting would silently revoke the working key it collides with.
        gt(sql`now()`, apiKeys.expiresAt),
      ),
    );

  try {
    const { key, token } = await createApiKey(tx, userId, opts);
    return { ok: true, key, token };
  } catch (err) {
    // 23505 = unique_violation. The ONLY unique constraints on this table are `token_hash` (a
    // 32-byte random collision — astronomically improbable, and a retry would be the wrong answer
    // anyway) and `api_keys_user_live_name`. Narrowed on the constraint NAME rather than on the
    // code alone, so a future constraint cannot be silently reported as a duplicate name.
    if (isUniqueViolation(err, "api_keys_user_live_name")) {
      return { ok: false, reason: "duplicate_name" };
    }
    throw err;
  }
}

/**
 * True when `err` is a Postgres unique violation (23505) on `constraint`.
 *
 * WALKS THE `cause` CHAIN, and that is not defensive padding — drizzle wraps driver errors in a
 * `DrizzleQueryError` whose `cause` is the pg error carrying `code`/`constraint`. A check on the
 * top-level object alone silently returns false, the 23505 escapes `mintApiKey`, and a duplicate
 * name surfaces as a **500** instead of a 409. Measured: the concurrency/duplicate test in
 * `api-keys.int.test.ts` failed exactly this way before the chain walk was added.
 *
 * Bounded to 5 hops so a self-referential `cause` cannot spin.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505" && e.constraint === constraint) return true;
    current = e.cause;
  }
  return false;
}

/**
 * How many LIVE keys this user holds — the cap's input. Live means the same thing it means
 * everywhere else in this file (not revoked, not expired), so an expired key does not consume a
 * slot the owner cannot see in `listApiKeys`.
 *
 * `count(*)::int`, and the cast is load-bearing for the TYPE, not for the comparison. Postgres
 * `count(*)` is `int8`, which node-postgres hands back as a JavaScript **string** (CLAUDE.md's
 * "numeric is a string" class). `live >= maxPerUser` would still give the right answer — a
 * relational operator coerces the string numerically — but the declared `sql<number>` would be a
 * lie, and every downstream use (arithmetic, `===`, JSON) would inherit a string that claims to be
 * a number. `::int` returns `int4`, which the driver parses as a real number, so the type and the
 * value agree.
 */
export async function countLiveApiKeys(db: DbClient, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    );
  return row?.n ?? 0;
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
 *
 * DELIBERATELY NOT FILTERED ON EXPIRY, unlike every other predicate in this file
 * (`findLiveApiKey` / `isApiKeyLive` / `listApiKeys` all add the `expires_at` clause). An EXPIRED
 * key is therefore invisible to `listApiKeys` and still revocable here — a real asymmetry, and the
 * intended one: a UI holding a slightly stale list should get an idempotent 204 when the user clicks
 * Revoke, not a 404 for a row it is still showing, and stamping `revoked_at` on an already-inert key
 * costs nothing and can only reduce the key's reachability.
 *
 * Stated because the next reader's instinct is to "align the four predicates", which would turn a
 * friendly 204 into a 404 regression on exactly the path an operator uses under time pressure.
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
 * Both halves carry the M20 revisit note `revokeAllSessions` already carries: multi-org
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
 *   lost their membership IN THAT ORG. The key path resolves via `findPrincipalByUserId` — NOT
 *   `findPrincipalByEmail`, which an earlier version of this comment named; that is the session
 *   path's resolver — and its `innerJoin memberships` fails closed for the org they left. State the
 *   residual honestly rather than claiming more: `ensurePersonalOrg` means the user usually still
 *   holds a PERSONAL-org membership, so the orphaned key may still resolve a principal there. That
 *   principal grants nothing in the org they were removed from, so this is not cross-tenant — but
 *   it is not "authenticates as nobody" either.
 */
export async function revokeAllApiKeys(db: DbClient, userId: string): Promise<number> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length;
}
