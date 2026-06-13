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
- **Capture Claude Code, OpenAI Codex CLI, and Gemini CLI sessions** (the three required
  connectors — all verified high-fidelity, append/per-session files; see
  `docs/research/connector-capture-spike.md`).
- Support a generic file/log watcher custom connector.
- Store raw source records and normalized events.
- Map sessions to projects and workspaces.
- Compute cost, token, context, failure, and Git **metadata** metrics (Git outcome
  *attribution* is manual-plus-heuristic in V1 — see §11.4).
- Generate Markdown reports with Mermaid diagrams.
- Export report and archive data in Markdown, JSON, JSONL, and CSV. (Parquet is deferred
  past V1.)

**Stretch / research-gated (not required for MVP):** Antigravity (IDE + CLI) and Cursor
connectors are targeted but gated until their capture surfaces are verified. The spike found
Antigravity records rich tool actions but **no token/cost data**, and Cursor's `~/.cursor`
store is a code-provenance tracker rather than a conversation store (real chat history lives
in `%APPDATA%\Cursor`, not yet inspected). These ship when feasible and never block the MVP.

## 8. Architecture

V1 uses a hybrid local-plus-server architecture.

### 8.1 Collector

A Windows-first collector runs on each machine and captures AI Coding Tool data. It includes:

- Background collector process or service.
- Control surface for configuration and health. **V1 ships a headless Node/TypeScript
  collector (single language across collector + dashboard); the Tauri desktop/tray control
  surface is deferred to a later iteration** to keep V1 single-language and remove Rust from
  the critical path.
- Local durable queue for offline capture.
- Connector runtime for built-in and config-only custom connectors.
- Per-connector permission scopes.
- Sync status, connector health, and operational alerts.

Capture is **file-watch based**: connectors tail/observe each tool's on-disk session store and
emit events to the durable queue. Each watched file carries a per-file cursor
`(path, last-byte-offset, size/inode)` so a collector restart resumes instead of re-sending.

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

### 8.5 Data Volume & Retention (initial estimates)

Rough sizing assumptions to validate "JSONB-everything" and inform DB capacity (refine with
real data once the first connector runs):

- Heavy solo usage ≈ 5–20 AI sessions/day across tools; a large session is ~0.5–1 MB of raw
  JSONL (sampled: a 510 KB Claude session, an 846 KB session, multi-MB Codex rollouts).
- Order-of-magnitude: **tens of MB/day raw**, single-digit **GB/year** before compression —
  comfortably within a single Postgres instance.
- **Retention:** keep raw records indefinitely by default (they are the source of truth and
  enable replay); normalized events and report artifacts are re-buildable and may be pruned.
- Revisit columnar export (Parquet) and partitioning only if raw volume materially exceeds
  these estimates.

## 9. Technology Choices

- **Collector (V1)**: headless Node/TypeScript service (single language with the dashboard).
- **Desktop app**: Tauri — **deferred** to a later iteration as the collector's tray/control surface.
- **Collector target**: Windows first.
- **Web dashboard**: Next.js.
- **UI system**: shadcn/ui with theGridCN as the chosen visual layer. **Fallback:** plain
  shadcn/ui if theGridCN proves unmaintained or blocking.
- **Archive**: local Docker Supabase by default.
- **Database compatibility**: PostgreSQL-compatible schema where practical.
- **Report format**: Markdown with Mermaid support.
- **Export formats (V1)**: Markdown, JSON, JSONL, CSV. **Parquet deferred** past V1.

## 10. Connector Strategy

V1 uses a broad connector catalog with explicit fidelity labels.

### 10.1 MVP Connectors

Verified against on-disk stores by the capture spike (`docs/research/connector-capture-spike.md`).
**All three required connectors record exact token usage + model + tool calls; none record
cost (cost is computed — see §13).**

**Required (MVP):**

| Connector | Store location | Format | Liveness | Tokens / Model |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | JSONL, append | Streaming (tail) | exact / yes (+ `cwd`,`gitBranch` per record) |
| OpenAI Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `history.jsonl` | JSONL, append | Streaming (tail) | exact, incl. reasoning+cached / yes |
| Gemini CLI | `~/.gemini/tmp/<projectHash>/chats/session-*.json` | JSON, rewritten | Near-real-time (watch+diff) | exact per-msg / yes |
| Generic file/log watcher | user-configured | any | per config | custom mapping |

> **Build order:** Claude Code first (richest data + free Git context), then Codex, then Gemini.

**Stretch / research-gated (not required for MVP):**

| Connector | Store | Finding | Status |
| --- | --- | --- | --- |
| Antigravity (IDE + CLI) | `~/.gemini/antigravity-*` | rich tool-action trace but **no token/cost**; some protobuf state | Experimental — actions-only possible |
| Cursor | `~/.cursor/ai-tracking/ai-code-tracking.db` (code-provenance only) | real chat history is in `%APPDATA%\Cursor` — not yet inspected | Planned — needs follow-up research |

