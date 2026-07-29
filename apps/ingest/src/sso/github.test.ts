import { describe, expect, it } from "vitest";
import { githubProvider, toGithubProfile } from "./github.js";
import { SsoProviderError } from "./provider.js";

const cfg = { clientId: "ghid", clientSecret: "ghsecret", timeoutMs: 1000 };

describe("githubProvider.authorizeUrl", () => {
  const url = githubProvider(cfg).authorizeUrl({
    state: "st4te",
    // Deliberately handed a challenge it must IGNORE — GitHub does not document PKCE, and sending
    // a challenge we cannot rely on being enforced is worse than sending none (it reads, to a
    // later reviewer, as a protection that is in place).
    codeChallenge: "chall",
    redirectUri: "https://app.example/api/auth/sso/github/callback",
  });
  const q = new URL(url).searchParams;

  it("targets GitHub's OAuth authorize endpoint", () => {
    expect(url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
  });

  it("sends NO code_challenge (usesPkce is false)", () => {
    expect(githubProvider(cfg).usesPkce).toBe(false);
    expect(q.get("code_challenge")).toBeNull();
    expect(q.get("code_challenge_method")).toBeNull();
  });

  it("still sends state, which is GitHub's prescribed CSRF defence", () => {
    expect(q.get("state")).toBe("st4te");
  });

  it("asks for identity scopes only — never `repo`", () => {
    expect(q.get("scope")).toBe("read:user user:email");
    expect(url).not.toContain("repo");
    expect(url).not.toContain("ghsecret");
  });
});

describe("toGithubProfile", () => {
  it("picks the primary+verified address and stringifies the numeric id", () => {
    const p = toGithubProfile({ id: 12345 }, [
      { email: "secondary@corp.com", primary: false, verified: true },
      { email: "primary@corp.com", primary: true, verified: true },
    ]);
    expect(p).toEqual({ subject: "12345", email: "primary@corp.com", emailVerified: true });
    // The subject must be a STRING — a number reaching the `text` column compares unequally on the
    // read path while inserting without complaint on the write path.
    expect(typeof p.subject).toBe("string");
  });

  it("reports unverified when the PRIMARY address is unverified", () => {
    const p = toGithubProfile({ id: 7 }, [
      { email: "primary@corp.com", primary: true, verified: false },
    ]);
    expect(p.emailVerified).toBe(false);
    expect(p.email).toBe("primary@corp.com");
  });

  it("does NOT promote a verified SECONDARY address over an unverified primary", () => {
    const p = toGithubProfile({ id: 8 }, [
      { email: "primary@corp.com", primary: true, verified: false },
      { email: "other@corp.com", primary: false, verified: true },
    ]);
    expect(p.emailVerified).toBe(false);
    expect(p.email).not.toBe("other@corp.com");
  });

  it("reports no email at all when the account exposes none", () => {
    const p = toGithubProfile({ id: 9 }, []);
    expect(p).toEqual({ subject: "9", email: null, emailVerified: false });
  });

  it("throws a typed provider error when `/user` returns no id", () => {
    expect(() => toGithubProfile({}, [])).toThrow(SsoProviderError);
  });
});
