import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { findLiveSession, findPrincipalByEmail, type Principal } from "@420ai/db";
import { hasRole, type Role } from "@420ai/shared";
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
 * Two credential paths, service-first (a machine client never pays for an HMAC):
 *  (1) ADMIN_TOKEN — the bootstrap service token. Resolves to the BOOTSTRAP ADMIN principal
 *      (app.adminEmail), preserving today's behavior exactly. D-M15-7 retires this in 15.9.
 *  (2) A 12.3 HMAC session token — `sub` is the user's EMAIL (routes/auth.ts signs it that
 *      way). 15.2 is where ingest finally READS that claim instead of discarding it.
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
 * route, `GET /v1/monitor/stream` (it calls `reply.hijack()`), and it therefore RE-CHECKS the
 * session itself on every tick via `sessionIdFromRequest` + `findLiveSession`. See the comment
 * there. If a second hijacking route is ever added, it inherits that obligation — a
 * connect-time-only gate does not revoke.
 */
export async function resolvePrincipal(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;

  let email: string | null = null;
  // The `sessions.user_id` behind branch (2)'s `sid`, or null on the ADMIN_TOKEN path (which has
  // no session). Cross-checked against the resolved principal below.
  let sessionUserId: string | null = null;
  // (1) Service token — the unchanged ADMIN_TOKEN path. The length guard before
  // timingSafeEqual is mandatory (it throws on a length mismatch).
  //
  // NOTE the ordering: this branch stays FIRST and session-free. A machine client must not pay for
  // a session lookup, and `ADMIN_TOKEN` has no `sessions` row to find — it must keep working
  // unchanged until D-M15-7 retires it in 15.9.
  const presented = Buffer.from(token);
  const expected = Buffer.from(app.adminToken);
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
    email = app.adminEmail;
  } else {
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
    // round trip. Pinned by `sessions.int.test.ts`.
    if (payload?.sid && isUuid(payload.sid)) {
      const live = await findLiveSession(app.db, payload.sid);
      if (live) {
        email = payload.sub;
        sessionUserId = live.userId;
      }
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
  return principal;
}

/**
 * M15 15.6 — the CALLER's own session id, or null when the credential carries none (an
 * `ADMIN_TOKEN` service caller, or a pre-0018 token).
 *
 * A PURE crypto check with no database in it, deliberately: it answers "which session does this
 * request name?", never "is that session still live". Callers that need the second question ask
 * `findLiveSession`. Keeping the two separable is the same split that lets the int suite assert
 * "still cryptographically valid, yet rejected".
 *
 * Lives here rather than in `routes/auth.ts` because `routes/monitor.ts` needs it too: an SSE
 * stream must re-check its own session per tick (see the stream handler), and a second private
 * copy of this logic in that file would be a second place for the `Bearer` parsing to drift.
 */
export function sessionIdFromRequest(app: FastifyInstance, request: FastifyRequest): string | null {
  const token = bearerToken(request);
  if (!token) return null;
  return verifySession(token, app.sessionSecret)?.sid ?? null;
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
