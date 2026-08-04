import { describe, it, expect } from "vitest";
import type { DataQualityInputs, ReconciliationSampleRow } from "./data-quality.js";
import { deriveDataQualityMetrics } from "./data-quality.js";
import { AUDIT_REPORT_VERSION, renderDataQualityAuditReport } from "./reports-audit.js";

/**
 * M16 16.4 — renderer tests. The rendered Markdown IS the deliverable (it is copied into the §10
 * weekly scorecard by hand), so the assertions here are about what a reader's eye lands on: an
 * unmeasurable metric must show its REASON in the value cell, and the report must never wear the
 * badge a healthy-looking zero would wear.
 */

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const GENERATED_AT = "2026-08-04T12:00:00.000Z";

function baseInputs(over: Partial<DataQualityInputs> = {}): DataQualityInputs {
  return {
    windowDays: 7,
    sinceIso: "2026-07-28T12:00:00.000Z",
    sessions: [],
    rawTotals: { rawRows: 0, yieldedEvents: 0 },
    duplicates: { duplicateEvents: 0, distinctEvents: 0 },
    lag: [],
    declarations: [],
    gitLinks: [],
    captureHealth: { machines: [], declared: [], observed: [] },
    sample: [],
    recoverability: [],
    ...over,
  };
}

function sampleRow(id: string): ReconciliationSampleRow {
  return {
    sessionId: id,
    sourceConnector: "claude-code",
    machineId: "m1",
    rawRecordCount: 3,
    eventCount: 10,
    eventsWithTokens: 4,
    models: ["claude-sonnet-5"],
    costConfidences: ["estimated-model-known"],
    indexed: true,
    projectPath: "/repo",
    attributed: true,
    firstTs: "2026-08-01T00:00:00.000Z",
    lastTs: "2026-08-01T01:00:00.000Z",
  };
}

function render(over: Partial<DataQualityInputs> = {}): string {
  const metrics = deriveDataQualityMetrics(baseInputs(over), NOW);
  return renderDataQualityAuditReport({ ...metrics, generatedAt: GENERATED_AT });
}

describe("renderDataQualityAuditReport", () => {
  it("has a version identity of its own, separate from the derivation's", () => {
    expect(AUDIT_REPORT_VERSION).toBe("m16-audit-v1");
  });

  it("emits every required section, in order", () => {
    const md = render();
    const headings = md
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(headings).toEqual([
      "§5.1 Data quality",
      "Capture health (from 16.3)",
      "Git outcome confidence (§7 P1.7)",
      "§4.4 Reconciliation worksheet",
      "Scope and caveats",
      "Connector verdicts (chart)",
    ]);
  });

  it("renders the window as a date range and stamps both derivation versions", () => {
    const md = render();
    expect(md).toContain("**Window:** 2026-07-28 → 2026-08-04 (7 days)");
    expect(md).toContain("`m16-data-quality-v1`");
    expect(md).toContain("`m16-capture-health-v1`");
  });

  it("renders an unknown metric's REASON in the value cell — never a dash and never 0%", () => {
    const md = render();
    const row = md.split("\n").find((l) => l.startsWith("| Capture coverage |"));
    expect(row).toBeDefined();
    expect(row).toContain("**unknown**");
    expect(row).toContain("§4.4");
    expect(row).not.toContain("0%");
    expect(row).not.toContain(" — |");
  });

  it("THE REGRESSION TEST: an empty window renders no `100%` anywhere", () => {
    // A zero denominator must never wear the badge a real 100% would. This is the healthy-looking
    // zero 16.3 shipped a fix for, one layer up — `0 parse failures ÷ 0 raw records` and `0 ÷ 4000`
    // are opposite facts, and this assertion is what keeps them looking different.
    const md = render();
    expect(md).not.toContain("100%");
    for (const label of [
      "Capture coverage",
      "Project attribution — coverage",
      "Project attribution — correctness",
      "Token completeness",
      "Parse success",
      "Duplicate rate",
      "Sync freshness",
      "Recoverability",
    ]) {
      const row = md.split("\n").find((l) => l.startsWith(`| ${label} |`));
      expect(row, `${label} row must exist`).toBeDefined();
      expect(row, `${label} must render unknown`).toContain("**unknown**");
    }
  });

  it("still renders a genuine perfect score, as 100.0% — the token is reserved, not the fact", () => {
    const md = render({
      sessions: [
        {
          sessionId: "a",
          sourceConnector: "claude-code",
          eventCount: 4,
          withTokens: 4,
          attributed: true,
          firstTs: null,
          lastTs: null,
        },
      ],
      declarations: [{ connectorId: "claude-code", tokens: "exact", liveness: "streaming" }],
    });
    const row = md.split("\n").find((l) => l.startsWith("| Token completeness |"));
    expect(row).toContain("100.0% (1 / 1)");
    expect(row).toContain("| measured |");
  });

  it("carries the mandatory §7 P1.7 causation caveat verbatim", () => {
    expect(render()).toContain(
      "**A heuristic link is a time/file-overlap correlation, not evidence of causation.**",
    );
  });

  it("renders the worksheet with one row per sampled session and both human checks blank", () => {
    const md = render({ sample: [sampleRow("s-a"), sampleRow("s-b")] });
    const rows = md.split("\n").filter((l) => l.startsWith("| s-"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Checks 1 and 4 are literal blanks; 2/3/5/6 are pre-filled from the archive.
      expect(row.match(/\| \( \) \|/g)).toHaveLength(2);
      expect(row).toContain("10 events, 4 with tokens");
      expect(row).toContain("estimated-model-known");
    }
    expect(md).toContain("2 session(s), selected deterministically by `md5(session_id)`");
  });

  it("renders an italic empty-state line rather than a bare empty table body", () => {
    const md = render();
    expect(md).toContain("| _No sessions in the window to sample._ |");
    expect(md).toContain("| _No connectors declared or observed._ |");
    expect(md).toContain("_No connector verdicts to chart._");
  });

  it("labels the Mermaid block illustrative and keeps the tables authoritative", () => {
    const md = render({
      captureHealth: {
        machines: [{ id: "m1", name: "laptop", status: "online" }],
        declared: [],
        observed: [
          {
            machineId: "m1",
            connectorId: "mystery",
            lastEventAt: "2026-08-04T11:00:00.000Z",
            eventCount: 3,
            parserVersions: [],
          },
        ],
      },
    });
    expect(md).toContain(
      "<!-- The tables above are the source of truth; this chart is illustrative. -->",
    );
    expect(md).toContain("```mermaid");
    expect(md).toContain("pie showData");
  });

  it("renders the three scope caveats the report must carry, not only the plan", () => {
    const md = render();
    expect(md).toContain("Fixed observation set (D-M16-1)");
    expect(md).toContain("What the duplicate rate cannot see (D-16.4-3)");
    expect(md).toContain("Coverage is not correctness (D-16.4-4)");
  });

  it("escapes a pipe in a session id so one bad value cannot break the whole table", () => {
    const md = render({ sample: [{ ...sampleRow("a|b"), sessionId: "a|b" }] });
    expect(md).toContain("| a\\|b |");
  });

  it("is pure — the same inputs render byte-identically twice", () => {
    expect(render({ sample: [sampleRow("s-a")] })).toBe(render({ sample: [sampleRow("s-a")] }));
  });
});
