import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * M15 15.7 — unit coverage for the SSO callback Route Handler. Two facts, both of which are
 * invisible to the ingest-side suite because they happen entirely in the browser hop:
 *
 *  1. A `state` MISMATCH is refused WITHOUT ANY INGEST CALL. That ordering is the CSRF defence —
 *     a handler that exchanged first and compared afterwards would already have spent the
 *     authorization code, and the check would be decorative.
 *  2. The happy path sets the session cookie with the flags the middleware needs.
 *
 * Mocking pattern copied from `api/auth/logout/route.test.ts` (`vi.hoisted` + `vi.mock` for
 * `next/headers`).
 */

const calls = vi.hoisted(() => ({
  order: [] as string[],
  cookieSet: null as { name: string; value: string; opts: Record<string, unknown> } | null,
  // The ARGUMENT the delete was called with, not merely that it was called. The first version of
  // this mock recorded the name only, and that is exactly why the `Path=/` bug shipped green: the
  // test asserted the CALL and not the EFFECT, so it passed with the right path, the wrong path,
  // or none at all.
  cookieDeleted: null as { name: string; path?: string } | null,
  // The outbound request BODY. Without recording it nothing asserts that `codeVerifier` is
  // forwarded at all — and dropping it breaks EVERY Google login in production (PKCE is mandatory
  // once a challenge was sent) while leaving this suite green. Mutation-proven.
  body: null as string | null,
  flow: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ai_sso" && calls.flow ? { value: calls.flow } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      calls.order.push(`cookie.set:${name}`);
      calls.cookieSet = { name, value, opts };
    },
    delete: (arg: string | { name: string; path?: string }) => {
      const parsed = typeof arg === "string" ? { name: arg } : arg;
      calls.order.push(`cookie.delete:${parsed.name}`);
      calls.cookieDeleted = parsed;
    },
  }),
}));

const upstream = vi.hoisted(() => ({ ok: true, status: 200, body: "" }));
// Status-configurable, so link-mode's FAILURE branch (409 -> ssoError=identity_taken vs anything
// else -> ssoError=failed) is reachable. A mock hardcoded to 200 makes that branch untestable, and
// `identity_taken` is the one collision the link route exists to answer.
const proxyUpstream = vi.hoisted(() => ({ status: 200 }));
vi.mock("@/lib/ingest", () => ({ ingestUrl: () => "http://ingest.test" }));
vi.mock("@/lib/proxy", () => ({
  proxyJson: async (path: string, init?: { body?: string }) => {
    calls.order.push(`proxyJson:${path}`);
    calls.body = typeof init?.body === "string" ? init.body : null;
    return new Response("{}", { status: proxyUpstream.status });
  },
}));
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "ai_session",
  sessionConfigError: () => null,
}));

const fetchMock = vi.fn(async (url: string | URL, init?: { body?: BodyInit | null }) => {
  calls.order.push(`fetch:${String(url)}`);
  calls.body = typeof init?.body === "string" ? init.body : null;
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
});
vi.stubGlobal("fetch", fetchMock);

import { GET } from "./route.js";

const params = Promise.resolve({ provider: "google" });

function callbackRequest(query: string): NextRequest {
  return new NextRequest(`https://app.test/api/auth/sso/google/callback${query}`);
}

afterEach(() => {
  calls.order.length = 0;
  calls.cookieSet = null;
  calls.cookieDeleted = null;
  calls.body = null;
  calls.flow = null;
  upstream.ok = true;
  upstream.status = 200;
  upstream.body = "";
  proxyUpstream.status = 200;
  fetchMock.mockClear();
});

