import { afterEach, describe, expect, it } from "vitest";
import { adminHeaders, ingestUrl } from "./ingest.js";

const ORIGINAL_INGEST_URL = process.env.INGEST_URL;
const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN;

afterEach(() => {
  if (ORIGINAL_INGEST_URL === undefined) delete process.env.INGEST_URL;
  else process.env.INGEST_URL = ORIGINAL_INGEST_URL;

  if (ORIGINAL_ADMIN_TOKEN === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN;
});

describe("ingest helpers", () => {
  it("uses the configured ingest URL when present", () => {
    process.env.INGEST_URL = "https://ingest.example.test";
    expect(ingestUrl()).toBe("https://ingest.example.test");
  });

  it("omits the admin authorization header when no token is configured", () => {
    delete process.env.ADMIN_TOKEN;
    expect(adminHeaders()).toEqual({});
  });

  it("returns the admin authorization header when a token is configured", () => {
    process.env.ADMIN_TOKEN = "secret-token";
    expect(adminHeaders()).toEqual({ authorization: "Bearer " + "secret-token" });
  });
});
