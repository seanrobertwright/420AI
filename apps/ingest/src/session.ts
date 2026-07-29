import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 session token (M12 12.3). Format `base64url(payload).base64url(mac)` where payload is
 * `{sub,iat,exp,sid}` (epoch-seconds). The byte format is interop-proven against the dashboard's
 * Edge `crypto.subtle` verifier (see apps/dashboard/src/lib/session.ts).
 *
 * M15 15.6 (D-M15-12) — the session is no longer STATELESS. 12.3's "no sessions table, so revoke-all
 * == rotate SESSION_SECRET" is superseded: a `sessions` row now backs every token via the `sid`
 * claim, and `resolvePrincipal` rejects one whose row is missing, revoked or expired.
 *
 * THE SPLIT BELOW IS LOAD-BEARING, not incidental. `verifySession` stays a PURE crypto + expiry
 * check with no database in it, and knows nothing about revocation. That is what lets the int suite
 * assert the discriminating fact — "this token's MAC still verifies and its `exp` is still in the
 * future, YET the request 401s" — which is the only way to prove a rejection is revocation rather
 * than expiry, tampering, or a wrong secret. Folding the lookup in here would erase that evidence.
 */

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  /**
   * M15 15.6 (D-15.6-1) — the `sessions` row id. REQUIRED for a token to authenticate, but typed
   * optional because a token minted before 0018 simply does not have one: `verifySession` is a
   * pure crypto+expiry check and must keep answering "the MAC is good" for such a token. It is
   * `resolvePrincipal` that turns a missing `sid` into a 401 (D-15.6-5), and keeping that split
   * is what lets the int suite assert "still crypto-valid, yet rejected".
   */
  sid?: string;
}

/**
 * Sign a session for `sub`, valid for `ttlSec` seconds, bound to the `sessions` row `sid`.
 * Returns the token + exp (epoch-seconds).
 *
 * `sid` is a REQUIRED fourth parameter, deliberately, for the same reason `withOrg`'s `role` is
 * required (`org-context.ts`): an optional one would silently mint an UNREVOCABLE session at any
 * call site that forgot it, and an unrevocable session is precisely the bug this slice removes.
 */
export function signSession(
  sub: string,
  secret: string,
  ttlSec: number,
  sid: string,
): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const body = Buffer.from(JSON.stringify({ sub, iat, exp, sid })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return { token: `${body}.${mac}`, exp };
}

/**
 * Verify a session token's MAC (constant-time) + expiry. Returns the payload, or
 * null for any failure (malformed, tampered, wrong secret, expired). Never throws.
 */
export function verifySession(token: string, secret: string): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  // Guard the payload before property access — JSON.parse can yield null (a valid-MAC token only
  // the secret-holder could forge, but auth code stays defensive): null.exp would throw.
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}
