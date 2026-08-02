# 420AI vs. Langfuse

## Summary

**Langfuse observes an LLM application you build. 420AI observes AI-assisted engineering work you do.**

Langfuse is an LLM observability and evaluation platform. Teams instrument their applications with its SDK or OpenTelemetry, then inspect traces, generations, prompts, tool calls, latency, cost, and evaluation scores.

420AI is intended to be a local-first intelligence and archival platform for developers using AI coding tools. It captures supported tool-native sessions from local stores, maps activity to projects/workspaces and Git evidence, preserves raw records for replay, and produces reports about workflow efficiency, context use, failures, and outcomes.

## Product comparison

| | Langfuse | 420AI |
|---|---|---|
| Primary user | Team building an LLM-powered application | Developer using AI coding tools across real repositories |
| Unit of analysis | Instrumented application request, trace, span, generation, or tool call | Tool-native coding session, workspace, project, Git activity, report, and user-confirmed outcome |
| Collection method | Application SDK and/or OpenTelemetry instrumentation | Local collector reading supported coding-tool session stores, logs, and files |
| Main question | Why did the AI product produce this response, cost, latency, or quality score? | Which AI coding workflow helped or hurt this project, and what should change next? |
| Evidence | Prompt/completion pairs, retrieval/tool spans, tokens, latency, scores | Raw records, normalized events, tokens/cost, failures, context behavior, project mapping, Git evidence, and outcome labels |
| Quality/evaluation focus | Prompt/model experiments, datasets, LLM/code/human evaluators | Retrospective engineering-workflow analysis and outcome attribution |
| Requires prior integration | Usually yes, instrumentation must exist before the request runs | No modification to the observed coding tool; capture is from existing local activity |

## The differentiation that matters

420AI should not position itself as a generic token or cost dashboard. That would overlap materially with Langfuse and other LLM-observability products.

Its differentiated promise is:

> 420AI is a private, cross-tool flight recorder for AI-assisted engineering. It preserves what happened in real coding sessions, connects it to projects and engineering outcomes, and helps the developer decide what to change.

The defensible parts of that promise are:

- Cross-tool, cross-machine capture of coding-assistant activity.
- Local-first, self-hosted archival of sensitive engineering history.
- Project, workspace, repository, and Git context.
- Durable raw-source records that can be replayed when parsers or pricing improve.
- Workflow questions that vendor dashboards do not answer well: context waste, recurring tool failures, tool/model fit by task, and cost-to-outcome.

## Why Langfuse does not replace 420AI

Langfuse can track detailed LLM behavior, but it does not automatically reconstruct historical activity from Claude Code, Codex CLI, Gemini CLI, or other local coding tools. Nor is it designed around local workspace discovery, project attribution, Git outcomes, or durable replay of tool-native records.

It can model a coding session only if the relevant tool/application emits instrumentation into Langfuse. 420AI’s collector approach is valuable precisely because it can observe supported tools after the fact, without requiring those tools to have been integrated with an observability SDK.

## Where they can work together

The products are complementary if 420AI uses an external model for its own AI interpretation/reporting pipeline:

```text
AI coding tools → 420AI collector/archive/reports → 420AI interpretation call
                                                    ↓
                                          Langfuse instrumentation
```

In this arrangement:

- 420AI remains the source of truth for captured developer-workflow evidence.
- Langfuse measures the quality, latency, cost, and behavior of 420AI’s own LLM-powered interpretation feature.
- Langfuse should not replace the 420AI archive or become the only store for raw coding-session data.

## Positioning statement

> Langfuse helps teams improve the AI product they are building. 420AI helps developers improve the way they build software with AI.

## Product risk

If 420AI only presents sessions, token totals, cost charts, and generic AI summaries, it has weak differentiation.

It needs to produce trusted, evidence-backed decisions, such as:

- a model/tool change for a class of tasks;
- a project context rule that reduces waste or failures;
- a diagnosis of an expensive or failed work session;
- a better workflow based on repeated outcomes.

That is the standard for the personal dogfooding and research plan: useful decisions, not merely more telemetry.

## Sources

- [Langfuse Observability & Application Tracing](https://langfuse.com/docs/observability/overview)
- [Langfuse SDK / OpenTelemetry Overview](https://langfuse.com/docs/observability/sdk/overview)
- [Langfuse Evaluation Core Concepts](https://langfuse.com/docs/evaluation/core-concepts)
- [420AI README](../../README.md)
- [420AI PRD](../../docs/PRD.md)
