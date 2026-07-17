import { describe, expect, it } from "vitest";
import { parseSignedCatalogText } from "./signed-catalog.js";

describe("parseSignedCatalogText", () => {
  const valid = JSON.stringify({
    version: "2026-07-15",
    payload: { "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 } },
    signature: "aGVsbG8=",
  });

  it("accepts a well-formed signed document (whitespace-tolerant)", () => {
    const r = parseSignedCatalogText(`\n  ${valid}\n`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.version).toBe("2026-07-15");
      expect(r.doc.signature).toBe("aGVsbG8=");
      expect(r.doc.payload).toHaveProperty("claude-sonnet-5");
    }
  });

  it("rejects empty input with a prompt to paste", () => {
    const r = parseSignedCatalogText("   ");
    expect(r).toEqual({ ok: false, error: "Paste or select a signed catalog document." });
  });

  it("rejects invalid JSON", () => {
    const r = parseSignedCatalogText("{not json");
    expect(r).toEqual({ ok: false, error: "Not valid JSON." });
  });

  it("rejects a non-object top level (array / string)", () => {
    expect(parseSignedCatalogText("[1,2]").ok).toBe(false);
    expect(parseSignedCatalogText('"hi"').ok).toBe(false);
  });

  it.each([
    ["missing version", { payload: {}, signature: "x" }],
    ["empty version", { version: "", payload: {}, signature: "x" }],
    ["missing signature", { version: "v", payload: {} }],
    ["empty signature", { version: "v", payload: {}, signature: "" }],
    ["missing payload", { version: "v", signature: "x" }],
    ["array payload", { version: "v", payload: [1], signature: "x" }],
    ["null payload", { version: "v", payload: null, signature: "x" }],
  ])("rejects %s", (_label, doc) => {
    const r = parseSignedCatalogText(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
