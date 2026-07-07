import type {
  UsageTotals,
  UsageByModelRow,
  UsageOverTimeRow,
  SessionDetail,
} from "./projections.js";
import {
  CONTEXT_WASTE_CLASSES,
  type ToolModelComparisonInput,
  type FailedToolReportInput,
  type ContextWasteInput,
  type EfficiencyInput,
  type TrendAnomaliesInput,
} from "./report-metrics.js";

/**
 * M7 Reporting Foundation (PRD §15, §16.1, §23). Pure Markdown+Mermaid renderers
 * over the M6 deterministic projection shapes — the same "pure function returns a
 * string" contract as the M1 collector `renderSessionReport`, but keyed off
 * projection inputs and clock-injected (the caller passes `generatedAt`).
 *
 * Every report is rendered exclusively from the plaintext-queryable projections
 * (counts/tokens/cost/model/paths/timestamps) — this module NEVER decrypts a
 * payload and NEVER reads an event body (PRD §18.1, D3). `@420ai/shared` stays
 * dependency-free: type-only imports, no I/O, no `new Date()`.
 */

/**
 * Dotted-lowercase per the EventType naming convention (events.ts). The two
 * `*.ai_interpretation` members are the M8 AI artifacts (PRD §16.2); they reuse the
 * SAME `report_artifacts` store as the M7 deterministic reports (D2 — no migration).
 */
export type ReportType =
  | "project.cost_over_time"
  | "session.autopsy"
  | "session.ai_interpretation"
  | "project.ai_interpretation"
  | "project.tool_model_comparison"
  | "project.failed_tool_calls"
  | "project.context_waste"
  | "project.efficiency"
  | "project.trend_anomalies";

/**
 * Renderer identity stamped on every artifact for replay/versioning (PRD §23).
 * Bump when the rendered Markdown changes so a future replay can distinguish
 * artifacts produced by an older renderer.
 */
export const REPORT_VERSION = "m7-report-v1";

/**
 * M13 13.2: the five new report types stamp THIS identity, not `REPORT_VERSION` —
 * the two M7 renderers are untouched (their artifacts keep comparing against
 * `REPORT_VERSION`), while the new renderers get their own versioning lineage
 * from day one.
 */
export const REPORT_VERSION_M13 = "m13-report-v1";

/**
 * 6-decimal USD — sessions are cheap; 2 decimals reads as "$0.00". Behavior-
 * identical to the collector's private `fmtUsd` (session-report.ts:9-12) so a
 * server-side report reads the same as the M1 CLI report.
 */
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

export interface CostOverTimeReportInput {
  projectName: string;
  generatedAt: string; // ISO — injected by the caller (clock-free renderer, CLAUDE.md)
  bucket: "day" | "week";
  totals: UsageTotals;
  byModel: UsageByModelRow[];
  overTime: UsageOverTimeRow[];
}

/**
 * Render the project cost-over-time report: a headline bullet list, a per-model
 * table, a per-bucket time-series table, a token-composition `pie showData`, and
 * an `xychart-beta` bar of cost-per-bucket. The TABLES are the source of truth;
 * the `xychart-beta` is illustrative (a newer Mermaid type a viewer may not
 * render — the data table guarantees the numbers regardless).
 */
