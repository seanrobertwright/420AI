import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyJson } from "./proxy.js";

/**
 * Unit coverage for the generalized JSON proxy (D8). Stubs `globalThis.fetch` (typed as
 * `typeof fetch` so the recorded call args are the real `[input, init]` tuple) and asserts the
 * three load-bearing behaviors: the admin bearer is added on the server→ingest hop only when
 * ADMIN_TOKEN is set; a `!res.ok` upstream status is FORWARDED (not collapsed to 502); a
 * thrown/unreachable fetch becomes a clean 502. Mirrors `ingest.test.ts` env save/restore.
 */

const ORIGINAL_INGEST_URL = process.env.INGEST_URL;
const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN;

beforeEach(() => {
  process.env.INGEST_URL = "https://ingest.example.test";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_INGEST_URL === undefined) delete process.env.INGEST_URL;
  else process.env.INGEST_URL = ORIGINAL_INGEST_URL;
  if (ORIGINAL_ADMIN_TOKEN === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN;
});

describe("proxyJson", () => {
  it("adds the admin bearer on the server→ingest hop when ADMIN_TOKEN is set", async () => {
    process.env.ADMIN_TOKEN = "secret-token";
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyJson("/v1/projects");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ingest.example.test/v1/projects");
    expect(init!.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(init!.cache).toBe("no-store");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("omits the authorization header when no token is configured", async () => {
    delete process.env.ADMIN_TOKEN;
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
