import { describe, it, expect } from "vitest";
import { toEventPayload } from "./ingest.js";
import type { NormalizedEvent } from "./events.js";

describe("toEventPayload", () => {
  it("carries every NormalizedEvent field through verbatim", () => {
    const e: NormalizedEvent = {
      fingerprint: "fp1",
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "raw1",
      eventIndex: 3,
      eventType: "tool.call.started",
      sessionId: "sess1",
      projectPath: "/repo",
      gitBranch: "main",
      model: "claude-opus",
      ts: "2026-06-13T00:00:00.000Z",
      tokens: {
        input: 1,
        output: 2,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        tool: 0,
        total: 3,
      },
      cost: { usd: 0.01, confidence: "estimated-model-known", model: "claude-opus" },
      payload: { name: "Read" },
    };
    expect(toEventPayload(e)).toEqual(e);
  });

  it("preserves omitted optional fields as undefined", () => {
    const e: NormalizedEvent = {
      fingerprint: "fp2",
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "raw2",
      eventIndex: 0,
      eventType: "session.started",
      sessionId: "sess1",
      ts: "2026-06-13T00:00:00.000Z",
    };
    const p = toEventPayload(e);
    expect(p.tokens).toBeUndefined();
    expect(p.cost).toBeUndefined();
    expect(p.payload).toBeUndefined();
  });
});