describe("GET /api/auth/sso/[provider]/callback", () => {
  it("refuses a STATE MISMATCH without making any ingest call", async () => {
    calls.flow = JSON.stringify({ state: "expected", mode: "login" });
    const res = await GET(callbackRequest("?code=abc&state=ATTACKER"), { params });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=sso_state");
    // THE ASSERTION THIS FILE EXISTS FOR: not one outbound hop happened. A handler that exchanged
    // first would already have spent the authorization code before ever comparing `state`.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.order.filter((c) => c.startsWith("fetch:"))).toEqual([]);
    expect(calls.order.filter((c) => c.startsWith("proxyJson:"))).toEqual([]);
    // The flow cookie is cleared even on refusal — a surviving PKCE verifier is a replay window.
    // ASSERTED WITH ITS PATH: `delete("ai_sso")` emits `Path=/`, which does not match the cookie
    // stored at `/api/auth/sso`, so the bare form clears NOTHING. This assertion is the difference
    // between testing that the line ran and testing that it worked.
    expect(calls.cookieDeleted).toEqual({ name: "ai_sso", path: "/api/auth/sso" });
  });

  it("refuses when the flow cookie is ABSENT entirely", async () => {
    calls.flow = null;
    const res = await GET(callbackRequest("?code=abc&state=whatever"), { params });
    expect(res.headers.get("location")).toContain("error=sso_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the provider reports its own error, with no exchange", async () => {
    calls.flow = JSON.stringify({ state: "s", mode: "login" });
    const res = await GET(callbackRequest("?error=access_denied&state=s"), { params });
    expect(res.headers.get("location")).toContain("error=sso_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets the session cookie and lands on the validated `next` on success", async () => {
    calls.flow = JSON.stringify({ state: "s", codeVerifier: "v", mode: "login", next: "/reports" });
    upstream.body = JSON.stringify({ token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });

    const res = await GET(callbackRequest("?code=abc&state=s"), { params });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.cookieSet?.name).toBe("ai_session");
    expect(calls.cookieSet?.value).toBe("tok");
    // The flags the Edge middleware depends on. `httpOnly` is what keeps the token out of client JS.
    expect(calls.cookieSet?.opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(res.headers.get("location")).toBe("https://app.test/reports");
  });

  it("REFUSES an off-site `next`, landing on the default instead", async () => {
    // The open-redirect guard, at the call site that matters most: this redirect carries a user who
    // has JUST authenticated. `//evil.test` passes a naive startsWith("/") and leaves the origin.
    calls.flow = JSON.stringify({ state: "s", mode: "login", next: "//evil.test" });
    upstream.body = JSON.stringify({ token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });

    const res = await GET(callbackRequest("?code=abc&state=s"), { params });
    expect(res.headers.get("location")).toBe("https://app.test/monitor");
  });

  it("REFUSES a tab/LF/CR-smuggled off-site `next` (the URL parser strips them)", async () => {
    // The `//evil.test` case above is NOT sufficient, and this is the test that says why. WHATWG
    // URL parsing removes tab/LF/CR from anywhere in the input, so slash-TAB-slash-host passes a
    // prefix check that only ever sees the raw string, and then resolves off-origin. This shipped:
    // the guard's own comment claimed to defend this class while `/\t/evil.test` sailed through
    // and the handler returned `Location: https://evil.test/` WITH the session cookie set.
    upstream.body = JSON.stringify({ token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });
    for (const smuggled of ["/\t/evil.test", "/\n/evil.test", "/\r/evil.test", "/\\evil.test"]) {
      calls.cookieSet = null;
      calls.flow = JSON.stringify({ state: "s", mode: "login", next: smuggled });
      const res = await GET(callbackRequest("?code=abc&state=s"), { params });
      expect(res.headers.get("location"), `next=${JSON.stringify(smuggled)}`).toBe(
        "https://app.test/monitor",
      );
    }
  });

  it("forwards the PKCE codeVerifier to ingest", async () => {
    // Nothing else in either suite looks at the outbound BODY: the ingest stub destructures only
    // `redirectUri`. So deleting `codeVerifier` from this request left 7/7 green here and 24/24
    // green there, while breaking every real Google login with `invalid_grant` — PKCE is mandatory
    // once a challenge has been sent. Mutation-proven; this assertion is what closes it.
    calls.flow = JSON.stringify({ state: "s", codeVerifier: "verifier-123", mode: "login" });
    upstream.body = JSON.stringify({ token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });

    await GET(callbackRequest("?code=abc&state=s"), { params });

    expect(JSON.parse(calls.body!)).toEqual({ code: "abc", codeVerifier: "verifier-123" });
  });

  it("forwards an inviteToken in login mode but NEVER in link mode", async () => {
    // The asymmetry is a decision (routes/sso.ts ignores it on link anyway): honouring an invite
    // for an already-authenticated caller would silently move or double their membership.
    calls.flow = JSON.stringify({ state: "s", mode: "login", inviteToken: "inv-tok" });
    upstream.body = JSON.stringify({ token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });
    await GET(callbackRequest("?code=abc&state=s"), { params });
    expect(JSON.parse(calls.body!).inviteToken).toBe("inv-tok");

    calls.body = null;
    calls.flow = JSON.stringify({ state: "s", mode: "link", inviteToken: "inv-tok" });
    await GET(callbackRequest("?code=abc&state=s"), { params });
    expect(JSON.parse(calls.body!).inviteToken).toBeUndefined();
  });

  it("maps a link-mode 409 to identity_taken and any other failure to failed", async () => {
    calls.flow = JSON.stringify({ state: "s", mode: "link", next: "/settings" });
    proxyUpstream.status = 409;
    let res = await GET(callbackRequest("?code=abc&state=s"), { params });
    expect(res.headers.get("location")).toContain("ssoError=identity_taken");

    calls.flow = JSON.stringify({ state: "s", mode: "link", next: "/settings" });
    proxyUpstream.status = 500;
    res = await GET(callbackRequest("?code=abc&state=s"), { params });
    expect(res.headers.get("location")).toContain("ssoError=failed");
  });

  it("surfaces ingest's typed refusal reason so the login form can explain it", async () => {
    calls.flow = JSON.stringify({ state: "s", mode: "login" });
    upstream.status = 409;
    upstream.body = JSON.stringify({ error: "sso login refused", reason: "link_required" });

    const res = await GET(callbackRequest("?code=abc&state=s"), { params });

    expect(res.headers.get("location")).toContain("error=link_required");
    // No session may be set on a refusal.
    expect(calls.cookieSet).toBeNull();
  });

  it("uses the AUTHENTICATED proxy for link mode, never the plain fetch", async () => {
    calls.flow = JSON.stringify({ state: "s", mode: "link", next: "/settings" });
    const res = await GET(callbackRequest("?code=abc&state=s"), { params });

    // `proxyJson` attaches the caller's session bearer; a plain fetch here would link nothing.
    expect(calls.order).toContain("proxyJson:/v1/auth/sso/google/link");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("ssoLinked=google");
    // Linking must NOT mint a session — the caller already has one.
    expect(calls.cookieSet).toBeNull();
  });
});