### 10.1.1 Liveness Levels

Liveness is a per-connector fidelity label, capped by the tool's storage format:

- **Streaming** — append-only file; tail newly written lines (Claude Code, Codex CLI).
- **Near-real-time** — single file rewritten as the session grows; watch + diff (Gemini CLI).
- **Snapshot/poll** — SQLite or similar with no append signal; re-query newer rows on an interval (Cursor).
- **Batch** — captured on session end or manual import (protobuf portions of Antigravity).

The Live Monitor must display "last event N seconds ago" per connector so any lag is visible
rather than implied to be instantaneous.

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
- real-time support level (streaming / near-real-time / snapshot / batch — see §10.1.1)
- tested tool versions
- required permissions
- stable, experimental, or planned status

**Token normalization:** each tool uses its own token schema, so every connector parser must
map to one common token shape with sub-types — `input`, `output`, `cache_read`, `cache_write`,
`reasoning`, `tool`, `total` — defined once in the shared types package. (Sub-types matter
because they are priced differently; see §13.)

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

Git tracking is split into two layers with very different difficulty and confidence:
deterministic **metadata** (this section, built in V1) and inferred **attribution**
(§11.4, deliberately minimal in V1).

V1 tracks Git outcome metadata by default — this is 100% factual, no inference:

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

Linking an AI session to a specific Git outcome is inference, not fact — nothing in the tools
stamps the commit. V1 keeps this deliberately simple and defers the full weighted scorer.

**V1 behavior:**

- **Manual linking** — the user can explicitly attach a session to a commit (confidence: manual).
- **One lightweight heuristic suggestion** — same repository + commit within a configurable
  window after a session ends + at least one overlapping changed file → suggest a link at
  low/medium confidence for the user to confirm. Auto-links are *suggestions*, never asserted facts.

**Deferred to a later iteration** — the full hybrid scorer combining additional signals (branch/
worktree match, tool activity, time-proximity weighting, user-correction learning).

Reports must show attribution confidence: high, medium, low, or manual. The deterministic
fingerprint (§12) is reused to record whether a session/commit pair has already been attributed.

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

**Event fingerprint (deterministic):**

```
fingerprint = hash(source_connector + raw_record_id + event_index_within_record + event_type)
```

The same raw input always yields the same fingerprint regardless of parser version. This single
primitive powers both **dedup/idempotent ingest** and **replay reconciliation** (§23), and is
reused by attribution (§11.4). Defining it precisely early is a high-leverage schema decision.

## 13. Cost And Usage Model

**Spike reality:** none of the required connectors report cost — but all report **exact
tokens**. So the normal path is *cost = exact tokens × catalog pricing*, which is a precise
estimate, not a guess. "Reported cost" is a rarely-used top rung for these CLIs.

### 13.1 Token Sub-Types (required)

Tokens are not a flat input/output pair. Each tool breaks usage into sub-types that are priced
very differently (cached reads are far cheaper; reasoning bills as output). The cost model must
account for all of them per the normalized token shape (§10.3):

