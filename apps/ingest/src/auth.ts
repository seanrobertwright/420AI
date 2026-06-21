import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifySession } from "./session.js";

/**
 * Shared admin-gate + input guards for the ingest routes. Extracted so the
 * constant-time bearer check has ONE definition (it was copy-pasted across
 * pairing-codes / projects / workspaces routes).
 */

/** Extract a Bearer token from the Authorization header, or null if missing/malformed. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer (.+)$/.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * M12 12.3 HYBRID admin gate (stays sync, same signature — the 12 admin routes don't
 * change their call). True if the request carries EITHER the static service token
 * (ADMIN_TOKEN — machine clients: desktop M11 + collector CLI, unchanged path) OR a
 * valid HMAC session token issued by POST /v1/auth/login (the human/dashboard path).
 */
export function adminAuthorized(app: FastifyInstance, request: FastifyRequest): boolean {
  const token = bearerToken(request);
  if (!token) return false;
  // (1) Service token — the unchanged ADMIN_TOKEN path. The length guard before
  // timingSafeEqual is mandatory (it throws on a length mismatch).
  const presented = Buffer.from(token);
  const expected = Buffer.from(app.adminToken);
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) return true;
  // (2) Human session token — HMAC-signed + unexpired (service-first avoids an HMAC for machines).
  return verifySession(token, app.sessionSecret) !== null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `s` is a canonical UUID. Routes guard path/body ids with this so a
 * malformed id returns 400/404 instead of bubbling a Postgres uuid-cast 500.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
