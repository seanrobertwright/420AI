# PRD: AI Coding Session Intelligence Platform

## 1. Summary

Build a self-hosted application that captures, archives, analyzes, and reports on AI Coding Tool usage across projects and machines. The system preserves full session history, tracks real and estimated token/cost usage, correlates AI activity with Git outcomes, identifies inefficient context behavior, and generates Markdown reports with recommendations for improving AI implementation efficiency.

V1 focuses on AI Coding Tools. General AI Chat capture for ChatGPT, Claude, Gemini web/desktop sessions is deferred to V2.

## 2. Problem

AI coding tools produce valuable but fragmented operational data. Sessions live in vendor-specific local stores, CLIs, IDE databases, telemetry streams, or logs. Tools can crash, be uninstalled, change storage formats, or lose history. Current usage and cost reporting is incomplete, and it is difficult to answer:

- Which projects are consuming the most AI spend?
- Which tools and models are efficient for different types of work?
- How much context is wasted on irrelevant files, lock files, generated output, logs, or duplicated material?
- How often do tool calls fail, and why?
- Which AI sessions produced useful code outcomes?
- Are project-level AI workflows becoming more or less efficient over time?

## 3. Goals

- Preserve maximum-fidelity AI Coding Tool session history across machines.
- Attribute usage, cost, context behavior, tool calls, failures, and outcomes to projects.
- Support historical trend analysis over time.
- Generate user-selectable Markdown reports with Mermaid diagrams.
- Provide deterministic metrics first, then AI-generated interpretation and recommendations.
- Support a broad connector catalog with stable, experimental, and custom config-only connectors.
- Run as a local-first, self-hosted system using a home-server Supabase/PostgreSQL archive.

## 4. Non-Goals For V1

- ChatGPT, Claude, or Gemini web/app session capture.
- Cloud-hosted SaaS version.
- Mobile application.
- macOS or Linux collectors.
- Browser extension capture.
- Enforcing context rules inside AI tools.
- Full local model lifecycle management.
- Script/plugin-based custom connector runtime.
- Proactive cost/context efficiency alerts.

## 5. Target Users

Primary user: an AI-heavy developer who uses multiple coding assistants across projects and wants durable usage history, project-level costs, and efficiency recommendations.

V1 should be single-user in the product experience but multi-user capable in the schema.

## 6. Core Product Concepts

- **Project**: a software effort whose AI usage and outcomes are tracked independently. A project may include multiple repositories, folders, or workspaces.
- **Machine**: a computer running a collector.
- **Workspace**: the local development context where sessions occur, including repository path, Git remote, branch, IDE workspace, shell, and OS user.
- **Tool-Native Session**: a session as recorded by the originating AI Coding Tool.
- **Work Session**: a user-meaningful grouping of one or more tool-native sessions.
- **Connector**: a tool-specific integration that captures, imports, normalizes, or estimates data.
- **Event Log**: the canonical archive of normalized events.
- **Raw Source Record**: original captured data before parsing.
- **Report Artifact**: durable generated Markdown report with metadata.

## 7. V1 MVP Scope

The MVP is successful when one Windows machine can:

- Pair with a self-hosted Supabase/PostgreSQL archive.
- Capture Claude Code, Codex CLI, Gemini CLI, and Antigravity sessions.
- Support Cursor if local data access is reasonably discoverable.
- Support a generic file/log watcher custom connector.
- Store raw source records and normalized events.
- Map sessions to projects and workspaces.
- Compute cost, token, context, failure, and Git outcome metrics.
- Generate Markdown reports with Mermaid diagrams.
- Export report and archive data in Markdown, JSON/JSONL, CSV, and Parquet.

## 8. Architecture

V1 uses a hybrid local-plus-server architecture.

### 8.1 Collector

A Windows-first collector runs on each machine and captures AI Coding Tool data. It includes:

- Background collector process or service.
- Tauri desktop/tray control surface.
- Local durable queue for offline capture.
- Connector runtime for built-in and config-only custom connectors.
- Per-connector permission scopes.
- Sync status, connector health, and operational alerts.

The architecture should remain portable for future macOS and Linux collectors.

### 8.2 Central Archive

The Central Archive is a self-hosted local Docker Supabase deployment, while preserving compatibility with plain PostgreSQL where practical.

It stores:

- raw source records
- normalized events
- users, machines, workspaces, projects
- connectors and catalog versions
- sessions and work sessions
- metrics and costs
- Git outcomes
- report artifacts
- redaction findings

### 8.3 Ingest API

Collectors send data to a dedicated ingest API rather than writing directly to the database.

The ingest API handles:

- per-machine token authentication
- payload validation
- batching
- deduplication
- idempotency
- version compatibility
- write orchestration

### 8.4 Web Dashboard

The dashboard is a self-hosted Next.js application using shadcn/ui and theGridCN.

