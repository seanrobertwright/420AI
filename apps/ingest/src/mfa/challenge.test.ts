import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  CHALLENGE_TTL_SECONDS,
  credentialVersion,
  signChallenge,
  verifyChallenge,
} from "./challenge.js";
import { signSession, verifySession, SESSION_TTL_SECONDS } from "../session.js";

/**
 * M15 15.8 — the challenge primitive. No infra, so this always runs.
 *
 * THE FIRST TWO TESTS ARE THE POINT OF THE FILE. A challenge that verified as a session would be a
 * complete MFA bypass (GOTCHA-2), so the domain separation is asserted in BOTH directions against
 * the REAL `session.ts` — not against a re-implementation, because a re-implementation could drift
 * into agreement.
 */

const SECRET = "test-session-secret-not-a-real-one";

afterEach(() => {
  vi.useRealTimers();
});

describe("domain separation (GOTCHA-2)", () => {
  it("a CHALLENGE does not verify as a SESSION", () => {
    const { token } = signChallenge(SECRET, {
      userId: "11111111-1111-1111-1111-111111111111",
      credentialVersion: credentialVersion(SECRET, "scrypt$aaa$bbb"),
    });
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("a SESSION does not verify as a CHALLENGE", () => {
    const { token } = signSession(
      "user@corp.com",
      SECRET,
      SESSION_TTL_SECONDS,
      "22222222-2222-2222-2222-222222222222",
    );
    expect(verifyChallenge(token, SECRET)).toBeNull();
  });

  it("neither survives even when the payload SHAPES are made to overlap", () => {
    // The separation must not depend on the payloads differing. It is the KEY that differs, so a
    // hand-built body carrying both a `sid` and a `uid` still fails in both directions.
    const { token } = signChallenge(SECRET, {
      userId: "33333333-3333-3333-3333-333333333333",
      credentialVersion: credentialVersion(SECRET, null),
    });
    const body = token.slice(0, token.lastIndexOf("."));
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(decoded).toHaveProperty("uid");
    expect(decoded).not.toHaveProperty("sid");
    // And the reverse: the challenge key is NOT the session secret, so re-signing under the raw
    // secret produces a token this verifier rejects.
    expect(
      verifyChallenge(`${body}.${signSession("x", SECRET, 60, "y").token}`, SECRET),
    ).toBeNull();
  });
});

describe("verifyChallenge", () => {
  const userId = "44444444-4444-4444-4444-444444444444";
  const cv = credentialVersion(SECRET, "scrypt$salt$dk");

  it("round-trips a freshly signed challenge", () => {
    const { token, exp } = signChallenge(SECRET, { userId, credentialVersion: cv });
    const payload = verifyChallenge(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe(userId);
    expect(payload!.cv).toBe(cv);
    expect(payload!.exp).toBe(exp);
    expect(exp - payload!.iat).toBe(CHALLENGE_TTL_SECONDS);
  });

  it("rejects a token signed under a different secret", () => {
    const { token } = signChallenge(SECRET, { userId, credentialVersion: cv });
    expect(verifyChallenge(token, "a-different-secret")).toBeNull();
  });

  it("rejects a BODY SWAPPED under a stolen MAC", () => {
    // The attack this defends: take a legitimately-signed challenge, keep its MAC, and substitute a
    // body naming another user. The MAC covers the body, so the substitution does not verify.
    const mine = signChallenge(SECRET, { userId, credentialVersion: cv });
    const theirs = signChallenge(SECRET, {
      userId: "55555555-5555-5555-5555-555555555555",
      credentialVersion: cv,
    });
    const stolenMac = mine.token.slice(mine.token.lastIndexOf(".") + 1);
    const theirBody = theirs.token.slice(0, theirs.token.lastIndexOf("."));
    expect(verifyChallenge(`${theirBody}.${stolenMac}`, SECRET)).toBeNull();
  });

  it("rejects an EXPIRED challenge whose MAC is still perfectly valid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    const { token } = signChallenge(SECRET, { userId, credentialVersion: cv });
    // One second past the TTL. The MAC is untouched — expiry is the only reason for the refusal.
    vi.setSystemTime(new Date(Date.now() + (CHALLENGE_TTL_SECONDS + 1) * 1000));
    expect(verifyChallenge(token, SECRET)).toBeNull();
  });

  it("accepts a challenge one second BEFORE it expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    const { token } = signChallenge(SECRET, { userId, credentialVersion: cv });
    vi.setSystemTime(new Date(Date.now() + (CHALLENGE_TTL_SECONDS - 1) * 1000));
    expect(verifyChallenge(token, SECRET)).not.toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const junk of ["", ".", "no-dot", "a.b", "....", "eyJ9.eyJ9"]) {
      expect(() => verifyChallenge(junk, SECRET)).not.toThrow();
      expect(verifyChallenge(junk, SECRET), JSON.stringify(junk)).toBeNull();
    }
  });

  it("rejects a validly-MACed token whose payload is JSON `null`", () => {
    // Only the secret-holder can forge this, but `null.exp` would throw a 500 — so the null-guard
    // is asserted rather than assumed (the same guard `session.ts:73` carries).
    const forged = forgeChallenge(SECRET, "null");
    expect(() => verifyChallenge(forged, SECRET)).not.toThrow();
    expect(verifyChallenge(forged, SECRET)).toBeNull();
  });

  it("rejects a validly-MACed token missing `uid` or `cv`", () => {
    const noUid = forgeChallenge(SECRET, JSON.stringify({ cv, iat: 0, exp: 9_999_999_999 }));
    const noCv = forgeChallenge(
      SECRET,
      JSON.stringify({ uid: userId, iat: 0, exp: 9_999_999_999 }),
    );
    expect(verifyChallenge(noUid, SECRET)).toBeNull();
    expect(verifyChallenge(noCv, SECRET)).toBeNull();
  });
});

