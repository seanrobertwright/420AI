import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkcePair, randomState } from "./pkce.js";

describe("pkce", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    // Recomputed INDEPENDENTLY rather than by calling the same helper — a test that reuses the
    // implementation's own derivation would pass even if both halves were wrong together.
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    expect(codeChallenge).toBe(expected);
  });

  it("produces a fresh pair every call", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it("emits URL-safe, unpadded values on both halves", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    for (const v of [codeVerifier, codeChallenge]) {
      // `+`, `/` and `=` are the standard-base64 characters that break a query parameter. Node's
      // `base64url` encoding already excludes them; this asserts nobody "helpfully" swaps it back.
      expect(v).not.toMatch(/[+/=]/);
    }
  });

  it("produces an unguessable, URL-safe state", () => {
    const s = randomState();
    expect(s).not.toMatch(/[+/=]/);
    // 32 bytes base64url-encoded is 43 characters.
    expect(s).toHaveLength(43);
    expect(randomState()).not.toBe(s);
  });
});