It provides:

- live monitor
- reports
- project views
- search
- connector catalog management
- machine management
- pairing codes
- settings
- archive export

## 9. Technology Choices

- **Desktop app**: Tauri.
- **Collector target**: Windows first.
- **Web dashboard**: Next.js.
- **UI system**: shadcn/ui with theGridCN as the chosen visual layer.
- **Archive**: local Docker Supabase by default.
- **Database compatibility**: PostgreSQL-compatible schema where practical.
- **Report format**: Markdown with Mermaid support.
- **Export formats**: Markdown, JSON, JSONL, CSV, Parquet.

## 10. Connector Strategy

V1 uses a broad connector catalog with explicit fidelity labels.

### 10.1 MVP Connectors

- Claude Code
- OpenAI Codex CLI
- Gemini CLI
- Antigravity IDE
- Antigravity CLI
- Cursor, research-gated
- Generic file/log watcher custom connector

Antigravity support is MVP-targeted but research-gated until its capture surfaces are verified.

### 10.2 Catalog Connectors

The catalog should also include broader AI Coding Tool coverage, even when connectors are experimental or planned:

- opencode
- Aider
- VS Code GitHub Copilot
- GitHub Copilot CLI
- Windsurf
- Continue
- Cline
- Roo Code
- Kilo Code
- direct API usage from OpenAI, Anthropic, Google/Gemini, OpenRouter, LiteLLM

### 10.3 Connector Fidelity Fields

Each connector must display:

- capture method
- expected data captured
- known gaps
- token/cost confidence
- real-time support level
- tested tool versions
- required permissions
- stable, experimental, or planned status

### 10.4 Catalog Updates

The connector catalog must update independently from app releases.

Requirements:

- bundled baseline catalog for offline use
- signed remote catalog updates
- local overrides
- config-only custom connectors
- user approval for capture surface changes

## 11. Data Capture Requirements

### 11.1 Full Session Capture

The system preserves complete AI Coding Tool session data where available:

- prompts
- outputs
- tool calls
- file references
- command output
- diffs
- errors
- token usage
- cost signals
- model/provider metadata
- timestamps
- connector metadata

### 11.2 Scoped Source Capture

The collector may inspect mapped repositories for metadata, but should not broadly ingest source file contents by default.

Default repository metadata may include:

- Git remote
- current branch
- commit history metadata
- file paths
- file sizes
- languages
- ignore files
- changed file stats

Source content is captured when it appears in AI tool sessions or when the user explicitly opts into source analysis or Git diff capture for a project.

### 11.3 Git Outcome Tracking

V1 tracks Git outcome metadata by default:

- commit hash
- author/time
- branch
- changed file paths
- line counts
- file types
- test files touched
- revert/cherry-pick signals
- pull request links where available

Full Git diff capture is opt-in per project.

### 11.4 Outcome Attribution

The app links AI sessions to Git outcomes using hybrid scoring:

- time proximity
- file overlap
- repository/workspace match
- branch/worktree match
- tool activity
- user correction

Reports must show attribution confidence: high, medium, low, or manual.

## 12. Event Model

The canonical archive is event-based. Sessions, reports, summaries, and metrics are projections over the event log.

V1 event taxonomy includes:

- `session.started`
- `session.ended`
- `message.user`
- `message.assistant`
- `tool.call.started`
- `tool.call.completed`
- `tool.call.failed`
- `file.referenced`
- `file.read`
- `file.modified`
- `context.loaded`
- `usage.reported`
- `usage.estimated`
- `cost.reported`
- `cost.estimated`
- `git.commit.detected`
- `git.diff.detected`
- `report.generated`
- `connector.health`

Each raw record and normalized event should include:

- source connector
- parser version
- catalog version
- event fingerprint
- machine
- workspace
- project attribution, if known
- timestamps
- confidence metadata

## 13. Cost And Usage Model

Costs and token counts may be exact, tool-reported, provider-reported, estimated, or subscription-amortized.

V1 must support:

- reported input tokens
- reported output tokens
- estimated input tokens
- estimated output tokens
- reported cost
- estimated cost
- pricing source
- subscription amortization
- cost confidence

Cost confidence values should include:

- exact
- provider-reported
- tool-reported
- estimated model known
- estimated model unknown
- subscription amortized
- unknown

## 14. Metrics

V1 should compute deterministic metrics before any AI interpretation.

Metric categories:

- project cost over time
- token efficiency
- context hygiene
- tool call failures
- outcome proxies
- rework signals
- latency/productivity
- tool/model comparison
- prompt/context quality
- connector health
- attribution confidence

Tool call failures should be classified when possible:

- model error
- environment error
- permission/policy block
- state mismatch
- tool/runtime failure
- user interruption/cancel
- expected negative result

## 15. Reporting

