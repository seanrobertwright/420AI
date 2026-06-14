import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCodexSession } from "./codex-cli.js";

const fixture = readFileSync(
  new URL("../fixtures/sample-codex-rollout.jsonl", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-06-13T00:00:00Z" };

describe("parseCodexSession", () => {
  it("tolerantly skips the malformed line and counts it", () => {
    const { skippedLines } = parseCodexSession(fixture, opts);
    expect(skippedLines).toBe(1);
  });

  it("resolves session id, cwd, and git branch from session_meta", () => {
    const { events, sessionId } = parseCodexSession(fixture, opts);
    expect(sessionId).toBe("codex-sess-1");
    const e = events.find((ev) => ev.eventType === "usage.reported")!;
    expect(e.sessionId).toBe("codex-sess-1");
    expect(e.projectPath).toBe("/home/dev/project");
    expect(e.gitBranch).toBe("m4-connectors");
  });

  it("carries the model forward from turn_context onto token/tool events", () => {
    const { events } = parseCodexSession(fixture, opts);
    const usage = events.filter((e) => e.eventType === "usage.reported");
    expect(usage.every((e) => e.model === "gpt-5.5")).toBe(true);
  });

  it("emits one usage.reported per token_count using the DELTA (last_token_usage)", () => {
    const { events } = parseCodexSession(fixture, opts);
    const usage = events.filter((e) => e.eventType === "usage.reported");
    expect(usage).toHaveLength(2);
    // First token_count delta — VERIFIED arithmetic (D1/D2).
    expect(usage[0]!.tokens).toEqual({
      input: 14814, // 19806 − 4992 cached
      output: 215,
      cache_read: 4992,
      cache_write: 0,
      reasoning: 92,
      tool: 0,
      total: 20021,
    });
    // total reproduces the vendor last_token_usage.total_tokens exactly.
    expect(usage[0]!.tokens!.total).toBe(20021);
    expect(usage[1]!.tokens!.total).toBe(1050);
  });

  it("DELTAS sum to the session's cumulative total (regression guard vs total_token_usage)", () => {
    const { events } = parseCodexSession(fixture, opts);
    const usage = events.filter((e) => e.eventType === "usage.reported");
    const summed = usage.reduce((acc, e) => acc + (e.tokens?.total ?? 0), 0);
    // Final total_token_usage.total_tokens in the fixture is 21071.
    expect(summed).toBe(21071);
  });

  it("emits a cost.estimated with known-model confidence (pricing catalogued)", () => {
    const { events } = parseCodexSession(fixture, opts);
    const cost = events.find((e) => e.eventType === "cost.estimated");
    expect(cost!.cost?.confidence).toBe("estimated-model-known");
    expect(cost!.cost?.usd).toBeGreaterThan(0);
    expect(cost!.model).toBe("gpt-5.5");
  });

  it("emits tool.call.started + tool.call.completed for a function_call/output pair", () => {
    const { events } = parseCodexSession(fixture, opts);
    const started = events.filter((e) => e.eventType === "tool.call.started");
    const completed = events.filter((e) => e.eventType === "tool.call.completed");
    expect(started).toHaveLength(2); // shell + apply_patch
    expect(completed).toHaveLength(1); // only the shell call has an output record
    expect(started[0]!.payload).toMatchObject({ name: "shell", call_id: "call-1" });
  });

  it("emits file.modified for patch_apply_end", () => {
    const { events } = parseCodexSession(fixture, opts);
    const files = events.filter((e) => e.eventType === "file.modified");
    expect(files).toHaveLength(1);
  });

  it("brackets the session with session.started/ended", () => {
    const { events } = parseCodexSession(fixture, opts);
    const started = events.find((e) => e.eventType === "session.started");
    const ended = events.find((e) => e.eventType === "session.ended");
    expect(started!.ts).toBe("2026-06-13T12:00:00.000Z");
    expect(ended!.ts).toBe("2026-06-13T12:00:12.000Z");
  });

  it("produces identical fingerprints across two parses", () => {
    const a = parseCodexSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    const b = parseCodexSession(fixture, { ingestedAt: "2099-01-01T00:00:00Z" });
    expect(a.events.map((e) => e.fingerprint)).toEqual(b.events.map((e) => e.fingerprint));
    const fps = a.events.map((e) => e.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
