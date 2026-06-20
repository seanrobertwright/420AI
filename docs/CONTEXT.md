# Context Glossary

## AI Coding Tool

An AI assistant used primarily for software development work, including coding agents, IDE assistants, terminal assistants, code review assistants, and repository-aware chat tools.

## General AI Chat

An AI assistant session used outside a coding-tool workflow, such as ChatGPT, Claude, or Gemini web and desktop app conversations.

## V1 Scope

The first release focuses on AI Coding Tools.

## V2 Scope

The second release expands tracking to General AI Chat sessions.

## Tool-Native Session

An AI Coding Tool session as recorded or reported by the originating tool.

## Work Session

A user-meaningful grouping of one or more Tool-Native Sessions, usually tied to a task, issue, feature, or investigation.

## Project

A software effort whose AI usage, cost, context efficiency, and outcomes should be tracked independently from other efforts. A Project can contain multiple repositories, folders, or related workspaces.

## Project Cost

The aggregate AI usage cost attributed to a Project across all AI Coding Tools and Work Sessions.

## AI Implementation Efficiency

The degree to which AI usage on a Project produces useful software outcomes with appropriate context size, token spend, tool activity, and rework.

## Efficiency Report

A time-bounded analysis of a Project's AI usage, costs, context behavior, outcomes, strengths, and deficiencies.

## User-Selectable Report

A report type that can be enabled, disabled, generated on demand, or scheduled by the User according to their needs.

## Token Efficiency

How effectively token spend contributes to useful work, measured through context size, repeated context, output ratio, context window pressure, and related usage signals.

## Context Hygiene

The quality of context selected for AI work, including whether irrelevant, generated, duplicate, binary, lock, vendor, or build artifact files are included.

## Outcome Proxy

A measurable signal that useful software work occurred, such as commits, pull requests, passing tests, files changed, or review comments resolved.

## Rework Signal

A measurable sign that AI work required correction or repetition, such as failed test loops, reverted changes, repeated edits, or abandoned sessions.

## Tool Call Failure

An attempted AI tool action that does not complete successfully, whether caused by model misuse, invalid arguments, missing permissions, unavailable resources, environment errors, or cancellation.

## Full Session Capture

The preservation of complete AI Coding Tool session data, including prompts, outputs, tool calls, file references, command output, diffs, errors, token usage, cost signals, and surrounding metadata.

## Historical Trend Analysis

Long-term analysis over retained Full Session Capture data and normalized metrics, used to identify changes in cost, efficiency, context quality, tool reliability, and project outcomes over time.

## Central Archive

A self-hosted database that receives AI Coding Tool session data from one or more machines and preserves it for reporting and Historical Trend Analysis.

## Collector

A machine-local component that captures AI Coding Tool data and pushes normalized events, metrics, and Full Session Capture records to the Central Archive.

## User

The person whose AI Coding Tool sessions are being captured and analyzed.

## Machine

A computer running a Collector.

## Workspace

The local development context where an AI Coding Tool session occurs, including signals such as repository path, Git remote, branch, IDE workspace, shell, and operating system user.

## Connector

A tool-specific integration that captures, imports, normalizes, or estimates AI Coding Tool session data.

## Connector Catalog

The install-time list of AI Coding Tools and related integrations a User can choose to enable.

## Catalog Update

An independently delivered update to Connector Catalog metadata, connector definitions, known file locations, support status, documentation links, model pricing references, and capture limitations.

## Signed Catalog

A Connector Catalog whose updates are cryptographically verified before the app applies them.

## Signed Catalog Update

A pricing-catalog update delivered as a detached ed25519-signed bundle (`{version, payload, signature}`). The server verifies the signature against a bundled public key, stores the update as `pending`, and applies it only after explicit admin approval (PRD §10.4/§18/§20). An active update re-prices subsequent ingests going forward (historical rows are re-priced only by the deferred replay engine).

## Capture Surface Change

A catalog or connector change that expands or alters what local data may be captured, such as new watched paths, new file types, new logs, or changed redaction behavior.

## Capture Permission

A user-approved scope that defines which local tool directories, repositories, workspaces, logs, files, or metadata a Connector may read.

## Scoped Source Capture

The principle that source file contents are not broadly read by default. Source content is captured when it appears in AI Coding Tool sessions or when the User explicitly approves source analysis for a mapped Project.

## Git Outcome Tracking

The capture of Git-based outcome signals for a Project, such as commits, branches, changed files, commit statistics, pull request links, reverts, test-file changes, and timing relationships between AI Coding Tool sessions and code changes.

## Git Diff Capture

The optional per-Project capture of full Git patches, before/after snippets, and AI-session-to-diff attribution data for deeper rework and outcome analysis.

## Outcome Attribution

The process of linking AI Coding Tool sessions to Git outcomes, reports, or project changes using time windows, file overlap, branch/worktree signals, repository metadata, tool activity, and User corrections.

## Attribution Confidence

The confidence level attached to Outcome Attribution, such as high, medium, low, or manual, and displayed in reports so inferred relationships are not treated as certain facts.

## Operational Alert