Reports are user-selectable and Markdown-first.

V1 report types:

- project cost over time
- tool/model comparison
- context waste report
- failed tool call report
- session autopsy
- project efficiency report
- trend anomalies

Reports must support:

- Markdown rendering
- Mermaid diagrams
- tables
- code blocks
- links
- metadata
- versioned report artifacts
- comparison against prior report artifacts

Default behavior is manual-first reporting. Scheduled reports are available as an opt-in setting.

## 16. AI Analysis

The system uses a two-stage analysis pipeline.

### 16.1 Deterministic Metrics Pipeline

The app computes factual metrics from the event log before invoking an AI model.

### 16.2 AI Interpretation Pipeline

A configurable analysis provider receives a compact, redacted report bundle and produces:

- Markdown findings
- recommendations
- Mermaid diagrams
- context governance suggestions
- efficiency observations

V1 supports hosted model APIs and OpenAI-compatible analysis providers. Native local model lifecycle management is deferred.

## 17. Context Governance

V1 recommends better context behavior but does not enforce it inside tools.

The app should generate project-specific ignore recommendations for:

- lock files
- generated files
- build outputs
- dependency folders
- logs
- large irrelevant artifacts
- repeated duplicated context
- binary/base64 blobs

Future versions may enforce context rules through active wrappers or tool integrations.

## 18. Security And Privacy

V1 prioritizes maximum archival fidelity inside the trusted self-hosted archive.

Requirements:

- raw unredacted session data may be stored in the Central Archive
- redaction applies before AI analysis or external export
- redaction findings are stored as metadata
- per-machine ingest tokens are revocable
- collectors pair through short-lived dashboard-generated pairing codes
- connector permissions are explicit
- capture surface changes require user approval
- signed catalog updates are required

Encryption-at-rest should be supported where practical through database/storage configuration and future app-level sensitive-field encryption design.

## 19. Onboarding Flow

Recommended v1 onboarding:

1. Start local Docker Supabase and dashboard through guided setup.
2. Create admin user.
3. Open dashboard and generate machine pairing code.
4. Install/start Windows Tauri collector app.
5. Enter dashboard URL and pairing code.
6. Register machine and issue ingest token.
7. Discover likely repositories and workspaces.
8. Map repositories/workspaces to projects.
9. Select connectors from catalog.
10. Review connector permissions and fidelity labels.
11. Test connectors.
12. Start background collector.
13. Open Live Monitor and run first manual report.

## 20. Alerts

V1 includes operational alerts:

- collector offline
- Central Archive unreachable
- connector failing
- sync backlog growing
- catalog update requires approval
- ingest authentication failure

Efficiency alerts are deferred.

## 21. Search

V1 includes basic full-text search across:

- sessions
- reports
- normalized events
- tool calls
- projects

Advanced semantic search and vector search are deferred until after the core capture and reporting loop works.

## 22. Export And Backup

V1 includes Archive Export and Portable Data Bundles.

Supported export formats:

- Markdown
- JSON
- JSONL
- CSV
- Parquet

Exports may be scoped by:

- project
- time range
- session
- work session
- report
- connector

Full restore UI is deferred, but exports should be suitable for backup, migration, inspection, and external analysis.

## 23. Replay And Versioning

V1 must retain enough raw data and version metadata to reprocess historical records.

Requirements:

- store raw source records
- store normalized events
- track parser version
- track catalog version
- track report/analysis version
- support deduplication through event fingerprints
- allow future replay with improved parsers, pricing metadata, and analysis logic

## 24. Open Questions

- What is the first concrete schema migration for raw records, normalized events, and stable entities?
- Which exact local paths and telemetry surfaces are available for each MVP connector?
- What secret-scanning engine should power the Redaction Pipeline?
- Should sensitive fields receive app-level encryption in addition to database/storage encryption?
- What is the minimum viable theGridCN layout for Live Monitor and Reports?
- How should report comparison be visualized in the dashboard?
- What is the first implementation milestone after PRD approval?

## 25. Suggested Implementation Milestones

1. Repository scaffold: monorepo, shared types, database migrations, dashboard shell, Tauri shell.
2. Archive deployment: Docker Supabase, migrations, ingest API, pairing flow.
3. Collector foundation: durable queue, machine identity, ingest sync, connector framework.
4. First connector: choose the easiest high-fidelity CLI connector and complete end-to-end ingestion.
5. Project/workspace mapping: repo discovery, project creation, mapping UI.
6. Event projections: sessions, usage, cost, connector health, Git metadata.
7. Reporting foundation: deterministic metrics and Markdown report artifacts.
8. AI interpretation: redacted report bundles and configurable analysis provider.
9. Live Monitor: collector health, active sessions, backlog, connector failures.
10. MVP hardening: exports, catalog signing, operational alerts, replay metadata.
