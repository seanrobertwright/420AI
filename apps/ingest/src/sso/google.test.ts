import { describe, expect, it } from "vitest";
import { googleProvider, toGoogleProfile } from "./google.js";
import { SsoProviderError } from "./provider.js";

const cfg = { clientId: "gid", clientSecret: "gsecret", timeoutMs: 1000 };

describe("googleProvider.authorizeUrl", () => {
  const url = googleProvider(cfg).authorizeUrl({
    state: "st4te",
    codeChallenge: "chall",
    redirectUri: "https://app.example/api/auth/sso/google/callback",
  });
  const q = new URL(url).searchParams;

  it("targets the discovery document's authorization endpoint", () => {
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  it("requests the authorization-code flow with the S256 challenge", () => {
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge")).toBe("chall");
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("carries the exact redirect_uri and state it was handed", () => {
    expect(q.get("redirect_uri")).toBe("https://app.example/api/auth/sso/google/callback");
    expect(q.get("state")).toBe("st4te");
    expect(q.get("client_id")).toBe("gid");
  });

  it("asks for identity scopes only, and for no offline access (D-15.7-5)", () => {
    expect(q.get("scope")).toBe("openid email");
    expect(q.get("access_type")).toBeNull();
    expect(q.get("prompt")).toBeNull();
  });

  it("omits the challenge entirely when none is supplied", () => {
    const plain = new URL(
      googleProvider(cfg).authorizeUrl({ state: "s", redirectUri: "https://app.example/cb" }),
    ).searchParams;
    expect(plain.get("code_challenge")).toBeNull();
    expect(plain.get("code_challenge_method")).toBeNull();
  });

  it("never puts the client secret in the browser-visible URL", () => {
    expect(url).not.toContain("gsecret");
  });
});

describe("toGoogleProfile", () => {
  it("maps a verified userinfo response", () => {
    expect(toGoogleProfile({ sub: "g-1", email: "A@Corp.com", email_verified: true })).toEqual({
      subject: "g-1",
      email: "A@Corp.com",
      emailVerified: true,
    });
  });

  it("treats a MISSING email_verified claim as unverified", () => {
    // The coercion bug: `Boolean(undefined)` is false by luck, but `raw.email_verified` being a
    // string `"true"` or absent must never read as verified. `=== true` is what guarantees it.
    expect(toGoogleProfile({ sub: "g-2", email: "b@corp.com" }).emailVerified).toBe(false);
  });

  it("treats a false email_verified claim as unverified", () => {
    expect(
      toGoogleProfile({ sub: "g-3", email: "c@corp.com", email_verified: false }).emailVerified,
    ).toBe(false);
  });

  it("returns a null email when Google asserts none", () => {
    expect(toGoogleProfile({ sub: "g-4" }).email).toBeNull();
  });

  it("throws a typed provider error when `sub` is absent", () => {
    // A profile with no subject has no identity key at all, and `undefined` reaching the
    // (provider, subject) index would be an opaque 500 rather than a clean 502.
    expect(() => toGoogleProfile({ email: "d@corp.com", email_verified: true })).toThrow(
      SsoProviderError,
    );
  });
});
