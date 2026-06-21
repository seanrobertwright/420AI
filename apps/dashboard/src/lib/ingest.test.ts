import { afterEach, describe, expect, it, vi } from "vitest";

// Mock next/headers' async cookies() so adminHeaders() reads a controllable session cookie.
// vi.hoisted keeps the shared state initialized before the hoisted vi.mock factory runs.
const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) =>
      cookieState.value !== undefined ? { value: cookieState.value } : undefined,
  }),
}));

import { adminHeaders, ingestUrl } from "./ingest.js";

const ORIGINAL_INGEST_URL = process.env.INGEST_URL;

afterEach(() => {
  if (ORIGINAL_INGEST_URL === undefined) delete process.env.INGEST_URL;
  else process.env.INGEST_URL = ORIGINAL_INGEST_URL;
  cookieState.value = undefined;
});

describe("ingest helpers", () => {
  it("uses the configured ingest URL when present", () => {
    process.env.INGEST_URL = "https://ingest.example.test";
    expect(ingestUrl()).toBe("https://ingest.example.test");
  });

  it("defaults to the local ingest port when INGEST_URL is unset", () => {
    delete process.env.INGEST_URL;
    expect(ingestUrl()).toBe("http://localhost:8420");
  });

  it("omits the admin authorization header when there is no session cookie", async () => {
    cookieState.value = undefined;
    expect(await adminHeaders()).toEqual({});
  });

  it("returns the session token as the bearer when the cookie is present", async () => {
    cookieState.value = "session-token";
    expect(await adminHeaders()).toEqual({ authorization: "Bearer " + "session-token" });
  });
});
