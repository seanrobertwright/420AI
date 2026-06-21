import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseClaudeCodeSession } from "../connectors/claude-code.js";
import { renderSessionReport } from "./session-report.js";

const fixture = readFileSync(new URL("../fixtures/sample-session.jsonl", import.meta.url), "utf8");

describe("renderSessionReport", () => {
  const { events } = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
  const md = renderSessionReport(events);

  it("includes the session id heading", () => {
    expect(md).toContain("# Session Report — sess-fixture-1");
  });

  it("includes the token table header and the aggregated total", () => {
    expect(md).toContain("| input | output | cache_read | cache_write | total |");
    expect(md).toContain("| 100 | 50 | 30 | 20 | 200 |");
  });

  it("includes the cost confidence label", () => {
    expect(md).toContain("`estimated-model-known`");
  });

  it("includes a mermaid token-composition block", () => {
    expect(md).toContain("```mermaid");
    expect(md).toContain("pie showData");
  });

  it("reports the opus model", () => {
    expect(md).toContain("claude-opus-4-8");
  });
});
