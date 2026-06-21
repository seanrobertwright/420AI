import { describe, it, expect } from "vitest";
import {
  renderCostOverTimeReport,
  renderSessionAutopsyReport,
  fmtUsd,
  REPORT_VERSION,
  type CostOverTimeReportInput,
} from "./reports.js";
import { zeroTokens, type NormalizedTokens } from "./tokens.js";
import type { SessionDetail } from "./projections.js";

function tokens(partial: Partial<NormalizedTokens>): NormalizedTokens {
  const t = { ...zeroTokens(), ...partial };
  t.total = t.input + t.output + t.cache_read + t.cache_write;
  return t;
}

const GENERATED_AT = "2026-06-14T12:00:00.000Z";

describe("fmtUsd", () => {
  it("formats USD to 6 decimals (matches the M1 collector report)", () => {
    expect(fmtUsd(0)).toBe("$0.000000");
    expect(fmtUsd(0.5)).toBe("$0.500000");
    expect(fmtUsd(1.23456789)).toBe("$1.234568");
  });
});

describe("REPORT_VERSION", () => {
  it("is the m7 renderer identity", () => {
    expect(REPORT_VERSION).toBe("m7-report-v1");
  });
});

describe("renderCostOverTimeReport", () => {
  const input: CostOverTimeReportInput = {
    projectName: "420AI",
    generatedAt: GENERATED_AT,
    bucket: "day",
    totals: {
      tokens: tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20 }),
      costUsd: 0.5,
      costConfidence: "estimated-model-known",
      eventCount: 4,
    },
    byModel: [
      {
        model: "claude-opus-4-8",
        tokens: tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20 }),
        costUsd: 0.5,
      },
      {
        model: null,
        tokens: tokens({ input: 5 }),
        costUsd: 0,
      },
    ],
    overTime: [
      {
        bucket: "2026-06-14T00:00:00.000Z",
        tokens: tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20 }),
        costUsd: 0.5,
      },
    ],
  };

  it("renders the title with the project name", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("# Project Cost Report — 420AI");
  });

  it("renders the total cost line with fmtUsd + confidence in backticks", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("- **Total cost:** $0.500000 (`estimated-model-known`)");
    expect(md).toContain("- **Total tokens:** 200");
  });

  it("renders each model row (null model → (unknown))", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("| claude-opus-4-8 | 100 | 50 | 30 | 20 | 200 | $0.500000 |");
    expect(md).toContain("| (unknown) | 5 | 0 | 0 | 0 | 5 | $0.000000 |");
  });

  it("renders each time bucket row", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("| 2026-06-14T00:00:00.000Z | 200 | $0.500000 |");
  });

  it("emits a mermaid pie of token composition", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("```mermaid");
    expect(md).toContain("pie showData");
    expect(md).toContain('"input" : 100');
    expect(md).toContain('"cache_write" : 20');
  });

  it("emits an xychart-beta cost-over-time chart with the source-of-truth note", () => {
    const md = renderCostOverTimeReport(input);
    expect(md).toContain("xychart-beta");
    expect(md).toContain('x-axis ["2026-06-14T00:00:00.000Z"]');
    expect(md).toContain("bar [0.500000]");
    expect(md).toContain("source of truth");
  });

  it("renders valid Markdown for empty/all-zero input (no throw, no chart)", () => {
    const empty: CostOverTimeReportInput = {
      projectName: "(unknown)",
      generatedAt: GENERATED_AT,
      bucket: "day",
      totals: {
        tokens: zeroTokens(),
        costUsd: 0,
        costConfidence: "unknown",
        eventCount: 0,
      },
      byModel: [],
      overTime: [],
    };
    const md = renderCostOverTimeReport(empty);
    expect(md).toContain("# Project Cost Report — (unknown)");
    expect(md).toContain("- **Total cost:** $0.000000 (`unknown`)");
    expect(md).toContain("- **Total tokens:** 0");
    // empty time-series → the note, not an xychart
    expect(md).toContain("_No time-series data._");
    expect(md).not.toContain("xychart-beta");
  });
});

describe("renderSessionAutopsyReport", () => {
  const session: SessionDetail = {
    sessionId: "ms1",
    sourceConnector: "claude-code",
    projectPath: "/home/a/420ai",
    gitBranch: "main",
    models: ["claude-opus-4-8"],
    startedAt: "2026-06-14T00:00:00.000Z",
    endedAt: "2026-06-14T00:03:00.000Z",
    eventCount: 4,
    userMessages: 1,
    assistantMessages: 0,
    toolCalls: 1,
    toolsCompleted: 0,
    toolsFailed: 1,
    filesRead: 0,
    filesModified: 0,
    tokens: tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20 }),
    costUsd: 0.5,
    costConfidence: "estimated-model-known",
  };

  it("renders the session header, counts, token table, cost, and pie", () => {
    const md = renderSessionAutopsyReport({ generatedAt: GENERATED_AT, session });
    expect(md).toContain("# Session Autopsy — ms1");
    expect(md).toContain("- **Connector:** claude-code");
    expect(md).toContain("- **Model(s):** claude-opus-4-8");
    expect(md).toContain("- **Time range:** 2026-06-14T00:00:00.000Z → 2026-06-14T00:03:00.000Z");
    expect(md).toContain("- **Events:** 4 (user: 1, assistant: 0, tool calls: 1)");
    expect(md).toContain("- **Tool outcomes:** 0 completed, 1 failed");
    expect(md).toContain("| 100 | 50 | 30 | 20 | 200 |");
    expect(md).toContain("- **Total estimated cost:** $0.500000");
    expect(md).toContain("- **Confidence:** `estimated-model-known`");
    expect(md).toContain("pie showData");
  });

  it("renders a zeroed (unknown) session without throwing", () => {
    const zeroed: SessionDetail = {
      sessionId: "no-such-session",
      sourceConnector: "",
      projectPath: null,
      gitBranch: null,
      models: [],
      startedAt: null,
      endedAt: null,
      eventCount: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolsCompleted: 0,
      toolsFailed: 0,
      filesRead: 0,
      filesModified: 0,
      tokens: zeroTokens(),
      costUsd: 0,
      costConfidence: "unknown",
    };
    const md = renderSessionAutopsyReport({ generatedAt: GENERATED_AT, session: zeroed });
    expect(md).toContain("# Session Autopsy — no-such-session");
    expect(md).toContain("- **Connector:** (unknown)");
    expect(md).toContain("- **Project path:** (unknown)");
    expect(md).toContain("- **Model(s):** (unknown)");
    expect(md).toContain("- **Time range:** (none)");
    expect(md).toContain("- **Confidence:** `unknown`");
  });
});
