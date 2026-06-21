import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseClaudeCodeSession } from "./claude-code.js";

const fixture = readFileSync(new URL("../fixtures/sample-session.jsonl", import.meta.url), "utf8");

const toolsFixture = readFileSync(
  new URL("../fixtures/sample-session-tools.jsonl", import.meta.url),
  "utf8",
);

describe("parseClaudeCodeSession", () => {
  it("tolerantly skips the malformed line and counts it", () => {
    const { skippedLines } = parseClaudeCodeSession(fixture, {
      ingestedAt: "2026-06-13T00:00:00Z",
    });
    expect(skippedLines).toBe(1);
  });

  it("resolves the session id and preserves raw records verbatim", () => {
    const result = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    expect(result.sessionId).toBe("sess-fixture-1");
    // 3 valid lines (1 user + 1 assistant + 1 user tool_result) → 3 raw records.
    expect(result.rawRecords).toHaveLength(3);
    // raw is sacred — payload is the verbatim line.
    expect(result.rawRecords[0]!.payload).toContain('"type":"user"');
  });

  it("emits exactly one usage.reported event with correctly mapped tokens", () => {
    const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const usage = events.filter((e) => e.eventType === "usage.reported");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.tokens).toEqual({
      input: 100,
      output: 50,
      cache_read: 30,
      cache_write: 20,
      reasoning: 0,
      tool: 0,
      total: 200,
    });
  });

  it("emits a cost.estimated event with known-model confidence and usd > 0", () => {
    const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const cost = events.find((e) => e.eventType === "cost.estimated");
    expect(cost).toBeDefined();
    expect(cost!.cost?.confidence).toBe("estimated-model-known");
    expect(cost!.cost?.usd).toBeGreaterThan(0);
    expect(cost!.model).toBe("claude-opus-4-8");
  });

  it("emits session.started and session.ended bracketing the timestamps", () => {
    const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const started = events.find((e) => e.eventType === "session.started");
    const ended = events.find((e) => e.eventType === "session.ended");
    expect(started!.ts).toBe("2026-06-13T10:00:00.000Z");
    expect(ended!.ts).toBe("2026-06-13T10:00:10.000Z");
  });

  it("emits a tool.call.started for the tool_use block", () => {
    const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const tools = events.filter((e) => e.eventType === "tool.call.started");
    expect(tools).toHaveLength(1);
  });

  it("stamps PRICING_CATALOG_VERSION on every emitted event (PRD §23)", () => {
    const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.catalogVersion === "m10-catalog-v1")).toBe(true);
  });

  it("produces identical fingerprints when parsing the same text twice", () => {
    const a = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const b = parseClaudeCodeSession(fixture, { ingestedAt: "2099-01-01T00:00:00Z" });
    expect(a.events.map((e) => e.fingerprint)).toEqual(b.events.map((e) => e.fingerprint));
  });
});

describe("parseClaudeCodeSession — M4 full fidelity (tool lifecycle / file / context)", () => {
  it("correlates tool.call.completed and tool.call.failed by tool_use_id", () => {
    const { events } = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const completed = events.filter((e) => e.eventType === "tool.call.completed");
    const failed = events.filter((e) => e.eventType === "tool.call.failed");
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // is_error:false → completed for the Read call; is_error:true → failed for Edit.
    expect(completed[0]!.payload).toMatchObject({ tool_use_id: "tu-read", name: "Read" });
    expect(failed[0]!.payload).toMatchObject({ tool_use_id: "tu-edit", name: "Edit" });
  });

  it("still emits tool.call.started for each tool_use block", () => {
    const { events } = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const started = events.filter((e) => e.eventType === "tool.call.started");
    expect(started).toHaveLength(2);
  });

  it("emits file.read and file.modified carrying the file_path", () => {
    const { events } = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const read = events.find((e) => e.eventType === "file.read");
    const modified = events.find((e) => e.eventType === "file.modified");
    expect(read!.payload).toEqual({ path: "/home/dev/project/a.ts" });
    expect(modified!.payload).toEqual({ path: "/home/dev/project/b.ts" });
  });

  it("emits context.loaded for an attachment record", () => {
    const { events } = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const ctx = events.filter((e) => e.eventType === "context.loaded");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.payload).toEqual({ attachmentType: "deferred_tools_delta" });
  });

  it("keeps fingerprints stable across two parses (new event types included)", () => {
    const a = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const b = parseClaudeCodeSession(toolsFixture, { ingestedAt: "2099-01-01T00:00:00Z" });
    expect(a.events.map((e) => e.fingerprint)).toEqual(b.events.map((e) => e.fingerprint));
    // No two events collide on the same fingerprint.
    const fps = a.events.map((e) => e.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
