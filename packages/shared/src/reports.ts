import type {
  UsageTotals,
  UsageByModelRow,
  UsageOverTimeRow,
  SessionDetail,
} from "./projections.js";

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

/** Dotted-lowercase per the EventType naming convention (events.ts). */
export type ReportType = "project.cost_over_time" | "session.autopsy";

/**
 * Renderer identity stamped on every artifact for replay/versioning (PRD §23).
 * Bump when the rendered Markdown changes so a future replay can distinguish
 * artifacts produced by an older renderer.
 */
export const REPORT_VERSION = "m7-report-v1";

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
  const timeRange =
    s.startedAt && s.endedAt ? `${s.startedAt} → ${s.endedAt}` : "(none)";
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
