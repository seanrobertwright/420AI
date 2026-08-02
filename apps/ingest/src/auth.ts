import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  API_KEY_PREFIX,
  findLiveApiKey,
  findLiveSession,
  findPrincipalByEmail,
  findPrincipalByUserId,
  touchApiKeyLastUsed,
  type Principal,
} from "@420ai/db";
import { hasRole, isRole, type Role } from "@420ai/shared";
import { verifySession } from "./session.js";

/**
 * Shared request-principal resolver + input guards for the ingest routes. Extracted so
 * the constant-time bearer check has ONE definition (it was copy-pasted across
 * pairing-codes / projects / workspaces routes).
 */

/** Extract a Bearer token from the Authorization header, or null if missing/malformed. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer (.+)$/.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * M15 15.2 — resolve the request's PRINCIPAL (user + org + role), or null when the
 * credential is absent/invalid. Replaces the 12.3 boolean `adminAuthorized`: the gate now
 * yields an identity instead of a yes/no, so a handler scopes to `principal.orgId` rather
 * than re-resolving the env admin.
 *
 * TWO credential paths, machine-first (a machine client never pays for an HMAC):
 *  (1) M15 15.9 — an API KEY (D-M15-7), routed by its `k420_` PREFIX so a session token never pays
 *      for a key lookup and a key never pays for an HMAC. Resolves to the KEY OWNER's principal, at
 *      the LOWER of (the key's own role, the owner's CURRENT membership role).
 *  (2) A 12.3 HMAC session token — `sub` is the user's EMAIL (routes/auth.ts signs it that
 *      way). 15.2 is where ingest finally READS that claim instead of discarding it.
 *
 * M15 15.9 (D-M15-7) DELETED A THIRD PATH: `ADMIN_TOKEN`, the bootstrap service token, which
 * resolved every holder to the same bootstrap-admin principal. It was shared, un-attributable,
 * un-revocable, un-expiring and always `owner` — so a scheduled reports script held full ownership
 * of the deployment, and revoking a leaked copy meant editing env and restarting the server, for
 * every client at once. The option is GONE from `buildApp` rather than left inert, because an
 * option that still exists but authenticates nothing is precisely the false guarantee this repo has
 * been burned by. The first-run bootstrap is unaffected: the initial owner is seeded from
 * `ADMIN_EMAIL`/`ADMIN_PASSWORD` (`server.ts`), which `ADMIN_TOKEN` never did.
 *
 * Returns null (⇒ the caller sends 401) when: no bearer, a bad MAC/expired session, or the
 * resolved email has no user OR no membership. An ownerless identity fails CLOSED — this is
 * the one BEHAVIORAL change vs `adminAuthorized`, which returned true for a validly-signed
 * token even when the user row had since been deleted.
 *
 * M15 15.6 (D-M15-12) — this is where revocation is ENFORCED FOR A REQUEST. Every authenticated
 * route funnels through here, so the `sessions` lookup added to branch (2) is what makes logout,
 * revoke-one, revoke-all, password-change and member-removal actually end a session.
 *
 * ONE EXCEPTION, and it is stated because an earlier version of this comment claimed there was
 * none — which was false, and a false claim here is worse than the gap it hid. `resolvePrincipal`
 * gates a request AT ITS START. A route that then holds the socket open serves data for as long as
 * the client keeps it, on the strength of a check that happened once. There is exactly one such
 * route, `GET /v1/monitor/stream` (it calls `reply.hijack()`); it reads `request.sessionId` once
 * before hijacking and then RE-CHECKS it with `findLiveSession` on every tick. See the comment
 * there. If a second hijacking route is ever added, it inherits that obligation — a
 * connect-time-only gate does not revoke. M15 15.9 EXTENDS that re-check to API keys: a key is
 * revocable, so the stream must probe `request.apiKeyId` on the same tick it probes `sessionId`.
 */
