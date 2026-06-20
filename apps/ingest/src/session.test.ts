import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signSession, verifySession, SESSION_TTL_SECONDS } from "./session.js";

const SECRET = "test-session-secret";

/** Craft a token with a VALID mac over an arbitrary body string (to probe non-object payloads). */
function signRawBody(bodyStr: string, secret: string): string {
  const body = Buffer.from(bodyStr).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

describe("session (HMAC)", () => {
  it("round-trips a valid token to its payload", () => {
    const { token, exp } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS);
    const payload = verifySession(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("admin@test.local");
    expect(payload!.exp).toBe(exp);
    expect(typeof payload!.iat).toBe("number");
  });

  it("rejects a tampered token", () => {
    const { token } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS);
    expect(verifySession(token + "x", SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = signSession("admin@test.local", SECRET, SESSION_TTL_SECONDS);
    expect(verifySession(token, "wrong-secret")).toBeNull();
  });

  it("rejects an expired token (negative ttl)", () => {
    const { token } = signSession("admin@test.local", SECRET, -1);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token (no dot)", () => {
    expect(verifySession("not-a-token", SECRET)).toBeNull();
  });

  it("returns null (does not throw) for a valid-MAC token whose payload is JSON null", () => {
    expect(verifySession(signRawBody("null", SECRET), SECRET)).toBeNull();
  });
});