A notification about system health or data integrity, such as Collector offline, Central Archive unreachable, Connector failing, sync backlog growing, or Catalog Update requiring approval.

## Alert Firing

A persisted record that an Operational Alert is (or was) active: it carries when it first fired, when it was last seen, whether it resolved, and whether it was acknowledged. Reconciled on read against the live-derived alerts (PRD §20).

## Heartbeat Sample

One time-stamped collector sync-backlog reading appended to the heartbeat time-series, the source for the "backlog growing" trend (distinct from the single latest sample on the machine row).

## Backlog Growing

An Operational-Alert condition that fires when a collector's pending sync backlog rises across the recent window — a derivative, vs. "backlog high" which is a point-in-time depth.

## Efficiency Alert

A notification about cost, token usage, context waste, failed tool call spikes, or other optimization opportunities. Efficiency Alerts are deferred until after the core capture and reporting loop is working.

## Raw Source Record

The original captured data from an AI Coding Tool, log, file, database, telemetry stream, or API before connector parsing and normalization.

## Parser Version

The version of the Connector parser that transformed a Raw Source Record into Normalized Events.

## Catalog Version

The identity of the pricing/connector-catalog snapshot used to compute an Event's or Report's cost metrics. Stamped on Normalized Events and Report Artifacts (PRD §23) so a replay can re-price records produced under an older catalog.

## Replay Support

The ability to reprocess retained Raw Source Records with newer parsers, catalog metadata, pricing data, or analysis logic to improve historical metrics and reports.

## Archive Export

A durable export of Project, session, event, metric, raw record, or report data for backup, migration, inspection, or external analysis.

## Portable Data Bundle

An Archive Export scoped to a Project, time range, Work Session, or report that can include Markdown, JSON, JSONL, CSV, and Parquet representations.

## Archive Deployment

The self-hosted server setup for the Central Archive and Web Dashboard. The preferred v1 deployment is local Docker Supabase with guided setup, while preserving compatibility with plain PostgreSQL where practical.

## Collector Pairing

The process of registering a Collector with the Central Archive and issuing a per-Machine ingest token that can be individually revoked.

## Ingest Token

A revocable credential assigned to a Machine and used by its Collector to write captured data to the Central Archive.

## Ingest API

A server-side API between Collectors and the Central Archive that authenticates Machines, validates payloads, handles batching, deduplication, version compatibility, and writes accepted data to storage.

## Local Durable Queue

A machine-local disk-backed queue where the Collector stores captured Raw Source Records and Normalized Events before upload, retrying until the Ingest API acknowledges them or retention policy expires.

## Event Fingerprint

A stable identifier derived from source, content, timestamp, and connector metadata that supports deduplication, idempotent ingest, and safe replay.

## Redaction Finding

Metadata describing sensitive content detected by the Redaction Pipeline, such as likely secrets, credentials, keys, tokens, or PII, without exposing the sensitive value in reports.

## Manual-First Reporting

The default reporting behavior where Users generate reports on demand. Scheduled reports are available as an opt-in setting rather than enabled by default.

## Event Taxonomy

The v1 set of Normalized Event types, including session lifecycle, user and assistant messages, tool calls, file references, context loading, usage and cost signals, Git outcomes, report generation, and connector health.

## Connector Fidelity

The documented quality and completeness of a Connector, including capture method, expected data captured, known gaps, cost and token confidence, real-time support level, tested tool versions, required permissions, and stable or experimental status.

## OpenAI-Compatible Analysis Provider

An Analysis Provider option that supports hosted or local model runtimes through an OpenAI-compatible API shape, including services such as Ollama, LM Studio, or vLLM when configured appropriately.

## MVP Success Criteria

The first release is viable when one Windows machine can capture Claude Code, Codex CLI, Gemini CLI, and Antigravity sessions into the Central Archive, map them to Projects, compute cost, context, failure, and Git metrics, and generate Markdown Reports with Mermaid diagrams.

## V1 Non-Goal

A capability intentionally excluded from the first release, including General AI Chat capture, cloud-hosted SaaS, mobile apps, context-rule enforcement inside tools, full local model management, script-based connector plugins, macOS/Linux collectors, proactive Efficiency Alerts, and browser extension capture.

## Archive Schema

The Central Archive data model using PostgreSQL/Supabase as the source of truth, JSONB for raw or flexible event payloads, and relational tables for stable entities such as Users, Machines, Projects, Workspaces, Connectors, Sessions, Reports, Costs, and Outcomes.

## Basic Search

V1 search across sessions, reports, and events using PostgreSQL/Supabase full-text search. Advanced semantic and vector search are deferred until after the core capture and reporting loop works.

## MVP Connector

A Connector included in the first shippable slice of the product and expected to support meaningful end-to-end capture, normalization, project attribution, and reporting.

## Windows-First Implementation

The first Collector and installer target Windows, while the architecture, schema, and Connector contracts remain portable enough to support macOS and Linux later.

## Background Collector

A long-running local component that captures AI Coding Tool events and syncs them to the Central Archive without requiring the dashboard to remain open.

## Control Surface

A user-facing interface, such as a tray app or desktop UI, used to configure Connectors, view sync status, pause capture, and inspect Collector health.