export async function resolvePrincipal(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;

  // (1) API KEY — M15 15.9. Routed by PREFIX, so a session token never pays for a key lookup and
  // a key never pays for an HMAC. `startsWith`, NEVER a split on `_`: base64url's alphabet INCLUDES
  // `_` and `-`, so a token BODY routinely contains underscores (measured across 200 samples during
  // planning). The whole composed token is hashed, prefix included, so there is nothing to strip.
  //
  // A full early return rather than a branch that falls through to the shared tail below: a key
  // resolves its principal by USER ID, not by email, so it has no `email` to hand the tail and no
  // `sessionUserId` cross-check to make. Interleaving it would mean two of the three locals below
  // being dead on this path.
  if (token.startsWith(API_KEY_PREFIX)) {
    return resolveApiKeyPrincipal(app, request, token);
  }

  let email: string | null = null;
  // The `sessions.user_id` behind branch (2)'s `sid`. Cross-checked against the resolved principal
  // below.
  let sessionUserId: string | null = null;
  // The `sid` itself, stashed on the request for the handlers that need it (logout, the
  // spare-my-own-session revoke, the `current` flag, the SSE per-tick re-check) so none of them
  // has to re-parse the bearer and re-verify the MAC a second time.
  let sid: string | null = null;
  // (2) Human session token — HMAC-signed, unexpired, AND NOT REVOKED (M15 15.6, D-M15-12).
  const payload = verifySession(token, app.sessionSecret);
  // A valid MAC is no longer sufficient. A token with no `sid` predates migration 0018 and is
  // REJECTED rather than grandfathered (D-15.6-5): a grace period would be a window in which
  // revocation silently does not apply, which is the one failure this slice exists to remove.
  // The cost is that everyone logs in once after the upgrade — stated in the operations guide.
  //
  // `isUuid` before the query, not a try/catch around it: `sessions.id` is a `uuid` column, so a
  // hand-forged non-uuid `sid` (only the secret-holder can forge one, but auth code stays
  // defensive) would raise Postgres `22P02` and surface as a 500. A guard keeps the repo-wide
  // "unknown/malformed id → 401, never a DB-cast 500" invariant, and costs a regex rather than a
  // round trip. Pinned by `apps/ingest/src/sessions.int.test.ts` (two files share that
  // basename; the `packages/db` one does not cover this).
  if (payload?.sid && isUuid(payload.sid)) {
    const live = await findLiveSession(app.db, payload.sid);
    if (live) {
      email = payload.sub;
      sessionUserId = live.userId;
      sid = payload.sid;
    }
  }
  if (!email) return null;

  const principal = await findPrincipalByEmail(app.db, email);
  if (!principal) return null;
  // Defence in depth: the MAC already binds `sub` and `sid` together, so a mismatch is not
  // reachable by an attacker — it is reachable by a BUG (a session row re-pointed at another user,
  // an email reassigned). Fail closed on it rather than trusting one half of a signed pair.
  if (sessionUserId && sessionUserId !== principal.userId) return null;
  // Side effect AND return: handlers use the RETURNED value (narrowed non-null);
  // `request.principal` exists for future middleware and 15.3's transaction wrapper.
  request.principal = principal;
  // M15 15.6 — the session id travels with the request from here. Every handler that needs it
  // reads `request.sessionId` rather than re-deriving it, so the Bearer parsing and the MAC
  // verification have exactly ONE definition each, and the `isUuid` validation above covers every
  // later use rather than only this one.
  request.sessionId = sid;
  return principal;
}

