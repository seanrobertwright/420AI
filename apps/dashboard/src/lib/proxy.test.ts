import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the generalized JSON proxy (D8; M12 12.3 login). Stubs `globalThis.fetch`
 * (typed as `typeof fetch` so the recorded call args are the real `[input, init]` tuple) and
 * asserts the load-bearing behaviors: the admin bearer (now the logged-in admin's SESSION token
 * from the httpOnly cookie) is added on the server→ingest hop only when the cookie is present; a
 * `!res.ok` upstream status is FORWARDED (not collapsed to 502); a thrown/unreachable fetch
 * becomes a clean 502. `next/headers` cookies() is mocked (adminHeaders() reads it).
 */

// vi.hoisted keeps the shared cookie state initialized before the hoisted vi.mock factory runs.
const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) => (cookieState.value !== undefined ? { value: cookieState.value } : undefined),
  }),
}));

import { proxyJson } from "./proxy.js";

const ORIGINAL_INGEST_URL = process.env.INGEST_URL;

beforeEach(() => {
  process.env.INGEST_URL = "https://ingest.example.test";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cookieState.value = undefined;
  if (ORIGINAL_INGEST_URL === undefined) delete process.env.INGEST_URL;
  else process.env.INGEST_URL = ORIGINAL_INGEST_URL;
});

describe("proxyJson", () => {
  it("adds the session-token bearer on the server→ingest hop when the cookie is present", async () => {
    cookieState.value = "session-token";
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyJson("/v1/projects");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ingest.example.test/v1/projects");
    expect(init!.headers).toMatchObject({ authorization: "Bearer session-token" });
    expect(init!.cache).toBe("no-store");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("omits the authorization header when there is no session cookie", async () => {
    cookieState.value = undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await proxyJson("/v1/projects");

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("forwards a non-ok upstream status (404 stays 404, not 502)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "project not found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyJson("/v1/projects/not-a-uuid/summary");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project not found" });
  });

  it("returns 502 when the upstream fetch throws (ingest unreachable)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyJson("/v1/projects");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ingest unreachable" });
  });

  it("passes method, content-type, and body through for write proxies (12.2b)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await proxyJson("/v1/projects", {
      method: "POST",
      body: '{"name":"x"}',
      contentType: "application/json",
    });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});