describe("credentialVersion", () => {
  it("is STABLE for the same hash", () => {
    const hash = "scrypt$abc$def";
    expect(credentialVersion(SECRET, hash)).toBe(credentialVersion(SECRET, hash));
  });

  it("CHANGES when the password hash changes — the whole binding (GOTCHA-1)", () => {
    expect(credentialVersion(SECRET, "scrypt$abc$def")).not.toBe(
      credentialVersion(SECRET, "scrypt$abc$xyz"),
    );
  });

  it("is DEFINED and stable for a null hash (an SSO-only user)", () => {
    const a = credentialVersion(SECRET, null);
    expect(a).toHaveLength(22);
    expect(credentialVersion(SECRET, null)).toBe(a);
    // …and distinct from a real hash, so an SSO-only user's challenge cannot be replayed against a
    // password-bearing account's fingerprint.
    expect(a).not.toBe(credentialVersion(SECRET, "scrypt$abc$def"));
  });

  it("differs across deployments (it is keyed by SESSION_SECRET)", () => {
    expect(credentialVersion(SECRET, "scrypt$abc$def")).not.toBe(
      credentialVersion("another-secret", "scrypt$abc$def"),
    );
  });

  it("does not leak the password hash", () => {
    const hash = "scrypt$c2FsdA$ZGVyaXZlZA";
    const cv = credentialVersion(SECRET, hash);
    expect(cv).not.toContain("scrypt");
    expect(cv).not.toContain("c2FsdA");
    expect(cv).not.toContain("ZGVyaXZlZA");
  });
});

/**
 * Sign an ARBITRARY body under the challenge key, so the tests above can drive payloads
 * `signChallenge` would never produce. Re-derives the key the same way the module does — the
 * duplication is deliberate: a helper that imported the private function could not forge anything.
 */
function forgeChallenge(secret: string, json: string): string {
  const key = createHmac("sha256", secret).update("420ai.mfa.challenge.v1").digest();
  const body = Buffer.from(json).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}
