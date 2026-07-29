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
vi.mock("@/lib/ingest", () => ({ ingestUrl: () => "http://ingest.test" }));
vi.mock("@/lib/proxy", () => ({
  proxyJson: async (path: string) => {
    calls.order.push(`proxyJson:${path}`);
    return new Response("{}", { status: 200 });
  },
}));
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "ai_session",
  sessionConfigError: () => null,
}));

const fetchMock = vi.fn(async (url: string | URL) => {
  calls.order.push(`fetch:${String(url)}`);
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
  calls.flow = null;
  upstream.ok = true;
  upstream.status = 200;
  upstream.body = "";
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