export function renderCostOverTimeReport(input: CostOverTimeReportInput): string {
  const { projectName, generatedAt, bucket, totals, byModel, overTime } = input;
  const lines: string[] = [];

  lines.push(`# Project Cost Report — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Bucket:** ${bucket}`);
  lines.push(`- **Total cost:** ${fmtUsd(totals.costUsd)} (\`${totals.costConfidence}\`)`);
  lines.push(`- **Total tokens:** ${totals.tokens.total}`);
  lines.push(`- **Events:** ${totals.eventCount}`);
  lines.push("");

  lines.push("## Usage by model");
  lines.push("");
  lines.push("| model | input | output | cache_read | cache_write | total | cost |");
  lines.push("| ----- | ----- | ------ | ---------- | ----------- | ----- | ---- |");
  for (const m of byModel) {
    const t = m.tokens;
    lines.push(
      `| ${m.model ?? "(unknown)"} | ${t.input} | ${t.output} | ${t.cache_read} | ${t.cache_write} | ${t.total} | ${fmtUsd(m.costUsd)} |`,
    );
  }
  lines.push("");

  lines.push(`## Usage over time (by ${bucket})`);
  lines.push("");
  lines.push("| bucket | total tokens | cost |");
  lines.push("| ------ | ------------ | ---- |");
  for (const r of overTime) {
    lines.push(`| ${r.bucket} | ${r.tokens.total} | ${fmtUsd(r.costUsd)} |`);
  }
  lines.push("");

  lines.push("## Token composition");
  lines.push("");
  lines.push("```mermaid");
  lines.push("pie showData");
  lines.push("    title Token composition");
  lines.push(`    "input" : ${totals.tokens.input}`);
  lines.push(`    "output" : ${totals.tokens.output}`);
  lines.push(`    "cache_read" : ${totals.tokens.cache_read}`);
  lines.push(`    "cache_write" : ${totals.tokens.cache_write}`);
  lines.push("```");
  lines.push("");

  lines.push("## Cost over time (chart)");
  lines.push("");
  lines.push(
    "<!-- The 'Usage over time' table above is the source of truth; this chart is illustrative. -->",
  );
  if (overTime.length > 0) {
    const labels = overTime.map((r) => `"${r.bucket}"`).join(", ");
    const values = overTime.map((r) => r.costUsd.toFixed(6)).join(", ");
    const maxCost = Math.max(...overTime.map((r) => r.costUsd), 0);
    const upper = maxCost > 0 ? maxCost.toFixed(6) : "1";
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push('    title "Cost per bucket (USD)"');
    lines.push(`    x-axis [${labels}]`);
    lines.push(`    y-axis "Cost (USD)" 0 --> ${upper}`);
    lines.push(`    bar [${values}]`);
    lines.push("```");
  } else {
    lines.push("_No time-series data._");
  }
  lines.push("");

  return lines.join("\n");
}

export interface SessionAutopsyReportInput {
  generatedAt: string; // ISO — injected by the caller
  session: SessionDetail;
}

/**
 * Render one session's metrics autopsy (PRD §15) from the M6 `sessionDetail`
 * projection — mirrors the M1 `renderSessionReport` shape (header bullets, token
 * table, cost section, token-composition pie). Metrics-only: no prompt/output
 * quoting (that is the M8 content autopsy, which needs the redaction path). A
 * zeroed projection (unknown session) renders a valid "empty session" report (D7).
 */