/**
 * M15 15.9 (D-15.9-4) — the EFFECTIVE role of an API-key caller: the LOWER of the key's own role
 * and its owner's CURRENT membership role. Returns `null` when the key must be REJECTED (401).
 *
 * Exported and pure so the 4×4 role matrix — plus `null` and a corrupt string — is testable without
 * a database. A `min` buried inside `resolvePrincipal` could only be exercised through HTTP, which
 * is how a table like this ends up with three cases covered and thirteen assumed.
 *
 * THE THREE CASES, each a decision:
 *
 *   - `keyRole === null` ⇒ INHERIT the membership role exactly. This is what `ADMIN_TOKEN` does
 *     today, so the desktop app's migration to a role-less key is behaviour-preserving.
 *   - `keyRole` outside `ROLES` ⇒ REJECT, not clamp. `isRole` narrows, and failing closed on a
 *     hand-edited row is the same direction `hasRole` already fails. Clamping would silently grant
 *     a typo'd role the viewer rung, which is a quiet "it works" where a loud 401 is correct.
 *   - otherwise ⇒ the `min`. NOT merely a mint-time cap: re-deriving it here is what makes a
 *     DEMOTION take effect on the key's next request rather than on key rotation, exactly as
 *     `findPrincipalByEmail` already re-resolves a session's role (D-15.6-7). Conversely a
 *     PROMOTION does not upgrade a key past the rung it was minted at — BUT ONLY WHEN `keyRole` IS
 *     SET. A null-role key tracks its owner in BOTH directions by definition, and since omitting
 *     `role` is the documented default, that is the common case: promote the owner and every
 *     role-less key they hold is promoted with them, silently and without rotation. Mint with an
 *     explicit `role` if you want a ceiling that survives the owner's promotion.
 *
 * `membershipRole` is a `string`, not a `Role`, for the reason `Principal.role` is — it comes from
 * a TEXT column with no CHECK. It is deliberately NOT validated here: `hasRole` fails closed on an
 * unknown value, so the comparison falls to `membershipRole`, which `authorized()` then rejects on
 * its own. Rejecting it here too would move a membership-integrity decision into the key path.
 */
export function effectiveApiKeyRole(membershipRole: string, keyRole: string | null): string | null {
  if (keyRole === null) return membershipRole;
  if (!isRole(keyRole)) return null;
  return hasRole(membershipRole, keyRole) ? keyRole : membershipRole;
}

/**
 * M15 15.9 (D-15.9-7) — the `last_used_at` touch throttle. Mutates `lastTouchedAt` and returns
 * whether the caller should issue the write.
 *
 * Mirrors `monitor.ts`'s `shouldReconcile` exactly, including stamping BEFORE the caller's await so
 * two overlapping requests cannot both observe a stale `last`. The map lives on the app, so it is
 * per-process and resets on restart — fine, because a missed window costs one extra write, never a
 * wrong result.
 *
 * WHY THIS EXISTS AT ALL: `sessions` has no `last_used_at` precisely because touching it would put
 * a write on every authenticated read (see that table's comment). The column is worth having here —
 * without it "is this key still in use?" is unanswerable and every revocation is a guess — but only
 * because the write is throttled and unawaited. The desktop app polls the monitor; unthrottled,
 * that is a write per tick per client, which is the audit-B.4 shape 15.4 had to remove.
 *
 * Exported for the same reason `effectiveApiKeyRole` is: a throttle whose only test is "the suite
 * still passes" is a throttle nobody has checked.
 */
export function shouldTouchApiKey(
  lastTouchedAt: Map<string, number>,
  id: string,
  throttleMs: number,
  nowMs: number,
): boolean {
  const last = lastTouchedAt.get(id) ?? 0;
  const due = nowMs - last >= throttleMs;
  if (due) {
    if (lastTouchedAt.size >= API_KEY_TOUCH_MAP_SWEEP_AT)
      sweepStaleTouches(lastTouchedAt, throttleMs, nowMs);
    lastTouchedAt.set(id, nowMs);
  }
  return due;
}

/**
 * Above this many entries, `shouldTouchApiKey` sweeps the inert ones before inserting. Not a
 * capacity limit — the sweep is exact, so the map never holds an entry it would not have honoured.
 *
 * 4096 is chosen to be far above any real deployment's live-key count (so the sweep effectively
 * never runs) while still bounding the pathological case. It is deliberately NOT tuned: the map is
 * not attacker-growable, so this is a backstop, not a defence.
 */
const API_KEY_TOUCH_MAP_SWEEP_AT = 4096;

/**
 * Drop entries older than the throttle window.
 *
 * SAFE BY CONSTRUCTION, which is why this is a sweep and not an LRU: an entry whose age already
 * exceeds `throttleMs` would return `due = true` on its next lookup whether it is present or
 * absent — `?? 0` makes a missing entry maximally stale. So removing it cannot change any future
 * decision, only the memory holding it. An LRU, by contrast, could evict a RECENT entry and
 * silently permit an extra write.
 *
 * WHY THIS EXISTS AT ALL: the map is keyed by `api_keys.id` and entries are never otherwise
 * removed, so a long-lived process that rotates keys accumulates one dead entry per retired key
 * forever. It is NOT attacker-growable — `shouldTouchApiKey` is only reached after `findLiveApiKey`
 * has already resolved a real row, so an unknown token adds nothing — which is why a bounded sweep
 * is sufficient and a cache-eviction policy would be over-engineering. `reconcileLastRunAt` has the
 * same unbounded shape and the same real-world bound; if a third such map appears, that is the
 * signal to extract one helper rather than write a third.
 */
