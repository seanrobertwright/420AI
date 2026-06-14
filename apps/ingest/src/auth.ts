import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Shared admin-gate + input guards for the ingest routes. Extracted so the
 * constant-time bearer check has ONE definition (it was copy-pasted across
 * pairing-codes / projects / workspaces routes).
 */

/** Constant-time comparison of the request's Bearer token to the admin token. */
export function adminAuthorized(app: FastifyInstance, request: FastifyRequest): boolean {
  const header = request.headers.authorization;
  const match = header ? /^Bearer (.+)$/.exec(header) : null;
  if (!match) return false;
  const presented = Buffer.from(match[1]!);
  const expected = Buffer.from(app.adminToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `s` is a canonical UUID. Routes guard path/body ids with this so a
 * malformed id returns 400/404 instead of bubbling a Postgres uuid-cast 500.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
