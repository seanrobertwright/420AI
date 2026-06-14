import {
  addTokens,
  lowestConfidence,
  zeroTokens,
  type CostConfidence,
  type NormalizedEvent,
} from "@420ai/shared";

function fmtUsd(usd: number): string {
  // 6 decimals: sessions are cheap; 2 decimals reads as "$0.00".
  return `$${usd.toFixed(6)}`;
}

/**
 * Render a Markdown session report (pure function — returns a string, never
 * writes a file; the CLI decides where output goes).
 */
export function renderSessionReport(events: NormalizedEvent[]): string {
  const sessionId = events[0]?.sessionId ?? "unknown";

  // Aggregate tokens across all usage.reported events.
  let tokens = zeroTokens();
  for (const e of events) {
    if (e.eventType === "usage.reported" && e.tokens) {
      tokens = addTokens(tokens, e.tokens);
    }
  }

  // Aggregate cost across all cost.estimated events.
  let totalUsd = 0;
  const confidences: CostConfidence[] = [];
  for (const e of events) {
    if (e.eventType === "cost.estimated" && e.cost) {
      totalUsd += e.cost.usd;
      confidences.push(e.cost.confidence);
    }
  }
  const confidence = lowestConfidence(confidences);

  const models = [...new Set(events.map((e) => e.model).filter((m): m is string => !!m))];
  const projectPath = events.find((e) => e.projectPath)?.projectPath ?? "(unknown)";
  const gitBranch = events.find((e) => e.gitBranch)?.gitBranch ?? "(unknown)";

  const userMsgs = events.filter((e) => e.eventType === "message.user").length;
  const assistantMsgs = events.filter((e) => e.eventType === "message.assistant").length;
  const toolCalls = events.filter((e) => e.eventType.startsWith("tool.call.")).length;

  // M4 full-fidelity counts (file touches + tool-call outcomes).
  const filesRead = events.filter((e) => e.eventType === "file.read").length;
  const filesModified = events.filter((e) => e.eventType === "file.modified").length;
  const toolsCompleted = events.filter((e) => e.eventType === "tool.call.completed").length;
  const toolsFailed = events.filter((e) => e.eventType === "tool.call.failed").length;

  const tsValues = events.map((e) => e.ts).filter(Boolean).sort();
  const timeRange =
    tsValues.length > 0 ? `${tsValues[0]} → ${tsValues[tsValues.length - 1]}` : "(none)";

  const lines: string[] = [];
  lines.push(`# Session Report — ${sessionId}`);
  lines.push("");
  lines.push(`- **Project path:** ${projectPath}`);
  lines.push(`- **Git branch:** ${gitBranch}`);
  lines.push(`- **Model(s):** ${models.length ? models.join(", ") : "(unknown)"}`);
  lines.push(`- **Events:** ${events.length} (user: ${userMsgs}, assistant: ${assistantMsgs}, tool calls: ${toolCalls})`);
  lines.push(`- **Files touched:** ${filesRead} read, ${filesModified} modified`);
  lines.push(`- **Tool outcomes:** ${toolsCompleted} completed, ${toolsFailed} failed`);
  lines.push(`- **Time range:** ${timeRange}`);
  lines.push("");
  lines.push("## Token usage");
  lines.push("");
  lines.push("| input | output | cache_read | cache_write | total |");
  lines.push("| ----- | ------ | ---------- | ----------- | ----- |");
  lines.push(
    `| ${tokens.input} | ${tokens.output} | ${tokens.cache_read} | ${tokens.cache_write} | ${tokens.total} |`,
  );
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(`- **Total estimated cost:** ${fmtUsd(totalUsd)}`);
  lines.push(`- **Confidence:** \`${confidence}\``);
  lines.push("");
  lines.push("## Token composition");
  lines.push("");
  lines.push("```mermaid");
  lines.push("pie showData");
  lines.push('    title Token composition');
  lines.push(`    "input" : ${tokens.input}`);
  lines.push(`    "output" : ${tokens.output}`);
  lines.push(`    "cache_read" : ${tokens.cache_read}`);
  lines.push(`    "cache_write" : ${tokens.cache_write}`);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