export function renderSessionAutopsyReport(input: SessionAutopsyReportInput): string {
  const { generatedAt, session: s } = input;
  const lines: string[] = [];

  lines.push(`# Session Autopsy — ${s.sessionId}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Connector:** ${s.sourceConnector || "(unknown)"}`);
  lines.push(`- **Project path:** ${s.projectPath ?? "(unknown)"}`);
  lines.push(`- **Git branch:** ${s.gitBranch ?? "(unknown)"}`);
  lines.push(`- **Model(s):** ${s.models.length ? s.models.join(", ") : "(unknown)"}`);
  const timeRange = s.startedAt && s.endedAt ? `${s.startedAt} → ${s.endedAt}` : "(none)";
  lines.push(`- **Time range:** ${timeRange}`);
  lines.push(
    `- **Events:** ${s.eventCount} (user: ${s.userMessages}, assistant: ${s.assistantMessages}, tool calls: ${s.toolCalls})`,
  );
  lines.push(`- **Files touched:** ${s.filesRead} read, ${s.filesModified} modified`);
  lines.push(`- **Tool outcomes:** ${s.toolsCompleted} completed, ${s.toolsFailed} failed`);
  lines.push("");

  lines.push("## Token usage");
  lines.push("");
  lines.push("| input | output | cache_read | cache_write | total |");
  lines.push("| ----- | ------ | ---------- | ----------- | ----- |");
  lines.push(
    `| ${s.tokens.input} | ${s.tokens.output} | ${s.tokens.cache_read} | ${s.tokens.cache_write} | ${s.tokens.total} |`,
  );
  lines.push("");

  lines.push("## Cost");
  lines.push("");
  lines.push(`- **Total estimated cost:** ${fmtUsd(s.costUsd)}`);
  lines.push(`- **Confidence:** \`${s.costConfidence}\``);
  lines.push("");

  lines.push("## Token composition");
  lines.push("");
  lines.push("```mermaid");
  lines.push("pie showData");
  lines.push("    title Token composition");
  lines.push(`    "input" : ${s.tokens.input}`);
  lines.push(`    "output" : ${s.tokens.output}`);
  lines.push(`    "cache_read" : ${s.tokens.cache_read}`);
  lines.push(`    "cache_write" : ${s.tokens.cache_write}`);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

// --- M13 13.2: five new project report types (PRD §15) --------------------
// Same contract as the M7 renderers above: pure, clock-free (generatedAt is
// caller-injected), Markdown tables authoritative + one illustrative Mermaid
// block each. Stamp REPORT_VERSION_M13, not REPORT_VERSION (see its doc comment).

/** Render the per-model tool/model comparison report (PRD §14 "tool/model comparison"). */
export function renderToolModelComparisonReport(input: ToolModelComparisonInput): string {
  const { projectName, generatedAt, rows } = input;
  const lines: string[] = [];

  lines.push(`# Tool/Model Comparison — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Models observed:** ${rows.length}`);
  lines.push("");

  lines.push("## Per-model breakdown");
  lines.push("");
  lines.push(
    "| model | tool calls | completed | failed | sessions | tokens | cost | first seen | last seen |",
  );
  lines.push(
    "| ----- | ---------- | --------- | ------ | -------- | ------ | ---- | ---------- | --------- |",
  );
  for (const r of rows) {
    lines.push(
      `| ${r.model ?? "(unknown)"} | ${r.toolCalls} | ${r.toolsCompleted} | ${r.toolsFailed} | ${r.sessions} | ${r.tokens.total} | ${fmtUsd(r.costUsd)} | ${r.firstSeen ?? "(none)"} | ${r.lastSeen ?? "(none)"} |`,
    );
  }
  lines.push("");

  lines.push("## Cost by model");
  lines.push("");
  lines.push("```mermaid");
  lines.push("pie showData");
  lines.push("    title Cost by model (USD)");
  for (const r of rows) {
    lines.push(`    "${r.model ?? "(unknown)"}" : ${r.costUsd.toFixed(6)}`);
  }
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/** Render the failed-tool-call classification report (PRD §14 tool-call-failure classes). */
export function renderFailedToolCallsReport(input: FailedToolReportInput): string {
  const { projectName, generatedAt, bucket, breakdown, series } = input;
  const lines: string[] = [];

  lines.push(`# Failed Tool Calls — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Bucket:** ${bucket}`);
  lines.push(
    `- **Classified:** ${breakdown.coverage.classified} / ${breakdown.coverage.total} failures carry a connector-reported failure class`,
  );
  lines.push("");

  lines.push("## By failure class");
  lines.push("");
  lines.push("| class | count |");
  lines.push("| ----- | ----- |");
  const classEntries = Object.entries(breakdown.byClass).sort((a, b) => b[1] - a[1]);
  for (const [cls, count] of classEntries) {
    lines.push(`| ${cls} | ${count} |`);
  }
  lines.push("");

  lines.push("## By tool");
  lines.push("");
  lines.push("| tool | count |");
  lines.push("| ---- | ----- |");
  for (const t of breakdown.byTool) {
    lines.push(`| ${t.tool} | ${t.count} |`);
  }
  lines.push("");

  lines.push(`## Failures over time (by ${bucket})`);
  lines.push("");
  lines.push("| bucket | tool calls | failed | sessions |");
  lines.push("| ------ | ---------- | ------ | -------- |");
  for (const r of series) {
    lines.push(`| ${r.bucket} | ${r.toolCalls} | ${r.toolsFailed} | ${r.sessions} |`);
  }
  if (series.length === 0) lines.push("| _No tool-call activity._ | | | |");
  lines.push("");

  lines.push("## Failure-class composition");
  lines.push("");
  if (classEntries.length > 0) {
    lines.push("```mermaid");
    lines.push("pie showData");
    lines.push("    title Failures by class");
    for (const [cls, count] of classEntries) {
      lines.push(`    "${cls}" : ${count}`);
    }
    lines.push("```");
  } else {
    lines.push("_No failed tool calls._");
  }
  lines.push("");

  return lines.join("\n");
}

/** Render the §17 context-waste report: classified paths + the deterministic ignore-recommendation list. */
export function renderContextWasteReport(input: ContextWasteInput): string {
  const { projectName, generatedAt, byClass, recommendations, coverage } = input;
  const lines: string[] = [];

  lines.push(`# Context Waste — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push("");

  lines.push("## §17 ignore recommendations");
  lines.push("");
  if (recommendations.length > 0) {
    for (const r of recommendations) {
      lines.push(
        `- **${r.class}** (${r.count} occurrence${r.count === 1 ? "" : "s"}): ${r.recommendation}`,
      );
      if (r.examplePaths.length > 0) {
        lines.push(`  - Examples: ${r.examplePaths.map((p) => `\`${p}\``).join(", ")}`);
      }
    }
  } else {
    lines.push("_No context waste detected — nothing to recommend ignoring._");
  }
  lines.push("");

  lines.push("## Classified paths by class");
  lines.push("");
  lines.push("| class | count |");
  lines.push("| ----- | ----- |");
  for (const cls of CONTEXT_WASTE_CLASSES) {
    lines.push(`| ${cls} | ${byClass[cls]} |`);
  }
  lines.push("");

  lines.push("## Connector coverage");
  lines.push("");
  lines.push(
    "_Not every connector emits every context-relevant event type — an honest signal count, not a completeness guarantee._",
  );
  lines.push("");
  lines.push("| connector | event type | count |");
  lines.push("| --------- | ---------- | ----- |");
  for (const c of coverage) {
    lines.push(`| ${c.sourceConnector} | ${c.eventType} | ${c.count} |`);
  }
  if (coverage.length === 0) lines.push("| _No context-relevant events._ | | |");
  lines.push("");

  lines.push("## Waste composition");
  lines.push("");
  const nonZero = CONTEXT_WASTE_CLASSES.filter((c) => byClass[c] > 0);
  if (nonZero.length > 0) {
    lines.push("```mermaid");
    lines.push("pie showData");
    lines.push("    title Context waste by class");
    for (const cls of nonZero) {
      lines.push(`    "${cls}" : ${byClass[cls]}`);
    }
    lines.push("```");
  } else {
    lines.push("_No context waste detected._");
  }
  lines.push("");

  return lines.join("\n");
}

/** Render the project efficiency report (PRD §14 outcome proxies / rework signals). */
export function renderProjectEfficiencyReport(input: EfficiencyInput): string {
  const { projectName, generatedAt, totals, sessions, commits } = input;
  const lines: string[] = [];

  const sessionCount = sessions.length;
  const toolsCompleted = sessions.reduce((sum, s) => sum + s.toolsCompleted, 0);
  const toolsFailed = sessions.reduce((sum, s) => sum + s.toolsFailed, 0);
  const toolOutcomes = toolsCompleted + toolsFailed;
  const successRate = toolOutcomes > 0 ? toolsCompleted / toolOutcomes : null;
  const commitCount = commits.length;
  const avgTokensPerSession = sessionCount > 0 ? totals.tokens.total / sessionCount : 0;
  const avgCostPerSession = sessionCount > 0 ? totals.costUsd / sessionCount : 0;
  const tokensPerCommit = commitCount > 0 ? totals.tokens.total / commitCount : null;
  const costPerCommit = commitCount > 0 ? totals.costUsd / commitCount : null;

  lines.push(`# Project Efficiency — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Sessions:** ${sessionCount}`);
  lines.push(
    `- **Git commits (outcome proxy):** ${commitCount} — mapped commits, not a claim of causality`,
  );
  lines.push("");

  lines.push("## Ratios");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Avg tokens / session | ${avgTokensPerSession.toFixed(1)} |`);
  lines.push(`| Avg cost / session | ${fmtUsd(avgCostPerSession)} |`);
  lines.push(
    `| Tool success rate | ${successRate === null ? "(no tool calls)" : `${(successRate * 100).toFixed(1)}%`} |`,
  );
  lines.push(
    `| Tokens / commit | ${tokensPerCommit === null ? "(no commits)" : tokensPerCommit.toFixed(1)} |`,
  );
  lines.push(
    `| Cost / commit | ${costPerCommit === null ? "(no commits)" : fmtUsd(costPerCommit)} |`,
  );
  lines.push("");

  lines.push("## Tool outcomes");
  lines.push("");
  lines.push("```mermaid");
  lines.push("pie showData");
  lines.push("    title Tool outcomes (all sessions)");
  lines.push(`    "completed" : ${toolsCompleted}`);
  lines.push(`    "failed" : ${toolsFailed}`);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/** Render the trend-anomalies report: rolling z-score flags over the cost + failure-rate series. */
export function renderTrendAnomaliesReport(input: TrendAnomaliesInput): string {
  const {
    projectName,
    generatedAt,
    bucket,
    costSeries,
    costAnomalies,
    failureSeries,
    failureAnomalies,
  } = input;
  const lines: string[] = [];

  lines.push(`# Trend Anomalies — ${projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Bucket:** ${bucket}`);
  lines.push(`- **Cost anomalies flagged:** ${costAnomalies.length}`);
  lines.push(`- **Failure-rate anomalies flagged:** ${failureAnomalies.length}`);
  lines.push("");

  lines.push("## Cost anomalies");
  lines.push("");
  if (costAnomalies.length > 0) {
    lines.push("| bucket | cost | z-score | direction |");
    lines.push("| ------ | ---- | ------- | --------- |");
    for (const a of costAnomalies) {
      lines.push(`| ${a.bucket} | ${fmtUsd(a.value)} | ${a.zScore.toFixed(2)} | ${a.direction} |`);
    }
  } else {
    lines.push("_No cost anomalies detected._");
  }
  lines.push("");

  lines.push("## Failure-rate anomalies");
  lines.push("");
  if (failureAnomalies.length > 0) {
    lines.push("| bucket | failure rate | z-score | direction |");
    lines.push("| ------ | ------------ | ------- | --------- |");
    for (const a of failureAnomalies) {
      lines.push(
        `| ${a.bucket} | ${(a.value * 100).toFixed(1)}% | ${a.zScore.toFixed(2)} | ${a.direction} |`,
      );
    }
  } else {
    lines.push("_No failure-rate anomalies detected._");
  }
  lines.push("");

  lines.push(`## Cost over time (by ${bucket})`);
  lines.push("");
  if (costSeries.length > 0) {
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push('    title "Cost per bucket (USD)"');
    const labels = costSeries.map((r) => `"${r.bucket}"`).join(", ");
    const values = costSeries.map((r) => r.costUsd.toFixed(6)).join(", ");
    const maxCost = Math.max(...costSeries.map((r) => r.costUsd), 0);
    const upper = maxCost > 0 ? maxCost.toFixed(6) : "1";
    lines.push(`    x-axis [${labels}]`);
    lines.push(`    y-axis "Cost (USD)" 0 --> ${upper}`);
    lines.push(`    bar [${values}]`);
    lines.push("```");
  } else {
    lines.push("_No time-series data._");
  }
  lines.push("");

  lines.push(`## Tool-call failures over time (by ${bucket})`);
  lines.push("");
  lines.push("| bucket | tool calls | failed |");
  lines.push("| ------ | ---------- | ------ |");
  for (const r of failureSeries) {
    lines.push(`| ${r.bucket} | ${r.toolCalls} | ${r.toolsFailed} |`);
  }
  if (failureSeries.length === 0) lines.push("| _No tool-call activity._ | | |");
  lines.push("");

  return lines.join("\n");
}
