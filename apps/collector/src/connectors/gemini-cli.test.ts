import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseGeminiSession } from "./gemini-cli.js";

const fixture = readFileSync(
  new URL("../fixtures/sample-gemini-session.json", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-06-13T00:00:00Z" };

describe("parseGeminiSession", () => {
  it("parses the whole-file JSON and resolves session id + projectHash", () => {
    const { sessionId, events } = parseGeminiSession(fixture, opts);
    expect(sessionId).toBe("gemini-sess-1");
    const e = events.find((ev) => ev.eventType === "usage.reported")!;
    expect(e.projectPath).toBe("a1b2c3d4e5f6"); // projectHash stored as-is (M5 maps it)
  });

  it("folds thoughts(+tool) into output so computeTotal reproduces the vendor total", () => {
    const { events } = parseGeminiSession(fixture, opts);
    const usage = events.filter((e) => e.eventType === "usage.reported");
    expect(usage).toHaveLength(1);
    // VERIFIED arithmetic (D1): cached ⊂ input; thoughts additive → folded into output.
    expect(usage[0]!.tokens).toEqual({
      input: 7877, // 28118 − 20241 cached
      output: 240, // 198 + 42 thoughts (+0 tool)
      cache_read: 20241,
      cache_write: 0,
      reasoning: 42,
      tool: 0,
      total: 28358,
    });
    // total reproduces the vendor `total` (28358 = input + output + thoughts).
    expect(usage[0]!.tokens!.total).toBe(28358);
  });

  it("emits a cost.estimated with known-model confidence (pricing catalogued)", () => {
    const { events } = parseGeminiSession(fixture, opts);
    const cost = events.find((e) => e.eventType === "cost.estimated");
    expect(cost!.cost?.confidence).toBe("estimated-model-known");
    expect(cost!.cost?.usd).toBeGreaterThan(0);
    expect(cost!.model).toBe("gemini-3-flash-preview");
  });

  it("maps tool-call status to completed/failed", () => {
    const { events } = parseGeminiSession(fixture, opts);
    const completed = events.filter((e) => e.eventType === "tool.call.completed");
    const failed = events.filter((e) => e.eventType === "tool.call.failed");
    const started = events.filter((e) => e.eventType === "tool.call.started");
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(1); // read_file: success
    expect(failed).toHaveLength(1); // write_file: error
  });

  it("tolerates a malformed/mid-rewrite whole-file blob (empty result, skippedLines 1)", () => {
    const result = parseGeminiSession("{not valid json", opts);
    expect(result.rawRecords).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.skippedLines).toBe(1);
  });

  it("keeps one raw record per message keyed on message.id", () => {
    const { rawRecords } = parseGeminiSession(fixture, opts);
    // 3 messages: info + user + gemini.
    expect(rawRecords).toHaveLength(3);
    expect(rawRecords.map((r) => r.id)).toEqual(["msg-0", "msg-1", "msg-2"]);
  });

  it("produces identical fingerprints across two parses (stable across rewrites)", () => {
    const a = parseGeminiSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const b = parseGeminiSession(fixture, { ingestedAt: "2099-01-01T00:00:00Z" });
    expect(a.events.map((e) => e.fingerprint)).toEqual(b.events.map((e) => e.fingerprint));
    const fps = a.events.map((e) => e.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
