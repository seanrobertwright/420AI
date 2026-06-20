import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless HMAC-SHA256 session token (M12 12.3). Format `base64url(payload).base64url(mac)`
 * where payload is `{sub,iat,exp}` (epoch-seconds). No sessions table — for a single admin,
 * "revoke all" == rotate SESSION_SECRET. The byte format is interop-proven against the
 * dashboard's Edge `crypto.subtle` verifier (see apps/dashboard/src/lib/session.ts).
 */

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

/** Sign a session for `sub`, valid for `ttlSec` seconds. Returns the token + exp (epoch-seconds). */
export function signSession(
  sub: string,
  secret: string,
  ttlSec: number,
): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const body = Buffer.from(JSON.stringify({ sub, iat, exp })).toString("base64url");
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
