import { describe, it, expect, afterEach } from "vitest";
import { sessionConfigError } from "./session.js";

/**
 * D.3 regression: the dashboard must fail LOUDLY when SESSION_SECRET is missing instead of silently
 * bouncing every fresh login back to /login. sessionConfigError() is the shared guard the login route
 * (500 + on-form message) and the middleware (server-log) both use.
 */
const ORIG = process.env.SESSION_SECRET;

afterEach(() => {
  if (ORIG === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIG;
});

describe("sessionConfigError (D.3 — loud check for missing SESSION_SECRET)", () => {
  it("returns an actionable message when SESSION_SECRET is unset", () => {
    delete process.env.SESSION_SECRET;
    const err = sessionConfigError();
    expect(err).not.toBeNull();
    expect(err).toContain("SESSION_SECRET");
    expect(err).toContain(".env.local");
  });

  it("returns a message when SESSION_SECRET is the empty string", () => {
    process.env.SESSION_SECRET = "";
    expect(sessionConfigError()).not.toBeNull();
  });

  it("returns null when SESSION_SECRET is configured", () => {
    process.env.SESSION_SECRET = "some-shared-secret";
    expect(sessionConfigError()).toBeNull();
  });
});
