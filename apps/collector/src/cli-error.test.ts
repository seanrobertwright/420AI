import { describe, it, expect } from "vitest";
import { formatCliError } from "./cli.js";
import { NotPairedError } from "./identity.js";

/**
 * C.6: a stopped ingest server made every one-shot command print only "Error: fetch failed", with no
 * hint that the archive was unreachable. formatCliError turns Node's opaque fetch throw into an
 * actionable message while leaving other errors untouched.
 */
describe("formatCliError (C.6 — actionable network errors)", () => {
  it("turns a bare 'fetch failed' (ECONNREFUSED) into an archive-unreachable hint", () => {
    const msg = formatCliError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    expect(msg).toContain("Could not reach the archive");
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).toContain("ingest server running");
    expect(msg).not.toBe("Error: fetch failed");
  });

  it("handles a DNS failure (ENOTFOUND) the same way", () => {
    const msg = formatCliError(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }));
    expect(msg).toContain("Could not reach the archive");
    expect(msg).toContain("ENOTFOUND");
  });

  it("passes a NotPairedError message through verbatim (no 'Error:' prefix)", () => {
    expect(formatCliError(new NotPairedError("not paired — run `collector pair <code>`"))).toBe(
      "not paired — run `collector pair <code>`",
    );
  });

  it("falls back to 'Error: <message>' for ordinary errors", () => {
    expect(formatCliError(new Error("boom"))).toBe("Error: boom");
  });
});