function sweepStaleTouches(
  lastTouchedAt: Map<string, number>,
  throttleMs: number,
  nowMs: number,
): void {
  for (const [key, touchedAt] of lastTouchedAt) {
    if (nowMs - touchedAt >= throttleMs) lastTouchedAt.delete(key);
  }
}

/**
 * M15 15.9 — resolve an API-key bearer to its OWNER's principal, or null (⇒ 401).
 *
 * Null for: an unknown / revoked / expired key (collapsed by `findLiveApiKey` on purpose), an owner
 * with no membership (an ownerless identity fails CLOSED, matching the session path's `innerJoin`),
 * or a stored `role` outside `ROLES`.
 *
 * NOTE the ownership chain: the key names a `user_id`, and everything else — org and role — is
 * re-derived from that user's CURRENT membership on every request. The key row is deliberately not
 * a second, independently-mutable answer to "which org is this?" (D-15.9-1). That is why removing
 * someone from an org kills their keys' access immediately, before `revokeAllApiKeys` even runs.
 */
async function resolveApiKeyPrincipal(
  app: FastifyInstance,
  request: FastifyRequest,
  token: string,
): Promise<Principal | null> {
  const key = await findLiveApiKey(app.db, token);
  if (!key) return null;
  const owner = await findPrincipalByUserId(app.db, key.userId);
  if (!owner) return null;
  const role = effectiveApiKeyRole(owner.role, key.role);
  if (role === null) return null;

  const principal: Principal = { ...owner, role };
  request.principal = principal;
  // M15 15.9 (D-15.9-5) — a key caller has NO session, and mints none. MFA is enforced at LOGIN,
  // and a key can only exist because an already-authenticated (and, if enrolled, already-MFA'd)
  // session minted it. `sessionId` stays null; `apiKeyId` is what the SSE re-check reads instead.
  request.sessionId = null;
  request.apiKeyId = key.id;

  // FIRE-AND-FORGET, and throttled (D-15.9-7). Unawaited so a bookkeeping write never alters auth
  // latency or the 401 contract — the `recordIngestAuthFailure` idiom at plugins/auth.ts. The
  // `.catch(() => {})` is mandatory, not decorative: an unhandled rejection from a detached promise
  // takes the process down under Node's default policy.
  if (shouldTouchApiKey(app.apiKeyLastTouchedAt, key.id, app.apiKeyTouchThrottleMs, Date.now())) {
    void touchApiKeyLastUsed(app.db, key.id).catch(() => {});
  }
  return principal;
}

/**
 * M15 15.4 — the ROUTE-LAYER authorization gate (D-M15-4). The PRIMARY defence; the RLS
 * restrictive policies (migration 0016) are the backstop behind it, and they only cover
 * WRITES and only fire loudly for INSERT/UPDATE. So this must be complete on its own:
 * a missed gate on a DELETE path is silent at BOTH layers.
 *
 * Deliberately NOT folded into `resolvePrincipal`: 401 (who are you?) and 403 (you may not)
 * are different answers, and keeping the two `if` blocks adjacent at every call site is
 * what makes the grep in `routes/org-scoping.test.ts` able to see them.
 *
 * `Principal.role` is `string`, not `Role` — it comes from a TEXT column with no CHECK
 * constraint. It is deliberately NOT cast: `hasRole` takes a `string` and fails CLOSED, which
 * is the correct handling for a row someone edited by hand. Note the asymmetry with the RLS
 * backstop, which only ever asks "is this a viewer?" and therefore PERMITS an unknown role to
 * write. The strict layer is this one.
 */
export function authorized(principal: Principal, minimum: Role): boolean {
  return hasRole(principal.role, minimum);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `s` is a canonical UUID. Routes guard path/body ids with this so a
 * malformed id returns 400/404 instead of bubbling a Postgres uuid-cast 500.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
