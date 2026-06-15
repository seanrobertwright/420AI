import type {
  SessionDetail,
  UsageTotals,
  UsageByModelRow,
  UsageOverTimeRow,
  SessionProjection,
} from "./projections.js";
import type { RedactionFinding } from "./redaction.js";
import { fmtUsd } from "./reports.js";

/**
 * The AI Interpretation Pipeline's PURE, provider-agnostic bundle + prompt builder
 * (PRD §16.2, CONTEXT "AI Interpretation Pipeline"). It takes a compact, ALREADY-
 * REDACTED bundle (deterministic M6 metrics + a redacted session transcript) and
 * produces a `{ system, user }` prompt the two provider clients adapt to their wire
 * shapes (D7). `@420ai/shared` stays dependency-free: type-only imports, no I/O, no
 * `new Date()`. The transcript embedded here is redacted UPSTREAM by the
 * orchestrator — this builder never sees raw content (the §18 gate is the
 * orchestrator's, not this module's).
 */

/** The two AI report types (Scope Decision 2 / D1). */
export type AnalysisReportType = "session.ai_interpretation" | "project.ai_interpretation";

/**
 * Analysis-pipeline identity stamped on every AI artifact (PRD §23 analysis
 * version). Bump when the bundle/prompt shape changes so a future replay can
 * distinguish artifacts produced by an older pipeline.
 */
export const AI_REPORT_VERSION = "m8-ai-v1";

/** One redacted transcript line embedded in the session bundle. */
export interface BundleTranscriptEntry {
  role: "user" | "assistant";
  /** REDACTED by the orchestrator before it reaches the bundle (PRD §18). */
  text: string;
}

export interface SessionBundle {
  kind: "session";
  sessionId: string;
  generatedAt: string; // ISO — injected by the caller (clock-free builder)
  metrics: SessionDetail;
  transcript: BundleTranscriptEntry[]; // ALREADY REDACTED
  redactionFindings: RedactionFinding[];
  transcriptTruncated: boolean;
}

export interface ProjectBundle {
  kind: "project";
  projectId: string;
  projectName: string;
  generatedAt: string;
  metrics: {
    totals: UsageTotals;
    byModel: UsageByModelRow[];
    overTime: UsageOverTimeRow[];
    sessions: SessionProjection[];
  };
  // Project bundle has NO transcript — cross-session content is unbounded (D4).
}

export type AnalysisBundle = SessionBundle | ProjectBundle;

const SYSTEM_PROMPT = [
  "You are a senior engineer analyzing one AI coding session (or project) for an",
  "AI-heavy developer. Output GitHub-flavored Markdown with these sections:",
  "Summary, Findings, Recommendations, and at least one Mermaid diagram (in a",
  "```mermaid fenced block). Ground EVERY claim ONLY in the data provided below —",
  "do not invent metrics, file names, or events. The transcript is redacted:",
  "`[REDACTED:*]` tokens are masked secrets/paths/PII — treat them as opaque and do",
  "NOT speculate about their contents. Be concrete, concise, and actionable; call",
  "out efficiency, cost, and context-governance observations where the data supports",
  "them.",
].join(" ");

/** Render a NormalizedTokens-bearing line compactly. */
function tokenLine(t: {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}): string {
  return `input=${t.input} output=${t.output} cache_read=${t.cache_read} cache_write=${t.cache_write} total=${t.total}`;
}

function renderRedactionSummary(findings: RedactionFinding[]): string[] {
  const lines = ["## Redaction summary"];
  if (findings.length === 0) {
    lines.push("- none (no secrets/PII detected in the transcript)");
  } else {
    // Deterministic order: by kind.
    for (const f of [...findings].sort((a, b) => a.kind.localeCompare(b.kind))) {
      lines.push(`- ${f.kind}: ${f.count}`);
    }
  }
  return lines;
}

function renderSessionUser(b: SessionBundle): string {
  const s = b.metrics;
  const lines: string[] = [];
  lines.push(`# Session interpretation request — ${b.sessionId}`);
  lines.push(`Generated: ${b.generatedAt}`);
  lines.push("");
  lines.push("## Deterministic metrics");
  lines.push(`- connector: ${s.sourceConnector || "(unknown)"}`);
  lines.push(`- models: ${s.models.length ? s.models.join(", ") : "(unknown)"}`);
  lines.push(`- project path: ${s.projectPath ?? "(unknown)"}`);
  lines.push(`- git branch: ${s.gitBranch ?? "(unknown)"}`);
  lines.push(
    `- events: ${s.eventCount} (user ${s.userMessages}, assistant ${s.assistantMessages}, tool calls ${s.toolCalls})`,
  );
  lines.push(`- tools: ${s.toolsCompleted} completed, ${s.toolsFailed} failed`);
  lines.push(`- files: ${s.filesRead} read, ${s.filesModified} modified`);
  lines.push(`- tokens: ${tokenLine(s.tokens)}`);
  lines.push(`- cost: ${fmtUsd(s.costUsd)} (${s.costConfidence})`);
  lines.push("");
  lines.push(...renderRedactionSummary(b.redactionFindings));
  lines.push("");
  lines.push(`## Transcript (redacted${b.transcriptTruncated ? ", truncated" : ""})`);
  if (b.transcript.length === 0) {
    lines.push("_(no message transcript available)_");
  } else {
    for (const e of b.transcript) {
      lines.push(`[${e.role}] ${e.text}`);
    }
  }
  return lines.join("\n");
}

function renderProjectUser(b: ProjectBundle): string {
  const { totals, byModel, overTime, sessions } = b.metrics;
  const lines: string[] = [];
  lines.push(`# Project interpretation request — ${b.projectName}`);
  lines.push(`Generated: ${b.generatedAt}`);
  lines.push("");
  lines.push("## Totals");
  lines.push(`- events: ${totals.eventCount}`);
  lines.push(`- tokens: ${tokenLine(totals.tokens)}`);
  lines.push(`- cost: ${fmtUsd(totals.costUsd)} (${totals.costConfidence})`);
  lines.push("");
  lines.push("## Usage by model");
  if (byModel.length === 0) {
    lines.push("- (none)");
  } else {
    for (const m of byModel) {
      lines.push(`- ${m.model ?? "(unknown)"}: ${tokenLine(m.tokens)} cost=${fmtUsd(m.costUsd)}`);
    }
  }
  lines.push("");
  lines.push("## Usage over time");
  if (overTime.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of overTime) {
      lines.push(`- ${r.bucket}: tokens=${r.tokens.total} cost=${fmtUsd(r.costUsd)}`);
    }
  }
  lines.push("");
  lines.push("## Sessions");
  if (sessions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const sn of sessions) {
      lines.push(
        `- ${sn.sessionId}: ${sn.eventCount} events, ${sn.userMessages} user / ${sn.assistantMessages} assistant msgs, ${sn.toolsFailed} tool failures, cost=${fmtUsd(sn.costUsd)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Build the provider-agnostic prompt from an ALREADY-REDACTED bundle. Returns
 * `{ system, user }` strings; each provider client maps them into its wire shape
 * (Anthropic `system` + a user message; OpenAI a system + user message). Pure and
 * deterministic (same input → same output); no `new Date()`.
 */
export function buildAnalysisPrompt(bundle: AnalysisBundle): { system: string; user: string } {
  const user = bundle.kind === "session" ? renderSessionUser(bundle) : renderProjectUser(bundle);
  return { system: SYSTEM_PROMPT, user };
}
