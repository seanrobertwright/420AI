import { describe, it, expect } from "vitest";
import { buildAnalysisPrompt, AI_REPORT_VERSION, type SessionBundle, type ProjectBundle } from "./analysis.js";
import { zeroTokens } from "./tokens.js";

function sessionBundle(): SessionBundle {
  const tokens = zeroTokens();
  tokens.input = 100;
  tokens.output = 50;
  tokens.total = 150;
  return {
    kind: "session",
    sessionId: "s1",
    generatedAt: "2026-06-14T00:00:00.000Z",
    metrics: {
      sessionId: "s1",
      sourceConnector: "claude-code",
      projectPath: "/work/app",
      gitBranch: "main",
      models: ["claude-opus-4-8"],
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: "2026-06-14T00:10:00.000Z",
      eventCount: 7,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 1,
      toolsCompleted: 1,
      toolsFailed: 0,
      filesRead: 4,
      filesModified: 1,
      tokens,
      costUsd: 0.123456,
      costConfidence: "estimated-model-known",
    },
    transcript: [
      { role: "user", text: "help with auth, key is [REDACTED:anthropic_key]" },
      { role: "assistant", text: "sure, here is a plan" },
    ],
    redactionFindings: [
      { kind: "anthropic_key", ruleId: "anthropic_key", count: 1, placeholder: "[REDACTED:anthropic_key]" },
    ],
    transcriptTruncated: false,
  };
}

function projectBundle(): ProjectBundle {
  const tokens = zeroTokens();
  tokens.total = 200;
  return {
    kind: "project",
    projectId: "00000000-0000-4000-8000-000000000000",
    projectName: "420AI",
    generatedAt: "2026-06-14T00:00:00.000Z",
    metrics: {
      totals: { tokens, costUsd: 0.5, costConfidence: "estimated-model-known", eventCount: 4 },
      byModel: [{ model: "claude-opus-4-8", tokens, costUsd: 0.5 }],
      overTime: [{ bucket: "2026-06-14T00:00:00.000Z", tokens, costUsd: 0.5 }],
      sessions: [
        {
          sessionId: "ms1",
          sourceConnector: "claude-code",
          projectPath: "/work/app",
          gitBranch: "main",
          models: ["claude-opus-4-8"],
          startedAt: null,
          endedAt: null,
          eventCount: 4,
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 1,
          toolsCompleted: 0,
          toolsFailed: 1,
          filesRead: 0,
          filesModified: 0,
          tokens,
          costUsd: 0.5,
          costConfidence: "estimated-model-known",
        },
      ],
    },
  };
}

describe("buildAnalysisPrompt — system prompt", () => {
  it("instructs Markdown + Mermaid and not to speculate about redactions", () => {
    const { system } = buildAnalysisPrompt(sessionBundle());
    expect(system).toContain("Markdown");
    expect(system).toContain("Mermaid");
    expect(system).toContain("[REDACTED:*]");
  });
});

describe("buildAnalysisPrompt — session bundle", () => {
  it("embeds the metric numbers, role-tagged transcript, and redaction summary", () => {
    const { user } = buildAnalysisPrompt(sessionBundle());
    expect(user).toContain("# Session interpretation request — s1");
    expect(user).toContain("events: 7 (user 2, assistant 3, tool calls 1)");
    expect(user).toContain("total=150");
    expect(user).toContain("$0.123456");
    expect(user).toContain("[user] help with auth");
    expect(user).toContain("[assistant] sure, here is a plan");
    expect(user).toContain("anthropic_key: 1");
  });

  it("keeps the redaction placeholder but leaks no raw secret", () => {
    const { user } = buildAnalysisPrompt(sessionBundle());
    expect(user).toContain("[REDACTED:anthropic_key]");
    expect(user).not.toContain("sk-ant-");
  });

  it("is deterministic (same input → same output)", () => {
    expect(buildAnalysisPrompt(sessionBundle())).toEqual(buildAnalysisPrompt(sessionBundle()));
  });
});

describe("buildAnalysisPrompt — project bundle", () => {
  it("embeds totals/by-model/over-time/sessions and NO transcript", () => {
    const { user } = buildAnalysisPrompt(projectBundle());
    expect(user).toContain("# Project interpretation request — 420AI");
    expect(user).toContain("events: 4");
    expect(user).toContain("claude-opus-4-8");
    expect(user).toContain("ms1: 4 events");
    expect(user).not.toContain("Transcript");
  });
});

describe("analysis constants", () => {
  it("exports a stable AI_REPORT_VERSION", () => {
    expect(AI_REPORT_VERSION).toBe("m8-ai-v1");
  });
});
