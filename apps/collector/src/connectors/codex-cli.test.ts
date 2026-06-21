import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCodexSession, classifyCodexOutput } from "./codex-cli.js";

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
    expect(started).toHaveLength(3); // shell call-1 + apply_patch call-2 + custom shell call-3
    expect(completed).toHaveLength(2); // call-1 old synthetic + call-6 structured exit 0
    expect(started[0]!.payload).toMatchObject({ name: "shell", call_id: "call-1" });
  });

  it("emits file.modified for patch_apply_end (success only)", () => {
    const { events } = parseCodexSession(fixture, opts);
    const files = events.filter((e) => e.eventType === "file.modified");
    expect(files).toHaveLength(1); // only the success:true line; success:false is a failure
  });

  it("classifies tool-output failures into tool.call.failed with §14 classes", () => {
    const { events } = parseCodexSession(fixture, opts);
    const failed = events.filter((e) => e.eventType === "tool.call.failed");
    // call-3 env/127, call-4 tool-runtime/1, call-5 state-mismatch, patch_apply_end success:false
    expect(failed).toHaveLength(4);
    expect(
      failed.find((e) => (e.payload as Record<string, unknown>)?.call_id === "call-3")?.payload,
    ).toMatchObject({
      failureClass: "environment",
      exitCode: 127,
    });
    expect(
      failed.find((e) => (e.payload as Record<string, unknown>)?.call_id === "call-4")?.payload,
    ).toMatchObject({
      failureClass: "tool-runtime",
      exitCode: 1,
    });
    expect(
      failed.find((e) => (e.payload as Record<string, unknown>)?.call_id === "call-5")?.payload,
    ).toMatchObject({
      failureClass: "state-mismatch",
    });
    // the defensive patch_apply_end success:false carries no call_id, just the class
    expect(
      failed.some(
        (e) =>
          (e.payload as Record<string, unknown>)?.failureClass === "state-mismatch" &&
          !(e.payload as Record<string, unknown>)?.call_id,
      ),
    ).toBe(true);
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

describe("classifyCodexOutput", () => {
  it("structured exit 0 envelope ⇒ completed (with exitCode echoed)", () => {
    expect(
      classifyCodexOutput('{"output":"ok","metadata":{"exit_code":0,"duration_seconds":0.7}}'),
    ).toEqual({ failed: false, exitCode: 0 });
  });

  it("structured nonzero exit ⇒ failed/tool-runtime", () => {
    expect(classifyCodexOutput('{"output":"Cannot find path","metadata":{"exit_code":1}}')).toEqual(
      { failed: true, failureClass: "tool-runtime", exitCode: 1 },
    );
  });

  it("structured exit 124 (timeout) ⇒ failed/environment", () => {
    expect(
      classifyCodexOutput(
        '{"output":"command timed out after 10304 ms","metadata":{"exit_code":124}}',
      ),
    ).toEqual({ failed: true, failureClass: "environment", exitCode: 124 });
  });

  it("structured exit 127 (not found) ⇒ failed/environment", () => {
    expect(
      classifyCodexOutput('{"output":"bash: x: command not found","metadata":{"exit_code":127}}'),
    ).toEqual({ failed: true, failureClass: "environment", exitCode: 127 });
  });

  it("bare-string apply_patch verification failed ⇒ failed/state-mismatch (no exitCode)", () => {
    expect(
      classifyCodexOutput("apply_patch verification failed: Failed to find expected lines in x"),
    ).toEqual({ failed: true, failureClass: "state-mismatch" });
  });

  it("bare-string command-timeout text (no envelope) ⇒ failed/environment", () => {
    expect(classifyCodexOutput("command timed out after 5000 ms")).toEqual({
      failed: true,
      failureClass: "environment",
    });
  });

  it("old synthetic non-JSON 'Exit code: 0' string ⇒ completed (regression guard)", () => {
    expect(classifyCodexOutput("Exit code: 0\nWall time: 0.5 seconds\nOutput:\nfile.ts")).toEqual({
      failed: false,
    });
  });

  it("envelope without metadata ⇒ completed (no exit_code signal)", () => {
    expect(classifyCodexOutput('{"output":"hi"}')).toEqual({ failed: false });
  });

  it("non-string output ⇒ completed, never throws", () => {
    expect(classifyCodexOutput(undefined)).toEqual({ failed: false });
    expect(classifyCodexOutput({ output: "x" })).toEqual({ failed: false });
  });
});
