import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { findPrincipalByEmail, type Principal } from "@420ai/db";
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
 */
export async function resolvePrincipal(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;

  let email: string | null = null;
  // (1) Service token — the unchanged ADMIN_TOKEN path. The length guard before
  // timingSafeEqual is mandatory (it throws on a length mismatch).
  const presented = Buffer.from(token);
  const expected = Buffer.from(app.adminToken);
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
    email = app.adminEmail;
  } else {
    // (2) Human session token — HMAC-signed + unexpired.
    const payload = verifySession(token, app.sessionSecret);
    if (payload) email = payload.sub;
  }
  if (!email) return null;

  const principal = await findPrincipalByEmail(app.db, email);
  if (!principal) return null;
  // Side effect AND return: handlers use the RETURNED value (narrowed non-null);
  // `request.principal` exists for future middleware and 15.3's transaction wrapper.
  request.principal = principal;
  return principal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `s` is a canonical UUID. Routes guard path/body ids with this so a
 * malformed id returns 400/404 instead of bubbling a Postgres uuid-cast 500.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