## Desktop App

A Tauri-based local application that provides the Collector's Control Surface on Windows first, with macOS and Linux support later.

## Tauri

The Rust + system-webview desktop framework that hosts the M11 Desktop App. The Rust layer owns windowing, the tray, OS-keychain access, and sidecar/server-stack supervision; the UI runs as a webview.

## Sidecar

The headless Node/TS Collector packaged as a Single-Executable Application and bundled as a Tauri `externalBin`, whose lifecycle the Tauri Rust shell supervises. The proven capture core is reused unchanged and the Rust layer stays off the capture path.

## Control Protocol

The JSON-lines command/event protocol the Desktop App speaks to the Sidecar over its stdio (relayed to the webview via Rust events). It is versioned by `CONTROL_PROTOCOL_VERSION` (currently `m11-control-v2`).

## Keychain (Windows Credential Manager)

The OS-native secret store the Tauri Rust shell uses (via the `keyring` crate) to hold the Ingest Token and server-config secrets. The webview never reads these secrets; they are injected as child-process env, never written to a plaintext `.env`.

## Single-Executable Application (SEA)

Node's `node:sea` mechanism, used to package the Collector's `serve` entry into one `.exe` so the Tauri Sidecar can bundle and run it without a separate Node install.

## Web Dashboard

A self-hosted Next.js application that provides central reporting, search, analysis, Project views, and cross-machine visibility over the Central Archive.

## UI System

The shared interface foundation for the Desktop App and Web Dashboard. The preferred baseline is shadcn/ui, with theGridCN as the chosen shadcn-compatible visual layer for reporting, monitoring, and analysis surfaces.

## Markdown Report

A User-Selectable Report rendered and stored as Markdown, with support for tables, code blocks, links, structured sections, and Mermaid diagrams.

## Mermaid Diagram

A diagram embedded in a Markdown Report using Mermaid syntax, used to visualize workflows, timelines, causal chains, tool-call flows, project relationships, and architecture patterns.

## Live Monitor

A real-time observability view over active Collectors, Connectors, AI Coding Tool sessions, sync health, token usage, costs, failures, and anomalies.

## Report Artifact

A durable Markdown Report generated for a specific scope and time window, stored with metadata such as creation time, model used, data sources, Project, filters, and analysis version.

## Report History

The collection of Report Artifacts retained over time so Users can compare metrics, recommendations, and AI-generated interpretations across periods.

## Deterministic Metrics Pipeline

An analysis step that computes factual metrics from the Event Log before any AI interpretation, including cost, token usage, failure rates, context composition, timelines, and outcome signals.

## AI Interpretation Pipeline

An analysis step where a configurable AI provider reviews deterministic metrics and redacted supporting context to generate Markdown Reports, recommendations, and Mermaid Diagrams.

## Analysis Version

The identity of the AI Interpretation Pipeline that produced a Report Artifact, stamped alongside the deterministic renderer version (PRD §23). Deterministic-only artifacts leave it unset.

## Analysis Provider

The AI model provider selected to run the AI Interpretation Pipeline. It may be a hosted model API or a local model runtime.

## Context Governance

The practice of improving AI Coding Tool behavior by identifying, recommending, and eventually enforcing better context selection rules for a Project.

## Ignore Recommendation

A project-specific suggestion for files, folders, or patterns that AI Coding Tools should avoid loading into context, such as lock files, generated files, build outputs, dependency folders, logs, and large irrelevant artifacts.

## Workspace Discovery

An onboarding step where the Collector identifies likely repositories and development workspaces from local paths, Git metadata, IDE workspaces, shell history, and configured tool locations.

## Project Mapping

The process of assigning discovered or manually selected repositories, folders, and workspaces to Projects for attribution, reporting, and cost analysis.

## Experimental Connector

A Connector with incomplete, approximate, unstable, or tool-version-dependent capture behavior. Experimental Connectors are visible in the Connector Catalog but must clearly communicate their limitations.

## Custom Connector

A user-defined Connector that captures data from configured files, folders, logs, or structured sources and maps that data into the app's normalized event model.

## Normalized Event

A timestamped record emitted by a Connector that describes one observed AI Coding Tool action, message, metric, tool call, file interaction, cost signal, or workflow outcome.

## Event Log

The canonical archive of Normalized Events used to reconstruct sessions, generate reports, calculate metrics, and perform Historical Trend Analysis.

## Cost Confidence

The degree of trust attached to a usage or cost value, based on whether it was provider-reported, tool-reported, estimated from known model pricing, estimated from unknown pricing, subscription-amortized, or unknown.

## Subscription Amortization

An optional accounting method that spreads a fixed subscription cost across Projects, Work Sessions, Tools, or time periods based on usage share.

## Redaction Pipeline

A processing step that detects and masks secrets, credentials, private keys, tokens, and sensitive data before content is analyzed by an AI model or exported outside the trusted archive.

## Maximum Archival Fidelity

The principle that raw Full Session Capture data should be preserved in the trusted Central Archive whenever possible, with redaction applied before external analysis or export rather than before durable storage.