- `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `tool`, `total`.

A flat input/output split would materially mis-cost every session.

### 13.2 Pricing Source

- Pricing lives in the **connector catalog** as a table: `model → { per-sub-type $/token,
  source URL, as-of date }`, covering at minimum the observed models: Claude (Opus/Sonnet/Haiku
  with cache tiers), `gpt-5.4` (+ reasoning + cached), `gemini-3-flash` (+ thoughts/cached).
- Pricing updates ship via the catalog (independent of app releases — §10.4).
- **Refresh is manual-trigger in V1** ("Check for pricing updates"); an optional schedule is a
  later enhancement.

### 13.3 Cost Confidence Ladder

Computed cost walks this ladder, recording the confidence level used:

1. tool/provider reported a cost → **provider-reported / tool-reported** / **exact**
2. no reported cost, model known and in pricing table → **estimated model known** (the normal path)
3. model unknown / not in table → **estimated model unknown**
4. fixed subscription spread across usage → **subscription amortized**
5. otherwise → **unknown**

V1 must support: reported and estimated tokens (per sub-type), reported and estimated cost,
pricing source, subscription amortization, and the cost-confidence label above.

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

- raw session data is stored in the Central Archive, with **field-level encryption of sensitive
  payloads from day one** (see below)
- redaction applies before AI analysis or external export
- redaction findings are stored as metadata
- per-machine ingest tokens are revocable
- collectors pair through short-lived dashboard-generated pairing codes
- connector permissions are explicit
- capture surface changes require user approval
- signed catalog updates are required

### 18.1 Field-Level Encryption (V1)

Application-level encryption of sensitive content, decided for V1 to build a solid foundation:

- **Encrypt:** message bodies, tool-call arguments/outputs, captured file contents, command
  output, detected secrets.
- **Plaintext (queryable):** timestamps, model, project/workspace/machine IDs, token counts,
  costs, event type, fingerprint — so reporting and aggregation never require decryption.
- The symmetric key is held by the app/server (OS keystore / `age`-style), **not stored in the
  database**. Decrypt only to render a session or to feed the redaction pipeline.
- Encryption-at-rest at the database/storage layer is additionally enabled where practical.

### 18.2 Redaction Engine (V1)

The Redaction Pipeline uses a **regex + entropy** secret-scanner for V1 (known key/token
patterns plus high-entropy string detection). A heavier pluggable scanner is a later option.

## 19. Onboarding Flow

Recommended v1 onboarding:

1. Start local Docker Supabase and dashboard through guided setup.
2. Create admin user.
3. Open dashboard and generate machine pairing code.
4. Install/start the Windows collector (headless Node/TS service in V1; Tauri tray later).
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

**Encryption ↔ search reconciliation:** because sensitive content is encrypted at rest (§18.1),
full-text search cannot run over the originals. V1 therefore searches a **redacted plaintext
projection** (secrets already masked by the Redaction Pipeline) while the sensitive originals
stay encrypted. The redaction pipeline is what makes this searchable copy safe to store in plaintext.

Advanced semantic search and vector search are deferred until after the core capture and reporting loop works.

## 22. Export And Backup

V1 includes Archive Export and Portable Data Bundles.

Supported export formats:

- Markdown
- JSON
- JSONL
- CSV
- Parquet *(deferred past V1)*

Exports may be scoped by:

- project
- time range
- session
- work session
- report
- connector

Full restore UI is deferred, but exports should be suitable for backup, migration, inspection, and external analysis.

## 23. Replay And Versioning

**Governing principle:** raw source records are sacred and permanent; normalized events are
disposable, derived, and re-buildable at any time. Because the raw record is preserved, data is
never lost — metrics can always be recomputed.

**Reconciliation model (V1): upsert-by-fingerprint.** Re-parsing a raw record with an improved
parser regenerates events with the *same* deterministic fingerprints (§12); those events
**replace** the prior ones (upsert), each stamped with the `parser_version` that produced it.
This is idempotent (re-running ingest cannot create duplicates) and simple. Because
`parser_version` is stored, the design can later graduate to versioned event "generations"
without changing what is captured now.

Requirements:

- store raw source records
- store normalized events
- track parser version
- track catalog version
- track report/analysis version
- support deduplication and idempotent re-parse through event fingerprints (§12)
- allow future replay with improved parsers, pricing metadata, and analysis logic

## 24. Open Questions

**Resolved (during PRD review + capture spike):**

- ✅ *Which local paths/surfaces are available per MVP connector?* — Verified for Claude Code,
  Codex CLI, Gemini CLI; see §10.1 and `docs/research/connector-capture-spike.md`.
- ✅ *Secret-scanning engine for the Redaction Pipeline?* — Regex + entropy scanner for V1 (§18.2).
- ✅ *App-level encryption of sensitive fields?* — Yes, field-level encryption from day one (§18.1).
- ✅ *First implementation milestone after approval?* — Milestone 1 walking skeleton:
  Claude Code connector → ingest → store → one report (§25).

**Still open:**

- What is the first concrete schema migration for raw records, normalized events, and stable entities?
- What is the minimum viable theGridCN layout for Live Monitor and Reports?
- How should report comparison be visualized in the dashboard?
- Cursor follow-up: does `%APPDATA%\Cursor` expose a usable conversation/token store?
- Confirm Codex `session_meta` carries `cwd`/git info, and that Gemini `projectHash` is a
  stable hash of the project path (both for project attribution).

## 25. Suggested Implementation Milestones

1. Repository scaffold: monorepo, shared types (incl. normalized token shape), database
   migrations, dashboard shell, headless collector shell. (No Tauri shell in V1.)
2. Archive deployment: Docker Supabase, migrations, ingest API, pairing flow.
3. Collector foundation: durable queue, machine identity, ingest sync, connector framework,
   per-file capture cursors.
4. First connector: **Claude Code** (richest data + free `cwd`/`gitBranch` context) — complete
   end-to-end ingestion. Then Codex CLI, then Gemini CLI.
5. Project/workspace mapping: repo discovery, project creation, mapping UI.
6. Event projections: sessions, usage, cost, connector health, Git metadata.
7. Reporting foundation: deterministic metrics and Markdown report artifacts.
8. AI interpretation: redacted report bundles and configurable analysis provider.
9. Live Monitor: collector health, active sessions, backlog, connector failures.
10. MVP hardening: exports, catalog signing, operational alerts, replay metadata.
