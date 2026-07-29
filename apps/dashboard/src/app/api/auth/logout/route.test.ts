import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * M15 15.6 — unit coverage for the logout Route Handler, and it exists for ONE reason: the
 * ORDERING of its two statements is load-bearing and was, until this file, asserted only by a
 * comment.
 *
 * `proxyJson` → `adminHeaders()` sources the bearer from the `ai_session` cookie. So the ingest
 * revoke hop MUST run BEFORE `cookies().delete(...)`. Swap the two lines and logout silently
 * reverts to clearing the browser's copy while the session stays live server-side for the rest of
 * its seven days — which is exactly the bug 15.6 exists to fix, restored without a single failing
 * test: Route Handlers are not otherwise exercised here, and the ingest-side suite only proves that
 * `POST /v1/auth/logout` works when it is actually called with a credential.
 *
 * Mocking pattern copied from `apps/dashboard/src/lib/proxy.test.ts` (`vi.hoisted` + `vi.mock` for
 * `next/headers`), so the call-order assertion below is the only new idea in the file.
 */

// `vi.hoisted` keeps the shared recorder initialized before the hoisted `vi.mock` factories run.
const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: (name: string) => {
      calls.order.push(`cookie.delete:${name}`);
    },
  }),
}));

const proxyResult = vi.hoisted(() => ({ throws: false }));
vi.mock("@/lib/proxy", () => ({
  proxyJson: async (path: string, init?: { method?: string }) => {
    calls.order.push(`proxyJson:${init?.method ?? "GET"} ${path}`);
    if (proxyResult.throws) throw new Error("ingest unreachable");
    return new Response("{}", { status: 200 });
  },
}));

import { POST } from "./route.js";

afterEach(() => {
  calls.order.length = 0;
  proxyResult.throws = false;
});

describe("POST /api/auth/logout", () => {
  it("calls ingest's revoke BEFORE clearing the cookie, and clears it", async () => {
    const res = await POST();

    // THE ASSERTION THIS FILE EXISTS FOR. Order, not merely presence: with the statements
    // swapped the cookie is gone before `adminHeaders()` can read it, so the revoke hop goes out
    // unauthenticated, ingest answers 401, and the session survives.
    expect(calls.order).toEqual(["proxyJson:POST /v1/auth/logout", "cookie.delete:ai_session"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still clears the cookie when the ingest hop THROWS", async () => {
    // `proxyJson` collapses an unreachable upstream to a 502 RESPONSE rather than throwing, so this
    // covers the harsher case it does not: something raised before or around the fetch, e.g.
    // `adminHeaders()`'s own `await cookies()`. Writing this test is what found the bug — the first
    // implementation had no `try`, so a throw here skipped the delete and stranded the user
    // signed-in, in precisely the scenario the handler's comment promised it would not.
    proxyResult.throws = true;

    const res = await POST();

    expect(res.status).toBe(200);
    expect(calls.order, "the cookie must be cleared even when the revoke hop fails").toEqual([
      "proxyJson:POST /v1/auth/logout",
      "cookie.delete:ai_session",
    ]);
  });
});
