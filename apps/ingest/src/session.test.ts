import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signSession, verifySession, SESSION_TTL_SECONDS } from "./session.js";

const SECRET = "test-session-secret";
const SID = "11111111-2222-3333-4444-555555555555";

/** Craft a token with a VALID mac over an arbitrary body string (to probe non-object payloads). */
function signRawBody(bodyStr: string, secret: string): string {
  const body = Buffer.from(bodyStr).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * M15 15.6 — sign a PRE-0018 token: the old three-claim payload, with a genuinely valid MAC.
 * Hand-built rather than obtained by calling `signSession` with a missing argument, because the
 * required fourth parameter is precisely what makes that impossible (which is the point of it).
 */
function signLegacyBody(sub: string, secret: string, ttlSec: number): string {
  const iat = Math.floor(Date.now() / 1000);
  return signRawBody(JSON.stringify({ sub, iat, exp: iat + ttlSec }), secret);
}

describe("session (HMAC)", () => {
  it("round-trips a valid token to its payload", () => {
    const { token, exp } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS, SID);
    const payload = verifySession(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("admin@test.local");
    expect(payload!.exp).toBe(exp);
    expect(typeof payload!.iat).toBe("number");
  });

  it("rejects a tampered token", () => {
    const { token } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS, SID);
    expect(verifySession(token + "x", SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS, SID);
    expect(verifySession(token, "wrong-secret")).toBeNull();
  });

  it("rejects an expired token (negative ttl)", () => {
    const { token } = signSession("admin@test.local", SECRET, -1, SID);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token (no dot)", () => {
    expect(verifySession("not-a-token", SECRET)).toBeNull();
  });

  it("returns null (does not throw) for a valid-MAC token whose payload is JSON null", () => {
    expect(verifySession(signRawBody("null", SECRET), SECRET)).toBeNull();
  });

  // ── M15 15.6 (D-15.6-1 / D-15.6-5) ───────────────────────────────────────────────────────

  it("round-trips the `sid` claim", () => {
    const { token } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS, SID);
    expect(verifySession(token, SECRET)!.sid).toBe(SID);
  });

  /**
   * THIS TEST IS WHAT MAKES `sessions.int.test.ts`'s DISCRIMINATOR MEANINGFUL, so it is not
   * optional. The int suite proves "revoked ⇒ 401" by asserting the token is STILL crypto-valid at
   * the moment it is rejected. That argument only holds if `verifySession` genuinely knows nothing
   * about sessions — if it ever started rejecting a `sid`-less or revoked token itself, the
   * discriminator would silently degrade into "the token is bad", which is the theatre the whole
   * suite is built to avoid.
   *
   * So: a pre-0018 token VERIFIES (the MAC is good, the expiry is in the future) and reports
   * `sid === undefined`. Turning that undefined into a 401 is `resolvePrincipal`'s job alone.
   */
  it("a pre-0018 token still verifies cryptographically but carries NO sid", () => {
    const payload = verifySession(signLegacyBody("admin@test.local", SECRET, 3600), SECRET);
    expect(payload, "a legacy token's MAC must still verify").not.toBeNull();
    expect(payload!.sub).toBe("admin@test.local");
    expect(payload!.sid).toBeUndefined();
  });
});
