# Feature: Milestone 8 — AI Interpretation (redacted report bundle → configurable Analysis Provider → stored findings artifact)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Pay special attention to naming of
existing utils, types, and models — import from the right files (`@420ai/shared`, `@420ai/db`, `.js`
relative specifiers, `import type` for type-only imports). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **Branch:** all M8 work lands on `m8` (created off `main`/HEAD `e9d9d73`). **M7 was merged to `main`
> via PR #6 during M8 planning**, so M8 branches off `main` (which already contains the M7
> `report_artifacts` table + M6 projections + the M7 store/routes). M8 renders AI findings into that SAME
> artifact store. (Open the M8 PR against `main`.)

> **Scope decisions confirmed with the user during planning** (these bound the milestone — honor them):
> 1. **Bundle = deterministic metrics + a redacted decrypted transcript.** The bundle's content section
>    is the *real* "redaction over decrypted content": decrypt the message raw records for a session, run
>    the regex+entropy Redaction Pipeline over the verbatim text, cap it, and include it alongside the M6
>    metrics. (NOT metrics-only; NOT a server-side re-parse of connector formats.)
> 2. **Two AI report types — `session.ai_interpretation` and `project.ai_interpretation` — both threaded
>    through the full pipeline** (bundle → redact → provider → store → fetch/list). Mirrors M7's "thread
>    the anchor types end-to-end" discipline.
> 3. **Both providers first-class:** an **Anthropic Messages API** client AND an **OpenAI-compatible
>    Chat Completions** client (Ollama / LM Studio / vLLM / OpenAI), selected by env config, both built
>    and tested in M8. Plain `fetch`, **no SDK dependency** (preserve the M4–M7 "no new dependency" run).
> 4. **Reuse the M7 `report_artifacts` table — NO migration.** The AI findings are stored as a new
>    artifact `reportType` (`*.ai_interpretation`); provider/model/redaction metadata live in the existing
>    `metrics`/`params` jsonb. (The M7 plan explicitly anticipated this: *"storing the AI findings as a
>    new artifact (or a column) — without changing M7's table shape."*)

> **RE-RATIFIED BY USER (2026-06-14, this planning session):** (1) session bundle = **metrics + redacted
> decrypted transcript** ✅; (2) build **both** the Anthropic AND OpenAI-compatible clients ✅; (3) **no live
> provider spike** — stubbed-fetch tests + the `claude-api` cross-check + the Level-4 manual gate ✅;
> (4) **Anthropic (Claude) is the default provider** for `.env.example` defaults and the Level-4 manual
> validation gate (OpenAI-compatible remains first-class and env-selectable). Branch for this work:
> `m8-ai-integrations-redact-reporting` (off `main` @ `e9d9d73`); PR targets `main`.

> **Redaction is a HARD pre-send / pre-store gate (PRD §18).** Decrypted session text exists in plaintext
> in exactly ONE place: in-process, between the `@420ai/db` decrypt read and the `@420ai/shared`
> `redact()` call in the orchestrator. It is **redacted before** it is put in a provider request and
> **before** anything is written to `report_artifacts`. Unredacted decrypted content is **never** sent to
> a provider, **never** logged, and **never** stored. This is the §18 invariant — encode it as a code
> comment at every decrypt→redact seam.

---

## Feature Description

M7 built the **Reporting Foundation**: pure Markdown+Mermaid renderers over the M6 deterministic
projections, stored as durable, versioned `report_artifacts` (no AI, plaintext-only, never decrypts).

M8 is the **AI Interpretation Pipeline** (PRD §16.2, §18, §18.2, CONTEXT terms *AI Interpretation
Pipeline*, *Analysis Provider*, *Redaction Pipeline*, *Redaction Finding*). It adds the two genuinely new
mechanics the product has deferred since M1:

1. **The Redaction Pipeline** (`@420ai/shared/redaction.ts`) — a pure, dependency-free **regex + entropy**
   secret scanner (PRD §18.2) that masks secrets/keys/tokens/credentials/PII and home-directory
   usernames, returning the **masked text** plus **Redaction Findings** (metadata: kind + count +
   placeholder, **never the raw value** — CONTEXT "Redaction Finding"). This is the first redaction code
   in the repo and the substrate for the §21 searchable redacted projection later.

2. **The first decryption-for-rendering path** (`@420ai/db` `sessionTranscript`) — reads a session's
   `message.user`/`message.assistant` events, resolves each to its **raw source record**, **decrypts**
   it (`decryptField`), orders + dedupes + **caps** it. M8 is the first milestone to call `decryptField`
   on a read path (M6/M7 never decrypted).

3. **The Analysis Provider abstraction + two clients** (`apps/ingest/src/analysis/`) — an injected,
   configurable provider (Anthropic Messages API and OpenAI-compatible Chat Completions, plain `fetch`)
   that takes a **compact redacted report bundle** and returns **Markdown findings + recommendations +
   Mermaid** (PRD §16.2).

4. **A generation orchestrator + admin endpoints** that compose `metrics + redacted transcript → bundle →
   provider → store`, persisting the AI findings as a versioned `report_artifacts` row (reusing the M7
   store, repo, and `GET /v1/reports` fetch/list verbatim).

This implements PRD §16.2 (configurable provider, redacted bundle, Markdown/Mermaid findings,
recommendations), §18 ("redaction applies before AI analysis or external export; redaction findings
stored as metadata"), §18.2 (regex+entropy engine), and the CONTEXT *Report Artifact* contract ("stored
with metadata such as model used, data sources, analysis version"). It is the substrate the §21 redacted
search projection and any later scheduled-analysis feature build on.

### Why this milestone is **Medium** (higher than M7), and where the real risk is

M8 reuses proven layers — the M6 projections (tested), the M7 `report_artifacts` table + `insertReport
Artifact` + `GET /v1/reports` (tested), the admin-route pattern, the AES-GCM `decryptField` (tested), and
the int-test harness — and adds **no migration and no new dependency**. The genuinely new surface is
three pure-or-injectable pieces, each independently testable:

- **Redaction engine** — pure string→string+findings. Unit-tested exhaustively; zero infra. Low risk.
- **Decryption read (`sessionTranscript`)** — a new SQL read + `decryptField`. The join key and
  one-raw-record-per-line granularity were **verified in code this session** (see PRE-FLIGHT). The
  encrypt→decrypt round-trip is already proven by `ingest.int.test.ts`. Low-medium risk.
- **Provider client** — the one outbound network call. De-risked by (a) **injecting** the provider into
  `buildApp` so ALL automated tests use a deterministic stub (the live call is never on the test path),
  (b) specifying both wire shapes exactly below + a mandatory cross-check against the built-in
  `claude-api` skill, and (c) a live manual-validation gate. Medium risk, contained.

### Explicitly deferred — do NOT build in M8

- **The §21 redacted plaintext SEARCH projection / full-text search.** M8 builds the redaction *engine*
  and uses it for the AI bundle only. Persisting a redacted searchable copy of every event + Postgres FTS
  is its own later milestone (it reuses this engine).
- **Scheduled / automatic analysis** (PRD §15 "scheduled reports opt-in"). M8 is manual-first: an admin
  `POST` triggers one interpretation. No cron, no settings table.
- **Report comparison / diff** (still deferred from M7). The stored `metrics` snapshot remains the
  future-compare seam; M8 does not diff.
- **The other five §15 deterministic report types** (still deferred from M7).
- **Tool-call failure 7-way classification** (PRD §14) and **context-governance ignore recommendations**
  (PRD §17) — the AI *may* mention these in its prose findings, but M8 ships **no deterministic
  classifier and no governance engine**.
- **A dashboard / web UI**, **archive export** (M10), **streaming** provider responses, **multi-provider
  fan-out**, **token-cost accounting of the analysis call** beyond storing the provider's reported usage.
- **Decrypting anything for the PROJECT bundle.** Project interpretation is metrics-only (see D4) — a
  cross-session transcript would be unbounded. Only the SESSION bundle decrypts a transcript.

## User Story

As an AI-heavy developer whose sessions are captured, attributed, aggregated (M6), and rendered into
durable metric reports (M7),
I want to generate an **AI interpretation** of a session or project — findings, recommendations, and
diagrams — produced by a **configurable** model from the deterministic metrics **plus a redacted excerpt
of the actual session content**, with secrets masked **before** anything leaves my archive,
So that I get actionable, human-readable analysis (not just numbers) without exposing credentials to the
AI provider, and keep each interpretation as a versioned, retained artifact alongside my metric reports.

## Problem Statement

After M7 the archive can render deterministic **metrics** to Markdown, but it cannot *interpret* them:
there is no redaction engine, so no content can safely leave the archive; there is no provider
abstraction, so no model can be called; and the session **content** (prompts, outputs, tool I/O) sits
encrypted and unused — the M7 "session autopsy" is metrics-only precisely because the redaction path did
not exist. PRD §16.2 requires a configurable provider over a *redacted* bundle; PRD §18 requires redaction
*before* any external analysis. None of that exists yet.

## Solution Statement

Add a **pure Redaction Pipeline** to `@420ai/shared` (regex + entropy → masked text + findings) and a
pure **bundle/prompt builder** (deterministic; provider-agnostic). Add a **`sessionTranscript`** read to
`@420ai/db` that decrypts a session's message raw records (the first decrypt-for-render path), ordered +
deduped + capped. Add an injected **Analysis Provider** abstraction with **Anthropic** and
**OpenAI-compatible** `fetch` clients in `apps/ingest`. Add a **generation orchestrator** that builds the
bundle (`metrics + redact(transcript)`), calls the provider, and stores the findings as a **new
`report_artifacts` row** (`reportType: "*.ai_interpretation"`, provider/model/redaction metadata in
`metrics`/`params`) — **reusing the M7 table, repo, and `GET /v1/reports` fetch/list with NO migration**.
Add admin-gated `POST` endpoints (session + project), mirroring `routes/reports.ts`. The provider is
injected via `BuildAppOptions` so all integration tests use a deterministic stub; the real client is
wired from env in `server.ts`.

## Feature Metadata

**Feature Type**: New Capability (the AI-interpretation half of the two-stage analysis pipeline; first
redaction + first decrypt-for-render + first outbound provider call).
**Estimated Complexity**: **Medium.** No migration, no new dependency. Three new mechanics (pure
redaction; a decrypt read; an injected provider client), each isolated and independently testable; all
storage/fetch/route plumbing is reused from M7.
**Primary Systems Affected**: `packages/shared` (new `redaction.ts`; `analysis.ts` bundle/prompt types +
builder; extend `ReportType`; barrel), `packages/db` (new `repositories/transcript.ts` decrypt read;
barrel — **no schema change**), `apps/ingest` (new `analysis/` provider + clients + orchestrator; new
route file; schemas; `BuildAppOptions.analysisProvider`; `server.ts` env wiring; error-handler branch;
int-test additions), `.env.example`, `README.md`. **No collector change, no fingerprint/wire/encryption
change, no migration.**
**Dependencies**: none new. `drizzle-orm`, `pg`, Fastify, `node:crypto` (present); Node ≥ 24 global
`fetch` + `AbortController` for the provider call. The frozen `@420ai/shared` cost/token vocab + M6
projections + M7 `insertReportArtifact`/`getReportArtifact`/`listReportArtifacts` (present).

---

## PRE-FLIGHT VERIFICATION (grounded against the codebase + two spikes this session)

The novel risk in M8 is "decrypt real session content, redact it, send a compact bundle to a configurable
model, store the findings." Every structural half is **[VERIFIED]**; the two genuinely new mechanics were
grounded by spikes.

1. **The decrypt primitive + encrypt→decrypt round-trip are proven — [VERIFIED].** `packages/db/src/
   crypto.ts` exports `decryptField(EncryptedField): string` (AES-256-GCM; key from `ARCHIVE_ENCRYPTION_
   KEY`, base64, 32 bytes; tag-authenticated). `packages/db/src/repositories/ingest.int.test.ts:3,11-12`
   ingests a known `SECRET` and asserts the encrypt→`decryptField` round-trip — M8's `sessionTranscript`
   reuses exactly this. `decryptField` is already re-exported from the barrel (`index.ts:17`).

2. **The transcript join + granularity are CONFIRMED IN CODE (spike 1) — [VERIFIED].**
   `apps/collector/src/connectors/claude-code.ts:122-130` creates **one raw record per JSONL line**
   (`id: rawId = record.uuid ?? "${session}:${lineIndex}"`, `payload: line`); `:191-222` sets every
   event's `rawRecordId: rawId`, and `message.user`/`message.assistant` use that real `rawId`. On the
   server, `repositories/ingest.ts:28-44` writes `raw_source_records.sourceRecordId = wire
   sourceRecordId`, and `packages/shared/src/ingest.ts:69-77` maps wire `sourceRecordId = collector r.id
   = rawId`. ⇒ **the transcript join is `events.rawRecordId = raw_source_records.sourceRecordId` scoped by
   `sessionId`.** A single line spawns many events ⇒ **dedupe by `rawRecordId`**. The synthetic
   `session.started` rawId (`"${session}:session"`, claude-code.ts:181) has NO raw record ⇒ selecting
   only `message.*` events avoids it. (Codex/Gemini follow the same `rawRecordId`→event contract:
   `codex-cli.ts:157-167`, `gemini-cli.ts:117-145`.)

3. **Cap-budget is grounded in REAL data (spike 1) — [VERIFIED].** Profiling a real 7 MB / 3091-line
   Claude session: **84% of bytes are `attachment` records** (6 MB; the parser maps these to
   `context.loaded`, NOT messages), tool_result carriers ≈ 0.5 MB; the actual conversation — user prompt
   strings (~3 KB) + assistant `text` blocks (~76 KB) — is **~80 KB of 7 MB**. Sessions on disk reach
   **16 MB** (avg 582 KB across 435 files). ⇒ Selecting `message.*` events (not raw bytes) is what keeps
   the bundle compact and high-signal; a global char cap + per-record truncation bound the tool-result
   carrier lines that `message.user` also fires on (claude-code.ts:192-217). **Default caps below are set
   from this profile.**

4. **Provider wire shapes — success shapes specified from the stable public APIs; OpenAI error/auth
   shape confirmed (spike 2).** A live success round-trip was intentionally deferred (user decision: no
   credential on the test path). Spike 2 hit the local OpenAI-compatible proxy (litellm `:4000`) and
   confirmed `Authorization: Bearer` + the error envelope `{"error":{"message","type","code"}}`. The
   **executor MUST cross-check the Anthropic request/response + headers against the built-in `claude-api`
   skill before writing `anthropic.ts`** (CLAUDE.md trigger: any Anthropic-shaped code reads `claude-api`
   first). Both success shapes are specified in "Patterns to Follow" with the exact extraction.

5. **The store + fetch/list + admin-route + version-bump are proven END-TO-END — [VERIFIED].** M7's
   `report_artifacts` table (`schema.ts:224-253`), `insertReportArtifact` (version-bump in a tx,
   `repositories/reports.ts:36-58`), `getReportArtifact`/`listReportArtifacts` (`:60-92`), and the
   admin-gated `routes/reports.ts` (`adminAuthorized`→401, `isUuid`→404, `getProjectName` existence
   guard→404, `ensureUserByEmail`) all work for ANY `reportType` string and any `metrics`/`params` jsonb.
   M8 reuses them unchanged.

6. **Dependency injection for the provider is the proven `buildApp` pattern — [VERIFIED].**
   `apps/ingest/src/app.ts:14-32` already injects `db` + `adminToken` via `BuildAppOptions` + `app.
   decorate`. M8 adds `analysisProvider` the same way; `app.int.test.ts:35-36` constructs the app with
   test deps in `beforeAll`, so it injects a stub provider. `server.ts:14-15` builds real deps from env.

7. **The int-test harness + `--require-db` gate are proven — [VERIFIED].** `vitest.config.ts:7` loads
   `.env` (so int tests see `DATABASE_URL_TEST` + `ARCHIVE_ENCRYPTION_KEY`). `app.int.test.ts` builds the
   app in-process, `TRUNCATE … report_artifacts, …, raw_source_records, events, … RESTART IDENTITY
   CASCADE` per test (`:47`), pairs+ingests+drives flows, asserts numbers. **No new table ⇒ the TRUNCATE
   list is unchanged.** `repo-health --require-db` (`scripts/repo-health.mjs:131-170`) FAILS if any
   `*.int.test.ts` self-skips (asserts `ran>0, skipped===0`).

**Residual risks (small, contained):** (a) the live provider call's exact response/usage shape — retired
by the `claude-api` cross-check + injected-stub tests + the manual-validation gate (Level 4); (b)
redaction completeness (a regex set never catches everything) — mitigated by the entropy backstop, an
explicit known-patterns list, and unit tests, and bounded by single-user/self-hosted trust + the fact
that the *output* is the AI's findings, not the raw content; (c) cap tuning — grounded by spike 1, and
the bundle records `truncated`/`bundleChars` so over/under-capping is observable.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/db/src/crypto.ts` (whole file, 1-47) — Why: `decryptField`/`EncryptedField` are the exact
  primitives `sessionTranscript` calls. `decryptField` throws on a tampered/incorrect key (auth tag) —
  the repo must let that throw (silent library); a key-misconfig is a server 500, surfaced generically.
- `packages/db/src/repositories/ingest.ts` (22-90) — Why: how payloads are ENCRYPTED at write
  (`encryptField(r.payload)` for raw; `encryptField(JSON.stringify(e.payload))` for events). M8 only ever
  decrypts the **raw record** payload (the verbatim line/JSON), NOT `events.payload`, for the transcript.
- `packages/db/src/repositories/ingest.int.test.ts` (1-75) — Why: the **decrypt round-trip template** for
  `transcript.int.test.ts` — ingest a batch (which encrypts), then assert the decrypted read. Mirror the
  `skipIf(!TEST_URL)`, `beforeEach` TRUNCATE, direct-insert style.
- `packages/db/src/repositories/projections.ts` (`sessionDetail` 242-250; `sessionAggregateColumns`
  158-176; `usageTotals`/`usageByModel`/`usageOverTime` 74-151; `sessionProjections` 222-236) — Why: the
  M6 metrics the bundle embeds (session metrics for the session bundle; project usage + session list for
  the project bundle). Note `sessionDetail` returns a **zeroed** projection (eventCount 0) for an unknown
  id — the orchestrator uses `eventCount === 0` to 404 BEFORE calling the provider (D8).
- `packages/db/src/schema.ts` (`events` 96-129, `rawSourceRecords` 69-94, `reportArtifacts` 224-253) —
  Why: the columns the transcript join + store touch. `events.rawRecordId` (text) ↔
  `rawSourceRecords.sourceRecordId` (text), both scoped by `sessionId` (text). `events.ts` is
  `mode:"string"` (ISO string — order by it directly, do NOT `new Date()`). **No column is added in M8.**
- `packages/db/src/repositories/reports.ts` (whole file) — Why: `insertReportArtifact` (version-bump),
  `getReportArtifact`, `listReportArtifacts`, `ReportArtifactRow` — reused VERBATIM to store/fetch AI
  artifacts. `metrics` is `notNull` jsonb, `params` is nullable jsonb — pass JS objects (Drizzle
  serializes).
- `apps/ingest/src/reports/generate-report.ts` (whole file) — Why: the M7 orchestrator shape M8's
  `generate-interpretation.ts` mirrors (compose db reads + a pure builder + `insertReportArtifact`;
  clock injected via `generatedAt`; silent, throws). M8 adds the provider call between build and store.
- `apps/ingest/src/routes/reports.ts` (whole file) — Why: the **route template** — `adminAuthorized`→401,
  `isUuid`→404, the `getProjectName` existence guard→404 (the M7 review's FK lesson — REUSE it),
  `ensureUserByEmail`/`DEFAULT_EMAIL`, body-schema wiring, `201` with the stored row. M8's
  `routes/interpretations.ts` clones this; fetch/list are ALREADY served by `reports.ts`’s
  `GET /v1/reports/:id` + `GET /v1/reports` (no new GET).
- `apps/ingest/src/app.ts` (whole file, 14-61) — Why: register `interpretationRoutes` (after
  `reportRoutes`); add `analysisProvider` to `BuildAppOptions` + `app.decorate("analysisProvider", …)`;
  add the `AnalysisProviderError` branch to `setErrorHandler` (→ 502/503). Read the existing handler:
  ≥500 is masked to "internal server error", so provider failures need their OWN branch to return a
  clean 502 message.
- `apps/ingest/src/server.ts` (whole file) — Why: build the real provider from env
  (`createAnalysisProvider(...)`) and pass it to `buildApp`. Mirror the `DATABASE_URL`/`ADMIN_TOKEN`
  guard style (throw a clear error if a required var is missing **only when** a provider is configured —
  see D9 for the "not configured" boot behavior).
- `apps/ingest/src/auth.ts` (`adminAuthorized`, `isUuid`) — Why: reuse the guards. Do NOT reimplement.
- `apps/ingest/src/schemas.ts` (whole file — esp. `generateSessionReportBodySchema` 165-172 +
  `listReportsQuerySchema` 174-182) — Why: the `as const` JSON-schema style for the new POST bodies.
- `apps/ingest/src/app.int.test.ts` (1-50 harness + the M7 report round-trip it already contains) — Why:
  the int-test to extend — inject a STUB provider in `beforeAll`, ingest a session, POST an
  interpretation, assert the stored artifact (markdown from the stub, redaction findings, provider
  metadata, version bump), assert empty-scope→404 (no provider call), provider-error→502, 401 without
  admin. **TRUNCATE list unchanged** (no new table).
- `packages/shared/src/reports.ts` (1-37) — Why: `ReportType` union to EXTEND; `fmtUsd`; the pure-
  renderer + clock-injection contract M8's bundle/prompt builder mirrors (dependency-free, no `new
  Date()`, type-only imports). `REPORT_VERSION` lives here — add `AI_REPORT_VERSION` alongside.
- `packages/shared/src/projections.ts` (whole file) — Why: `SessionDetail`/`UsageTotals`/`UsageByModelRow`
  /`UsageOverTimeRow`/`SessionProjection` shapes the bundle embeds (type-only import).
- `packages/shared/src/{tokens.ts,cost.ts,events.ts,index.ts}` — Why: `NormalizedTokens`/`CostResult`/
  `EventType`/`CostConfidence` vocab and the barrel where the new `redaction.ts` + `analysis.ts` exports
  land. `events.ts:19-32` is the naming precedent for the dotted `ReportType` strings.

### New Files to Create

```
packages/shared/src/
  redaction.ts            # PURE regex+entropy engine: redact(text) -> { redacted, findings };
                          #   RedactionFinding type; REDACTION_VERSION; placeholder constants
  redaction.test.ts       # exhaustive pure tests: each pattern, entropy, findings-have-no-raw-value,
                          #   placeholder stability, idempotence, empty input
  analysis.ts             # PURE bundle + prompt types & builders (provider-agnostic, clock-injected):
                          #   AnalysisReportType, SessionBundle/ProjectBundle, buildAnalysisPrompt(bundle)
                          #   -> { system, user }; AI_REPORT_VERSION; bundle cap constants
  analysis.test.ts        # pure tests: prompt includes metrics + redacted transcript + redaction summary;
                          #   never includes a raw secret; deterministic
packages/db/src/repositories/
  transcript.ts           # sessionTranscript(db, sessionId, caps?) -> ordered, deduped, decrypted,
                          #   capped TranscriptEntry[]  (the FIRST decrypt-for-render read)
  transcript.int.test.ts  # skipIf(!DATABASE_URL_TEST): ingest a session (encrypts) -> sessionTranscript
                          #   decrypts/orders/dedupes/caps; secrets NOT yet redacted here (redaction is shared)
apps/ingest/src/analysis/
  provider.ts             # AnalysisProvider interface; AnalysisRequest/Result types; AnalysisProviderError;
                          #   createAnalysisProvider(config) factory (env-driven dispatch) + notConfigured()
  anthropic.ts            # Anthropic Messages API client (fetch). READ claude-api skill FIRST.
  openai.ts               # OpenAI-compatible Chat Completions client (fetch) — Ollama/LM Studio/vLLM/OpenAI
  provider.test.ts        # pure tests with a stubbed fetch: request shaping + response/usage extraction +
                          #   non-200 -> AnalysisProviderError + timeout/abort -> AnalysisProviderError
  generate-interpretation.ts  # orchestrator: build bundle (metrics + decrypt+redact transcript) ->
                              #   provider.interpret -> insertReportArtifact. The §18 redact-before-send seam.
apps/ingest/src/routes/
  interpretations.ts      # admin-gated POST /v1/sessions/:id/interpretations + /v1/projects/:id/interpretations
```

### Files to MODIFY

```
packages/shared/src/reports.ts   # EXTEND ReportType with the two AI types; add AI_REPORT_VERSION
packages/shared/src/index.ts     # export redaction.ts + analysis.ts surface + new ReportType members
packages/db/src/index.ts         # export sessionTranscript + TranscriptEntry type (NO schema export change)
apps/ingest/src/app.ts           # BuildAppOptions.analysisProvider; decorate; register interpretationRoutes;
                                 #   AnalysisProviderError -> 502 / NotConfigured -> 503 handler branch
apps/ingest/src/server.ts        # createAnalysisProvider(from env) -> buildApp({..., analysisProvider})
apps/ingest/src/schemas.ts       # generateSessionInterpretationBodySchema + generateProjectInterpretationBodySchema
apps/ingest/src/app.int.test.ts  # inject stub provider; interpretation round-trip; 404/502/401 cases
.env.example                     # ANALYSIS_PROVIDER / _API_KEY / _MODEL / _BASE_URL / _MAX_OUTPUT_TOKENS / _TIMEOUT_MS
README.md                        # bump Status; brief M8 note (no convention re-paste)
```

> **NO migration is created in M8.** If you find yourself running `db:generate`, stop — the AI artifact
> reuses the M7 `report_artifacts` shape. The only `@420ai/db` change is a new read repo + a barrel
> export. (Contrast M7, which DID add a table + `0002_*` migration.)

### Relevant Documentation — READ BEFORE IMPLEMENTING

- **The built-in `claude-api` skill — READ IT BEFORE WRITING `anthropic.ts`** (CLAUDE.md trigger: any
  Anthropic/Claude-shaped code). Confirm: endpoint `POST https://api.anthropic.com/v1/messages`; headers
  `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`; request `{ model,
  max_tokens, system?, messages:[{role,content}] }`; response `{ content:[{type:"text",text}], model,
  stop_reason, usage:{input_tokens,output_tokens} }`; current model ids (e.g. `claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`). Use it as the source of truth over this plan if they differ.
- `docs/PRD.md` §16.2 (AI Interpretation Pipeline — configurable provider; **compact, redacted report
  bundle**; Markdown findings + recommendations + Mermaid + governance/efficiency observations; **hosted
  APIs + OpenAI-compatible providers**), §18 + §18.1 (encryption split; **"redaction applies before AI
  analysis or external export"**; **"redaction findings are stored as metadata"**; "decrypt only to
  render a session or to feed the redaction pipeline"), §18.2 (**regex + entropy** secret scanner), §15
  (versioned, retained report artifacts; manual-first), §23 (track report/analysis version — `report
  Version`).
- `docs/CONTEXT.md` — name code after: **AI Interpretation Pipeline**, **Analysis Provider**,
  **OpenAI-Compatible Analysis Provider**, **Redaction Pipeline**, **Redaction Finding** ("metadata …
  *without exposing the sensitive value*"), **Report Artifact** ("stored with metadata such as **model
  used, data sources, analysis version**"), **Deterministic Metrics Pipeline**, **Maximum Archival
  Fidelity** ("redaction applied before external analysis or export rather than before durable storage").
- `.agents/plans/m7-reporting-foundation.md` + `.agents/code-reviews/m7-reporting-foundation.md` — Why:
  M8 consumes M7's store/routes; **carry the M7 review's FK lesson** (a write whose row/scope references
  another table must guard EXISTENCE, not just `isUuid`), the "empty scope" edge contract, and the
  D2-style precedence-rule discipline (state which instruction wins).
- `.agents/plans/m6-event-projections.md` — Why: the `mode:"string"` timestamp + `numeric`→string driver
  gotchas (CLAUDE.md "Drizzle/SQL gotchas") the transcript ordering must respect.
- Anthropic Messages API https://docs.anthropic.com/en/api/messages ; OpenAI Chat Completions
  https://platform.openai.com/docs/api-reference/chat/create ; Ollama OpenAI-compat
  https://github.com/ollama/ollama/blob/main/docs/openai.md — Why: the two client wire shapes.
- Mermaid (the AI emits its own diagrams) — no renderer change needed; M8 stores the model's raw Markdown.

### Patterns to Follow

**Redaction engine (PURE, dependency-free; mirror the `@420ai/shared` style — no I/O, no `new Date()`):**
```ts
// packages/shared/src/redaction.ts  (illustrative — findings carry NO raw value, CONTEXT "Redaction Finding")
export const REDACTION_VERSION = "m8-redact-v1";

/** A detected secret/PII span — METADATA ONLY. The raw value is NEVER stored here (PRD §18). */
export interface RedactionFinding {
  kind: string;        // "anthropic_key" | "aws_access_key" | "github_token" | "openai_key" |
                       // "google_api_key" | "slack_token" | "jwt" | "private_key_block" |
                       // "bearer_auth" | "generic_secret_assignment" | "connection_string" |
                       // "email" | "home_user_path" | "high_entropy"
  ruleId: string;      // stable id of the rule that matched (for auditing)
  count: number;       // how many spans this rule masked
  placeholder: string; // e.g. "[REDACTED:anthropic_key]" — what replaced each span
}

export interface RedactionResult { redacted: string; findings: RedactionFinding[]; }

/**
 * Mask known secret/credential/PII patterns (regex) PLUS a high-entropy backstop, returning the masked
 * text and per-kind findings. Deterministic + idempotent (re-running on the output is a no-op: the
 * placeholders contain no secret material and match nothing). NEVER returns the raw matched value.
 */
export function redact(text: string): RedactionResult { /* regex pass, then entropy pass; see Task 1 */ }
```
> **Findings invariant:** a `RedactionFinding` MUST NOT contain the matched substring — only kind/count/
> placeholder. A unit test asserts that for an input containing `sk-ant-XXXX`, no finding (and nothing
> persisted) contains `XXXX`. **Placeholders are stable strings** so the same secret masks identically
> across a transcript (helps the model see "the same token recurs" without seeing it).

**Transcript read (mirror `ingest.int.test.ts` round-trip + `projections.ts` query style; FIRST decrypt read):**
```ts
// packages/db/src/repositories/transcript.ts (illustrative)
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import { events, rawSourceRecords } from "../schema.js";

export interface TranscriptEntry { role: "user" | "assistant"; text: string; ts: string; truncated: boolean; }
export interface TranscriptCaps { maxRecords: number; maxCharsPerRecord: number; maxTotalChars: number; }
/** Defaults grounded by spike 1 (real sessions are multi-MB; the conversation is ~tens of KB). */
export const DEFAULT_TRANSCRIPT_CAPS: TranscriptCaps = {
  maxRecords: 200, maxCharsPerRecord: 4000, maxTotalChars: 48000,
};

/**
 * Decrypt a session's message transcript: select message.user/message.assistant events, resolve each to
 * its raw record (events.rawRecordId = raw.sourceRecordId, scoped by sessionId), decrypt the verbatim
 * payload, order by ts then eventIndex, DEDUPE by rawRecordId (one line spawns many events), and CAP.
 * Returns plaintext entries — the caller MUST redact before sending/storing (PRD §18). Throws on a
 * decrypt/key error (silent library).
 */
export async function sessionTranscript(
  db: DbClient, sessionId: string, caps: TranscriptCaps = DEFAULT_TRANSCRIPT_CAPS,
): Promise<{ entries: TranscriptEntry[]; totalChars: number; truncated: boolean }> {
  const rows = await db
    .select({
      role: events.eventType, ts: events.ts, eventIndex: events.eventIndex,
      rawRecordId: events.rawRecordId,
      ciphertext: rawSourceRecords.payloadCiphertext,
      iv: rawSourceRecords.payloadIv, tag: rawSourceRecords.payloadTag,
    })
    .from(events)
    .innerJoin(
      rawSourceRecords,
      and(eq(rawSourceRecords.sourceRecordId, events.rawRecordId),
          eq(rawSourceRecords.sessionId, events.sessionId)),
    )
    .where(and(eq(events.sessionId, sessionId),
               inArray(events.eventType, ["message.user", "message.assistant"])))
    .orderBy(asc(events.ts), asc(events.eventIndex));
  // dedupe by rawRecordId (first wins), decrypt, per-record truncate, global cap → see Task 5
}
```
> **GOTCHAs:** (1) `events.ts` is `mode:"string"` — order by it directly; do NOT coerce to `Date`.
> (2) `payloadCiphertext`/`payloadIv`/`payloadTag` are NON-null on raw records (schema.ts:80-82) — but
> only message lines have a real raw record; the inner join already restricts to those. (3) Dedupe by
> `rawRecordId` AFTER ordering (a line → many events). (4) The decrypted text is the **verbatim JSONL
> line / Gemini message JSON** (connector-native) — do NOT parse it into structured fields here; the
> redaction engine + the model handle semi-structured text. (5) This repo returns PLAINTEXT — annotate
> that the caller is contractually required to redact before it leaves the process.

**Bundle + prompt builder (PURE, in `@420ai/shared`; provider-agnostic, clock-injected):**
```ts
// packages/shared/src/analysis.ts (illustrative)
import type { SessionDetail, UsageTotals, UsageByModelRow, UsageOverTimeRow, SessionProjection } from "./projections.js";
import type { RedactionFinding } from "./redaction.js";

export type AnalysisReportType = "session.ai_interpretation" | "project.ai_interpretation";
export const AI_REPORT_VERSION = "m8-ai-v1";   // pipeline identity (PRD §23 analysis version)

export interface SessionBundle {
  kind: "session"; sessionId: string; generatedAt: string;
  metrics: SessionDetail;
  transcript: { role: "user" | "assistant"; text: string }[];  // ALREADY REDACTED by the orchestrator
  redactionFindings: RedactionFinding[]; transcriptTruncated: boolean;
}
export interface ProjectBundle {
  kind: "project"; projectId: string; projectName: string; generatedAt: string;
  metrics: { totals: UsageTotals; byModel: UsageByModelRow[]; overTime: UsageOverTimeRow[];
             sessions: SessionProjection[] };
  // project bundle has NO transcript (cross-session content is unbounded — D4)
}
export type AnalysisBundle = SessionBundle | ProjectBundle;

/** Build the provider-agnostic prompt. Returns { system, user } strings; each provider client adapts them. */
export function buildAnalysisPrompt(bundle: AnalysisBundle): { system: string; user: string } { /* Task 6 */ }
```
> The prompt instructs the model to return **Markdown** with findings, recommendations, Mermaid, and
> context/efficiency observations (PRD §16.2), grounded ONLY in the bundle. The builder is pure and
> tested without a network. The transcript it embeds is **already redacted** (the orchestrator redacts
> before calling the builder) — `buildAnalysisPrompt` never sees raw content.

**Analysis Provider (INJECTED; two `fetch` clients; mirror the `syncOnce({ post })` injection idiom):**
```ts
// apps/ingest/src/analysis/provider.ts (illustrative)
export interface AnalysisRequest { system: string; user: string; maxOutputTokens: number; }
export interface AnalysisResult {
  markdown: string; model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface AnalysisProvider { interpret(req: AnalysisRequest): Promise<AnalysisResult>; }

/** Clean, mappable failure for ANY provider problem (non-200, timeout, parse, not-configured). */
export class AnalysisProviderError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "not_configured" = "unavailable") {
    super(message); this.name = "AnalysisProviderError";
  }
}

export interface AnalysisProviderConfig {
  provider: "anthropic" | "openai";
  apiKey: string; model: string; baseUrl?: string;
  maxOutputTokens: number; timeoutMs: number;
}
/** Build the real provider from env config; or a notConfigured() stand-in that throws on use (D9). */
export function createAnalysisProvider(cfg: AnalysisProviderConfig | null): AnalysisProvider { /* Task 8 */ }
```
**Anthropic client (READ `claude-api` skill first) — request + extraction:**
```ts
// apps/ingest/src/analysis/anthropic.ts (illustrative — verify against claude-api skill)
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({ model: cfg.model, max_tokens: cfg.maxOutputTokens,
                         system: req.system, messages: [{ role: "user", content: req.user }] }),
  signal: AbortSignal.timeout(cfg.timeoutMs),
});
if (!res.ok) throw new AnalysisProviderError(`anthropic ${res.status}`);
const json = await res.json();
const markdown = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
return { markdown, model: json.model ?? cfg.model,
         usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens } };
```
**OpenAI-compatible client — request + extraction (Ollama/LM Studio/vLLM/OpenAI):**
```ts
// apps/ingest/src/analysis/openai.ts (illustrative)
const base = cfg.baseUrl ?? "https://api.openai.com/v1";
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({ model: cfg.model, max_tokens: cfg.maxOutputTokens,
                         messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
  signal: AbortSignal.timeout(cfg.timeoutMs),
});
if (!res.ok) throw new AnalysisProviderError(`openai-compatible ${res.status}`);
const json = await res.json();
const markdown = json.choices?.[0]?.message?.content ?? "";
return { markdown, model: json.model ?? cfg.model,
         usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens } };
```
> **Wrap network/parse failures** (`fetch` reject, abort/timeout, non-200, empty `markdown`) in
> `AnalysisProviderError` so the route maps them to a clean **502** (never a leaked 500). `AbortSignal.
> timeout` is Node ≥ 17 native — no dependency.

**Orchestrator (the §18 redact-before-send seam; mirror `generate-report.ts`):**
```ts
// apps/ingest/src/analysis/generate-interpretation.ts (illustrative)
export async function generateSessionInterpretation(
  db: Db, provider: AnalysisProvider, userId: string, sessionId: string, generatedAt: string,
  maxOutputTokens: number,
): Promise<ReportArtifactRow> {
  const metrics = await sessionDetail(db, sessionId);
  if (metrics.eventCount === 0) throw new NotFoundError("session has no events");   // D8 — 404, no provider call
  const raw = await sessionTranscript(db, sessionId);                                // DECRYPTED (plaintext)
  const findings: RedactionFinding[] = [];
  const transcript = raw.entries.map((e) => {                                        // REDACT before anything leaves
    const r = redact(e.text); findings.push(...r.findings);
    return { role: e.role, text: r.redacted };
  });
  const bundle: SessionBundle = { kind: "session", sessionId, generatedAt, metrics,
    transcript, redactionFindings: mergeFindings(findings), transcriptTruncated: raw.truncated };
  const { system, user } = buildAnalysisPrompt(bundle);
  const result = await provider.interpret({ system, user, maxOutputTokens });        // only redacted text leaves
  return insertReportArtifact(db, {
    userId, projectId: null, reportType: "session.ai_interpretation",
    scopeKind: "session", scopeId: sessionId, reportVersion: AI_REPORT_VERSION,
    params: { provider: result.model, maxOutputTokens },
    metrics: { kind: "session", metrics, redactionFindings: bundle.redactionFindings,
               model: result.model, usage: result.usage,
               transcriptTruncated: raw.truncated, bundleChars: user.length },
    markdown: result.markdown,
  });
}
// generateProjectInterpretation: getProjectName -> 404 if absent; usageTotals+byModel+overTime+sessionProjections;
//   if totals.eventCount === 0 -> 404; NO transcript/decrypt (D4); redact() the prompt's string fields defensively;
//   store reportType "project.ai_interpretation", scopeKind "project", scopeId projectId, projectId set.
```

**Admin routes (mirror `routes/reports.ts` — gate, guards, existence check, 201):**
```
POST /v1/sessions/:sessionId/interpretations   body { type?: "session.ai_interpretation" }
   adminAuthorized→401; :sessionId is text (ungated); sessionDetail.eventCount===0 → 404 (no provider call);
   resolve userId via ensureUserByEmail; generatedAt = new Date().toISOString(); → 201 ReportArtifactRow
POST /v1/projects/:id/interpretations          body { type?: "project.ai_interpretation" }
   adminAuthorized→401; isUuid(:id)→404; getProjectName(:id) undefined → 404 (M7 FK lesson);
   usageTotals.eventCount===0 → 404; → 201
// fetch/list reuse the M7 endpoints unchanged: GET /v1/reports/:id , GET /v1/reports?type=&scopeId=
```
> **Precedence rule (resolves "mirror reports.ts" vs the empty-scope contract):** M7's session autopsy
> returns a zeroed Markdown report for an unknown/empty session (no 404). **M8 OVERRIDES that for
> interpretations: an empty scope → 404 and the provider is NOT called**, because the provider call is a
> billable external side effect and an empty bundle yields no useful analysis. State this in the route
> + orchestrator comments. The route owns the clock (`generatedAt`) exactly as `routes/reports.ts` does.

**Library files never log / `process.exit`** (CLAUDE.md): `redaction.ts`, `analysis.ts`, `transcript.ts`,
`generate-interpretation.ts`, and the provider clients are silent — they throw typed errors
(`AnalysisProviderError`, a not-found error); only the Fastify error handler surfaces anything. The
provider is injected so int tests pass a deterministic stub.

---

## KEY DESIGN DECISIONS (read before coding)

### D1 — Two AI report types, both threaded end-to-end (Scope Decision 2)
`session.ai_interpretation` (metrics + redacted transcript) and `project.ai_interpretation` (metrics
only). Both go bundle→redact→provider→store→fetch/list. The `ReportType`/`AnalysisReportType` union makes
adding more later purely additive.

### D2 — Reuse `report_artifacts`; NO migration (Scope Decision 4)
The AI findings ARE a report artifact (CONTEXT "Report Artifact": stored with "model used, data sources,
analysis version"). Store: `markdown` = AI findings; `metrics` jsonb = `{ kind, metrics:<deterministic
snapshot>, redactionFindings, model, usage, transcriptTruncated, bundleChars }`; `params` jsonb =
`{ provider:<model>, maxOutputTokens }`; `reportVersion` = `AI_REPORT_VERSION`. `reportType` discriminates
deterministic (M7) vs AI (M8) artifacts. `insertReportArtifact` version-bumps per `(userId, reportType,
scopeId)` — regenerating an interpretation appends a new version (history retained), identical to M7.

### D3 — Redaction is a pure shared engine and a HARD pre-send/pre-store gate (PRD §18/§18.2)
`redact(text) → { redacted, findings }`, regex (known key/token/credential/PII/home-path patterns) +
a Shannon-entropy backstop for unknown high-entropy tokens. Findings are **metadata only** (no raw
value). The orchestrator redacts the decrypted transcript **before** building the prompt, **before**
the provider call, and **before** storage. Decrypted-but-unredacted text lives only transiently in the
orchestrator and is never sent/logged/stored.

### D4 — Session bundle decrypts a transcript; project bundle is metrics-only
Session interpretation includes a **redacted, capped transcript** (the genuine "redaction over decrypted
content"). Project interpretation is **metrics-only** (usage totals/by-model/over-time + the session
list) — a cross-session transcript would be unbounded (spike 1: single sessions reach 16 MB). Only the
SESSION path calls `sessionTranscript`/`decryptField`.

### D5 — Transcript = message events → raw records → decrypt → order → dedupe → cap (spike-grounded)
Select `message.user`/`message.assistant` events, join to their raw record on `rawRecordId =
sourceRecordId` (scoped by `sessionId`), decrypt the verbatim line, order by `ts`+`eventIndex`, dedupe by
`rawRecordId`, and cap (`maxRecords`/`maxCharsPerRecord`/`maxTotalChars`, defaults from spike 1). This
naturally excludes the attachment/tool-result bulk (84%/0.5 MB of a session) and needs no connector
re-parsing. `truncated`/`bundleChars` are recorded on the artifact.

### D6 — Provider is injected, configurable, dependency-free; both clients first-class (Scope Decision 3)
`AnalysisProvider` is injected via `BuildAppOptions` (proven `buildApp` pattern). `createAnalysisProvider`
dispatches on `ANALYSIS_PROVIDER` to the Anthropic or OpenAI-compatible `fetch` client. No SDK. All
automated tests inject a stub; the live client runs only in `server.ts` + manual validation.

### D7 — Prompt building is pure and provider-agnostic (in `@420ai/shared`)
`buildAnalysisPrompt(bundle) → { system, user }`. The two clients adapt those into their wire shapes
(Anthropic `system` + `messages`; OpenAI `system`+`user` messages). Unit-tested without a network; the
bundle it receives is already redacted.

### D8 — Empty/unknown scope → 404, provider NOT called (overrides M7's "empty → zeros")
A session with `eventCount === 0` or a non-existent project (uuid malformed → 404; well-formed but absent
→ `getProjectName` undefined → 404, the M7 FK lesson) returns 404 **before** any provider call. Rationale:
the call is billable and an empty bundle is useless. This is a deliberate, documented divergence from M7.

### D9 — "Not configured" boots cleanly; only interpretation endpoints fail (503)
If `ANALYSIS_PROVIDER`/`ANALYSIS_API_KEY` are unset, `server.ts` passes a **notConfigured provider** to
`buildApp` (one that throws `AnalysisProviderError(kind:"not_configured")` on `interpret`). The server
still boots and all M1–M7 endpoints work; only `POST …/interpretations` returns **503** ("analysis
provider not configured"). This keeps the archive usable without an AI key and makes the missing-config
failure explicit, not a crash. (Anthropic default model + OpenAI base-URL default documented in
`.env.example`.)

### D10 — Errors map to clean codes (no leaked 500s)
`AnalysisProviderError(kind:"unavailable")` → **502**; `kind:"not_configured"` → **503**; the
empty/absent-scope not-found → **404**; a malformed body → **400** (schema enum). Add the
`AnalysisProviderError` branch to `app.ts`’s `setErrorHandler` (the existing handler masks ≥500 to
"internal server error", so provider errors need their own branch to surface a useful message).

### D11 — `AI_REPORT_VERSION` + provider/model stamp the analysis identity (PRD §23)
`reportVersion = AI_REPORT_VERSION` ("m8-ai-v1") records the pipeline version; the resolved provider
`model` + `REDACTION_VERSION` are stored in `metrics`/`params` so a future replay can distinguish
artifacts produced by a different model or redaction ruleset. (PRD §23 "track report/analysis version".)

---

## Lessons from M4–M7 to apply (do NOT relearn these)

- **Run the gate with the test DB up before declaring done.** M8 adds a decrypt read + provider int
  tests → `npm run repo-health -- --require-db` is MANDATORY (asserts the int layer ran, 0 skipped). A
  green suite with int tests skipped is NOT green (CLAUDE.md).
- **A guard sufficient for a READ is insufficient for a WRITE referencing another row.** Reuse the M7
  `getProjectName`→404 existence guard on `POST /v1/projects/:id/interpretations` (the artifact's
  `project_id` FKs to `projects.id`). D8.
- **Verify output shape against the live DB, not just types.** The transcript int test asserts the
  decrypted, ordered, deduped, capped content against a real ingested session — not just that rows came
  back. (M5/M6 bugs were shape mismatches invisible to `tsc`.)
- **`mode:"string"` timestamps are strings.** Order the transcript by `events.ts` directly; do not coerce.
- **State which instruction wins when two could conflict** — D8 (empty→404) explicitly overrides M7's
  empty→zeros for the billable interpretation path.
- **No dependency creep.** M8 adds NO npm dependency (native `fetch`/`AbortSignal.timeout`).
- **Keep the milestone diff clean** — no migration, no schema export change, no collector change.

---

## IMPLEMENTATION PLAN

### Phase 1: Redaction + analysis primitives (`@420ai/shared`, pure, no infra)
Build and unit-test the Redaction Pipeline and the bundle/prompt builder + extend `ReportType`. These are
pure functions — the security-critical core, fully tested with zero infra.

### Phase 2: Decryption read (`@420ai/db`, no schema change)
Add `sessionTranscript` (the first decrypt-for-render read) + barrel export; int-test the decrypt round
-trip against a real ingested session.

### Phase 3: Provider + orchestrator + server surface (`apps/ingest`)
Add the injected provider abstraction + two `fetch` clients, the generation orchestrator (the
redact-before-send seam), the admin routes, the body schemas, the `BuildAppOptions`/`server.ts` wiring,
and the error-handler branch.

### Phase 4: Tests, validation, docs
Pure unit tests (redaction, analysis, provider with stubbed fetch) + Postgres-gated int tests (transcript
decrypt; ingest interpretation round-trip with an injected stub provider; 404/502/401 cases) + the full
`repo-health -- --require-db` gate + `.env.example` + README.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Run each task's VALIDATE before moving on.

### Task 1 — CREATE `packages/shared/src/redaction.ts`
- **IMPLEMENT**: `REDACTION_VERSION`; `RedactionFinding`/`RedactionResult` types; `redact(text)`. A regex
  pass with a documented rule table — at minimum: `private_key_block` (`-----BEGIN [A-Z ]*PRIVATE
  KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`), `anthropic_key` (`sk-ant-[A-Za-z0-9_\-]{20,}`),
  `openai_key` (`sk-(proj-)?[A-Za-z0-9_\-]{20,}`), `aws_access_key` (`AKIA[0-9A-Z]{16}`), `github_token`
  (`gh[pousr]_[0-9A-Za-z]{36,}`), `google_api_key` (`AIza[0-9A-Za-z_\-]{35}`), `slack_token`
  (`xox[baprs]-[0-9A-Za-z\-]{10,}`), `jwt` (`eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+`),
  `bearer_auth` (`(?i)(authorization|bearer)\s*[:=]\s*\S+`), `connection_string`
  (`[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@`), `generic_secret_assignment`
  (`(?i)(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{6,}`), `email`
  (`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`), `home_user_path`
  (`(?:/home/|/Users/|[A-Za-z]:\\\\Users\\\\)([^/\\\\\s]+)` — mask the USERNAME segment only). Then a
  high-entropy backstop: tokenize on whitespace/quotes/`,;` and mask tokens ≥ 24 chars whose Shannon
  entropy ≥ 4.0 bits/char and charset diversity is high (kind `high_entropy`), skipping already-masked
  placeholders. Replace each match with a STABLE `[REDACTED:<kind>]` placeholder; accumulate per-kind
  findings (kind, ruleId, count, placeholder). Apply patterns longest/most-specific first; the entropy
  pass runs LAST so specific kinds win.
- **PATTERN**: pure `@420ai/shared` module — no I/O, no `new Date()`, no deps. Mirror the `cost.ts`/
  `tokens.ts` "pure function + exported types" style.
- **GOTCHA**: findings MUST NOT carry the raw value. Redaction MUST be idempotent (placeholders contain
  no secret material and match no rule). Guard regexes against catastrophic backtracking (anchor + bounded
  quantifiers; the private-key block is the only multiline rule — keep it lazy). Do NOT mask plain file
  paths that lack a username (only the home-dir username segment is PII).
- **VALIDATE**: `npm run -w @420ai/shared build` (exit 0).

### Task 2 — CREATE `packages/shared/src/redaction.test.ts`
- **IMPLEMENT**: one test per rule (a positive sample masks; a benign near-miss does not over-mask);
  the entropy backstop masks a random 40-char token but NOT ordinary prose/words; `findings` never
  contain the raw secret (assert the matched value is absent from `JSON.stringify(findings)` AND from
  `redacted`); idempotence (`redact(redact(x).redacted).findings` is empty); empty/whitespace input
  returns `{ redacted: "", findings: [] }`; counts are correct for repeated secrets; the home-path rule
  masks only the username (`/home/alice/x` → `/home/[REDACTED:home_user_path]/x`).
- **PATTERN**: existing `packages/shared/src/*.test.ts` (vitest, co-located, no infra).
- **VALIDATE**: `npm test -w @420ai/shared -- redaction` (exit 0).

### Task 3 — UPDATE `packages/shared/src/reports.ts` + CREATE `packages/shared/src/analysis.ts`
- **IMPLEMENT (reports.ts)**: extend `ReportType` to `"project.cost_over_time" | "session.autopsy" |
  "session.ai_interpretation" | "project.ai_interpretation"`. Do NOT change `REPORT_VERSION`.
- **IMPLEMENT (analysis.ts)**: `AnalysisReportType`; `AI_REPORT_VERSION = "m8-ai-v1"`; `SessionBundle`/
  `ProjectBundle`/`AnalysisBundle` types; bundle cap constants (re-export or reference the db defaults
  conceptually — keep the numeric defaults in the db `transcript.ts` to avoid duplication, and document
  here); `buildAnalysisPrompt(bundle): { system, user }`. The `system` prompt: "You are a senior engineer
  analyzing one AI coding session/project. Output GitHub-flavored Markdown with sections: Summary,
  Findings, Recommendations, and at least one Mermaid diagram. Ground every claim ONLY in the provided
  data; the transcript is redacted — `[REDACTED:*]` are masked secrets, do not speculate about them." The
  `user` message: serialize the metrics (compact) + the redacted transcript (role-tagged) + a redaction
  summary (kinds + counts). Deterministic ordering; no `new Date()`.
- **PATTERN**: `reports.ts` renderer style (pure, string-building, type-only imports from
  `projections.js`/`redaction.js`).
- **GOTCHA**: `buildAnalysisPrompt` receives an ALREADY-redacted transcript — it must not be the place
  redaction happens. Keep the prompt compact (it rides the `maxTotalChars` cap already applied upstream).
- **VALIDATE**: `npm run -w @420ai/shared build` (exit 0).

### Task 4 — CREATE `packages/shared/src/analysis.test.ts` + UPDATE `packages/shared/src/index.ts`
- **IMPLEMENT (test)**: feed a hand-built `SessionBundle` (with a redacted transcript + findings) and a
  `ProjectBundle` to `buildAnalysisPrompt`; assert `system` mentions Markdown + Mermaid; assert `user`
  contains the metric numbers, the role-tagged transcript lines, and the redaction summary; assert a
  `[REDACTED:*]` placeholder survives but no raw secret is present; deterministic (same input → same
  output).
- **IMPLEMENT (barrel)**: export from `index.ts`: `redact`, `RedactionFinding`, `RedactionResult`,
  `REDACTION_VERSION`; `AnalysisReportType`, `AnalysisBundle`/`SessionBundle`/`ProjectBundle`,
  `buildAnalysisPrompt`, `AI_REPORT_VERSION`; the extended `ReportType` (already exported).
- **VALIDATE**: `npm test -w @420ai/shared` (exit 0).

### Task 5 — CREATE `packages/db/src/repositories/transcript.ts` + UPDATE `packages/db/src/index.ts`
- **IMPLEMENT**: `TranscriptEntry`/`TranscriptCaps`/`DEFAULT_TRANSCRIPT_CAPS`; `sessionTranscript(db,
  sessionId, caps?)` per "Patterns to Follow" — select message events, inner-join raw records on
  `(sourceRecordId = rawRecordId AND sessionId = sessionId)`, order by `ts`+`eventIndex`, dedupe by
  `rawRecordId` (first wins), `decryptField` each kept row, per-record truncate to `maxCharsPerRecord`
  (set `truncated`), stop at `maxRecords`/`maxTotalChars` (set the result `truncated`). `role` derives
  from `eventType` (`message.user`→"user", `message.assistant`→"assistant"). Export `sessionTranscript` +
  `TranscriptEntry`/`TranscriptCaps`/`DEFAULT_TRANSCRIPT_CAPS` from the barrel.
- **PATTERN**: `repositories/projections.ts` query style + `repositories/ingest.int.test.ts` decrypt
  round-trip; `decryptField` from `../crypto.js`.
- **GOTCHA**: `events.ts` is `mode:"string"` — order by it directly. The inner join already restricts to
  message lines that HAVE a raw record (the synthetic `session.started` rawId has none and isn't selected
  anyway). `decryptField` throws on a key/tag error — let it propagate (silent library). Return PLAINTEXT;
  comment that the caller MUST redact before send/store.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 6 — CREATE `packages/db/src/repositories/transcript.int.test.ts`
- **IMPLEMENT** (`skipIf(!process.env.DATABASE_URL_TEST)`, mirror `ingest.int.test.ts`): seed a user +
  machine; `ingestBatch` a session with TWO message lines (a `message.user` raw record carrying a known
  prompt with an embedded `sk-ant-TESTKEY...`, and a `message.assistant` raw record), plus a non-message
  raw record (e.g. an attachment-like line referenced by a `context.loaded` event) that must NOT appear;
  also a duplicate event on the same `rawRecordId` (e.g. `usage.reported` on the assistant line) to prove
  dedupe. Call `sessionTranscript(db, "s1")` → assert: exactly the two message entries, ordered, deduped
  by rawRecordId, `role` correct, the decrypted text equals the ingested plaintext (secret still present —
  redaction is the SHARED engine's job, NOT this read), the non-message line excluded. Add a caps test:
  tiny `maxCharsPerRecord` → entry `truncated: true`; tiny `maxTotalChars` → result `truncated: true`.
- **GOTCHA**: excluded from `tsc -b` + self-skips without `DATABASE_URL_TEST`. `ARCHIVE_ENCRYPTION_KEY`
  comes from `.env` via `vitest.config.ts` (same as `ingest.int.test.ts`). TRUNCATE `raw_source_records,
  events, …` per test (mirror the existing cleanup).
- **VALIDATE**: `npm test` (self-skips, exit 0) AND with DB up:
  `DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test` (passes).

### Task 7 — CREATE `apps/ingest/src/analysis/provider.ts`, `anthropic.ts`, `openai.ts`
- **IMPLEMENT**: `provider.ts` — `AnalysisRequest`/`AnalysisResult`/`AnalysisProvider`/
  `AnalysisProviderError`/`AnalysisProviderConfig`; `createAnalysisProvider(cfg | null)` dispatching to
  the two clients (or a `notConfigured()` provider that throws `AnalysisProviderError(…, "not_configured")`
  when `cfg` is null). `anthropic.ts` + `openai.ts` per "Patterns to Follow" (fetch, `AbortSignal.
  timeout`, non-200/empty → `AnalysisProviderError`, response+usage extraction).
- **PATTERN**: the injection idiom (provider is a small interface, like the collector's `syncOnce({ post
  })`). `apps/ingest` library files are silent — throw `AnalysisProviderError`, never log.
- **GOTCHA**: **READ the built-in `claude-api` skill before writing `anthropic.ts`** and reconcile the
  headers/model-ids/response shape with it (it wins over this plan). Native `fetch`/`AbortSignal.timeout`
  — add NO dependency. Treat an empty `markdown` as a provider error (don't store an empty artifact).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 8 — CREATE `apps/ingest/src/analysis/provider.test.ts` (pure, stubbed fetch)
- **IMPLEMENT**: stub global `fetch` (vitest `vi.stubGlobal`); assert the Anthropic client posts the
  expected URL/headers/body and extracts `markdown`/`model`/`usage` from a canned `content[]` response;
  same for the OpenAI client (`choices[0].message.content`, `usage.prompt/completion_tokens`); a non-200
  → `AnalysisProviderError("…unavailable")`; an aborted/timed-out fetch → `AnalysisProviderError`; a
  null-config provider throws `not_configured`. No network.
- **PATTERN**: co-located `*.test.ts`, no infra. (These run under `npm test` always.)
- **VALIDATE**: `npm test -w @420ai/ingest -- provider` (exit 0). NOTE: `apps/ingest` has NO per-workspace
  `test` script — run from repo root: `npx vitest run apps/ingest/src/analysis/provider.test.ts`.

### Task 9 — CREATE `apps/ingest/src/analysis/generate-interpretation.ts`
- **IMPLEMENT**: `generateSessionInterpretation(db, provider, userId, sessionId, generatedAt,
  maxOutputTokens)` and `generateProjectInterpretation(db, provider, userId, projectId, generatedAt,
  maxOutputTokens)` per the orchestrator pattern. Session: `sessionDetail` → `eventCount===0` throws
  not-found (D8) → `sessionTranscript` → `redact` each entry (merge findings) → `buildAnalysisPrompt` →
  `provider.interpret` → `insertReportArtifact`. Project: `getProjectName` (throw not-found if undefined)
  → `usageTotals`/`usageByModel`/`usageOverTime`/`sessionProjections` → `totals.eventCount===0` throws
  not-found → build project bundle (no transcript) → defensively `redact` any string fields embedded in
  the prompt → provider → store. Both stamp `reportVersion: AI_REPORT_VERSION`, store provider model +
  usage + redaction findings in `metrics`/`params`.
- **PATTERN**: `apps/ingest/src/reports/generate-report.ts` (compose db + pure builder + store; clock
  injected; silent/throws). Use a small typed `NotFoundError` (or reuse an existing one if present —
  check `apps/ingest/src`) so the route maps it to 404; OR have the route do the existence/empty checks
  itself and the orchestrator assume non-empty. **Pick one and state it**: RECOMMENDED — the ROUTE does
  the guard checks (mirrors how `routes/reports.ts` does `getProjectName`→404 in the handler), so the
  orchestrator stays a pure compose-and-store with no HTTP concern. Then the orchestrator does not throw
  not-found; the route guarantees non-empty before calling it.
- **GOTCHA**: redaction MUST happen here BEFORE `buildAnalysisPrompt`/`provider.interpret`/store (§18).
  Never log decrypted or redacted content. `generatedAt` is injected by the route.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 10 — UPDATE `apps/ingest/src/schemas.ts`: add interpretation body schemas
- **IMPLEMENT**: `generateSessionInterpretationBodySchema` (`{ type?: enum["session.ai_interpretation"]
  }`, `additionalProperties:false`) and `generateProjectInterpretationBodySchema` (`{ type?:
  enum["project.ai_interpretation"] }`). (Fetch/list reuse M7's `listReportsQuerySchema`.)
- **PATTERN**: the `as const` JSON-schema style + `generateSessionReportBodySchema` (165-172).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 11 — CREATE `apps/ingest/src/routes/interpretations.ts`
- **IMPLEMENT** the two admin-gated POSTs per the route pattern. Session: `adminAuthorized`→401;
  `:sessionId` text (ungated); `sessionDetail.eventCount===0` → 404 (no provider call, D8);
  `ensureUserByEmail`; `generatedAt = new Date().toISOString()`; `generateSessionInterpretation(app.db,
  app.analysisProvider, userId, sessionId, generatedAt, maxOutputTokens)` → 201. Project:
  `adminAuthorized`→401; `isUuid(:id)`→404; `getProjectName`→404 (M7 FK lesson); `usageTotals.eventCount
  ===0`→404; → 201. Read `maxOutputTokens` from a route-level constant or `app`-decorated config (see
  Task 12).
- **PATTERN**: `apps/ingest/src/routes/reports.ts` verbatim (gate, guards, `DEFAULT_EMAIL`,
  body-schema wiring, 201 with the row).
- **GOTCHA**: the route OWNS the clock + the empty/existence guards (Task 9 decision). Do NOT add a
  machine-auth preHandler (admin op). An `AnalysisProviderError` thrown by the provider bubbles to the
  error handler → 502/503 (Task 13) — do NOT catch it into a 500.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 12 — UPDATE `apps/ingest/src/app.ts`: inject provider + register routes
- **IMPLEMENT**: add `analysisProvider: AnalysisProvider` (and the resolved `analysisMaxOutputTokens?:
  number`, default e.g. 4096) to `BuildAppOptions`; `app.decorate("analysisProvider", opts.
  analysisProvider)` (+ a Fastify type augmentation alongside the existing `db`/`adminToken`
  decorations — find where those are declared and extend it); `app.register(interpretationRoutes)` after
  `reportRoutes`.
- **PATTERN**: the existing `app.decorate("db", …)`/`app.decorate("adminToken", …)` (app.ts:31-32) + the
  Fastify module augmentation that types them (locate it — likely `plugins/auth.ts` or a `types.d.ts`).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 13 — UPDATE `apps/ingest/src/app.ts`: error-handler branch for provider errors
- **IMPLEMENT**: in `setErrorHandler`, before the generic `status>=500` branch, add: `if (err instanceof
  AnalysisProviderError) return reply.code(err.kind === "not_configured" ? 503 : 502).send({ error:
  err.message })`. (Import `AnalysisProviderError` from `./analysis/provider.js`.)
- **PATTERN**: the existing `PairingError`→410 branch (app.ts:46-48).
- **GOTCHA**: place it BEFORE the `status>=500` masking branch (which would otherwise hide the message).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 14 — UPDATE `apps/ingest/src/server.ts` + `.env.example`: wire the real provider from env
- **IMPLEMENT (server.ts)**: read `ANALYSIS_PROVIDER`, `ANALYSIS_API_KEY`, `ANALYSIS_MODEL`,
  `ANALYSIS_BASE_URL`, `ANALYSIS_MAX_OUTPUT_TOKENS`, `ANALYSIS_TIMEOUT_MS`. If `ANALYSIS_PROVIDER` +
  `ANALYSIS_API_KEY` are present, `createAnalysisProvider({...})`; else pass the `notConfigured` provider
  (D9 — boot still succeeds). Pass `analysisProvider` (+ `analysisMaxOutputTokens`) to `buildApp`.
- **IMPLEMENT (.env.example)**: add a documented block, **defaulting to Anthropic** (user choice Q4):
  `ANALYSIS_PROVIDER=anthropic` (alt: `openai`), `ANALYSIS_API_KEY=` (your Anthropic key),
  `ANALYSIS_MODEL=claude-sonnet-4-6` (**confirm the current Claude model id against the `claude-api`
  skill before committing the default** — use a sensible balance-tier model), `ANALYSIS_BASE_URL=`
  (OpenAI-compatible only, e.g. `http://localhost:11434/v1` for Ollama; leave blank for Anthropic),
  `ANALYSIS_MAX_OUTPUT_TOKENS=4096`, `ANALYSIS_TIMEOUT_MS=60000`. Document the OpenAI-compatible
  alternative in comments (it stays first-class). Note that leaving `ANALYSIS_PROVIDER`/`ANALYSIS_API_KEY`
  unset disables only the interpretation endpoints (503).
- **PATTERN**: `server.ts:9-15` env-guard style; `.env.example` comment style.
- **VALIDATE**: `npm run typecheck` (exit 0). (`server.ts` is not imported by tests — type-check only.)

### Task 15 — UPDATE `apps/ingest/src/app.int.test.ts`: interpretation round-trip with an injected stub
- **IMPLEMENT** (extend the suite): in `beforeAll`, build the app with a STUB `analysisProvider` whose
  `interpret(req)` returns a deterministic `{ markdown: "## Findings\n…```mermaid\n…```", model:
  "stub-model", usage: { inputTokens: 5, outputTokens: 7 } }` AND records the last `req` (to assert the
  bundle was redacted). Test: ingest a session (with message events + raw records carrying a known
  `sk-ant-…` secret) → `POST /v1/sessions/:sessionId/interpretations` → assert 201, `version:1`,
  `reportType:"session.ai_interpretation"`, `markdown` equals the stub output, `metrics.redactionFindings`
  includes the `anthropic_key` kind, the stub's received `req.user` contains `[REDACTED:anthropic_key]`
  and NOT the raw secret, `metrics.model:"stub-model"`. Regenerate → `version:2`. `GET /v1/reports/:id`
  + `GET /v1/reports?type=session.ai_interpretation&scopeId=<sessionId>` return it (M7 endpoints).
  `POST /v1/projects/:id/interpretations` for a project with events → 201 `project.ai_interpretation`.
  Edge: empty session (no events) → 404 and the stub's `interpret` was NOT called; non-existent project
  uuid → 404; non-uuid project id → 404; a SECOND stub that throws `AnalysisProviderError` →
  `POST …/interpretations` → 502; all routes → 401 without the admin token. (Use a second `buildApp` with
  the throwing stub for the 502 case, or a per-test mutable stub.)
- **GOTCHA**: TRUNCATE list is UNCHANGED (no new table). Reuse the existing ingest/discover helpers + ISO
  `ts`. Assert the provider was NOT called on the empty-scope path (the strongest D8 check + it proves no
  billable call escapes).
- **VALIDATE**: `npm test` (self-skips) / with DB up: full int passes.

### Task 16 — UPDATE README "Status" + run the gate
- **UPDATE** README Status: M8 added the AI Interpretation Pipeline — a regex+entropy Redaction Pipeline,
  the first decrypt-for-render transcript read, a configurable Analysis Provider (Anthropic +
  OpenAI-compatible, injected), and admin endpoints that generate session/project AI interpretations from
  a redacted bundle, stored as versioned `report_artifacts` (reusing the M7 store — no migration).
  Comparison, scheduled analysis, and the §21 redacted search projection deferred. Brief — no convention
  re-paste.
- **VALIDATE (the gate)**: `npm run repo-health` (root `tsc -b` + full `vitest run` + NUL + stray-artifact
  scan; exit 0), THEN with the DB up `npm run repo-health -- --require-db` (asserts the int layer ran,
  0 skipped — MANDATORY: M8 adds a decrypt read + provider int tests). Confirm NO migration was generated
  and no stray emitted JS/d.ts.

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, no infra — always run)
- `packages/shared/src/redaction.test.ts`: every rule + entropy backstop; findings carry no raw value;
  idempotence; empty input; correct counts; home-path masks only the username.
- `packages/shared/src/analysis.test.ts`: `buildAnalysisPrompt` includes metrics + redacted transcript +
  redaction summary, mentions Markdown/Mermaid, leaks no raw secret, deterministic.
- `apps/ingest/src/analysis/provider.test.ts`: both clients’ request shaping + response/usage extraction
  with a stubbed `fetch`; non-200 + timeout → `AnalysisProviderError`; null-config → `not_configured`.

### Integration Tests (`*.int.test.ts`, `DATABASE_URL_TEST`-gated, excluded from `tsc -b`)
- `packages/db/src/repositories/transcript.int.test.ts`: decrypt round-trip — message events → raw
  records → ordered, deduped, capped plaintext; non-message lines excluded; truncation flags.
- `apps/ingest/src/app.int.test.ts` additions: ingest→`POST` interpretation (session + project) with an
  injected stub provider; assert stored artifact (markdown, redaction findings, model, version bump);
  bundle sent to the provider is redacted; empty-scope→404 with NO provider call; provider-error→502;
  admin 401s; uuid-guard 404s.

### Edge Cases (must be covered)
- **Empty/unknown session** (0 events) → 404, provider NOT called (D8). **Non-existent project uuid** →
  404 (existence guard, no FK 500). **Non-uuid project id** → 404.
- **Secret in the transcript** → masked before the provider call; finding recorded; raw value never in
  the artifact or the provider request.
- **Provider down / non-200 / timeout** → 502 (clean), not a leaked 500.
- **Provider not configured** → 503 on interpretation endpoints; the rest of the API still works (D9).
- **Regeneration** of the same `(type, scope)` → new `version`, prior retained (M7 semantics).
- **Huge session** → transcript capped (`truncated:true`, `bundleChars` recorded); no unbounded bundle.
- **Idempotency note:** like M7 reports, interpretation is intentionally NON-idempotent — each POST is a
  new versioned artifact and a new (billable) provider call.

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with the stated pass signal.

### Level 1: Typecheck / Build (repo-root — catches cross-project + test-only imports)
- `npm run typecheck` → root `tsc -b`, **exit 0**. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests
- `npm test` → full `vitest run`; units always run, `*.int.test.ts` self-skip without `DATABASE_URL_TEST`.
  **All pass, exit 0.** Focused: `npx vitest run packages/shared/src/redaction.test.ts` /
  `… apps/ingest/src/analysis/provider.test.ts`. (Workspaces have NO `test` script — use `npx vitest run
  <path>` from root; `npm test -w <pkg>` fails with "Missing script".)

### Level 3: Integration Tests (Postgres) — MANDATORY (adds a decrypt read + a write/provider path)
- `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/
  420ai_test npm test` → the transcript decrypt int test + the ingest interpretation int tests pass.
  **Exit 0.** (`db:migrate` is a NO-OP for M8 — no new migration; it just confirms the schema is current.)

### Level 4: Manual Validation (real data + a real provider) — the live-call gate
- **Primary gate uses Anthropic (user choice Q4):** set `ANALYSIS_PROVIDER=anthropic`, `ANALYSIS_API_KEY=
  <your key>`, `ANALYSIS_MODEL=<current Claude id from the claude-api skill>`. (Optionally also smoke-test
  the OpenAI-compatible path against a local endpoint to prove env-selection.) Start the API
  (`npm run ingest:dev`). With the admin token:
  - `curl -s localhost:8420/v1/projects -H "authorization: Bearer $ADMIN_TOKEN"` → pick a project id and
    note a real `sessionId` (from `GET /v1/projects/<id>/sessions`).
  - `curl -s -X POST localhost:8420/v1/sessions/<sessionId>/interpretations -H "authorization: Bearer
    $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'` → 201 with `version:1`, a Markdown
    `markdown` field (findings + a Mermaid block), and `metrics.redactionFindings`/`metrics.model`
    populated. **Manually inspect the stored `markdown` + `metrics` for any leaked secret/path — there
    must be none.**
  - Repeat → `version:2`. `GET /v1/reports?type=session.ai_interpretation&scopeId=<sessionId>` lists both.
  - With `ANALYSIS_*` UNSET, the same POST → **503**; all M1–M7 endpoints still work.
- **Verify against the `claude-api` skill** that the Anthropic request/response handling matches.

### Level 5: The enforced gate
- `npm run repo-health` → exit 0. THEN `npm run repo-health -- --require-db` (DB up) → exit 0, int layer
  ran with **0 skipped**. Confirm NO new migration file, no stray emitted JS/d.ts, no new npm dependency
  (`git diff package.json package-lock.json` shows no added deps).

---

## ACCEPTANCE CRITERIA

- [ ] `@420ai/shared/redaction.ts` exports `redact` + `RedactionFinding`/`RedactionResult` +
      `REDACTION_VERSION`; masks the documented key/token/credential/PII/home-path patterns + a
      high-entropy backstop; findings carry NO raw value; idempotent; exhaustively unit-tested.
- [ ] `@420ai/shared/analysis.ts` exports the bundle types + `buildAnalysisPrompt` (+ `AI_REPORT_VERSION`,
      `AnalysisReportType`); pure, deterministic, leaks no raw secret; `ReportType` extended with the two
      `*.ai_interpretation` members; all exported from the barrel.
- [ ] `@420ai/db` `sessionTranscript` decrypts a session's message transcript (events→raw join on
      `rawRecordId=sourceRecordId`+sessionId), ordered, deduped by `rawRecordId`, capped; first
      decrypt-for-render read; int-tested against a real ingested session. **No schema change, no
      migration.**
- [ ] Injected, configurable `AnalysisProvider` with an Anthropic client AND an OpenAI-compatible client
      (plain `fetch`, no SDK); request/response/usage extraction + non-200/timeout → `AnalysisProviderError`;
      unit-tested with a stubbed fetch; Anthropic shape reconciled with the `claude-api` skill.
- [ ] Orchestrator redacts the decrypted transcript BEFORE building the prompt, calling the provider, and
      storing — no unredacted/decrypted content is ever sent, logged, or stored (§18).
- [ ] Admin endpoints: `POST /v1/sessions/:sessionId/interpretations`, `POST /v1/projects/:id/
      interpretations` — 401 without admin; empty/unknown scope → 404 (provider NOT called); non-uuid/
      absent project → 404; unknown `type` → 400; provider failure → 502; not-configured → 503; success →
      201 with the stored artifact; regenerate bumps `version`. Fetch/list reuse M7's `GET /v1/reports*`.
- [ ] AI artifacts stored in `report_artifacts` with `reportType:"*.ai_interpretation"`, the AI Markdown
      in `markdown`, and `model`/`usage`/`redactionFindings`/`reportVersion(AI_REPORT_VERSION)` in
      `metrics`/`params` — reusing the M7 store with NO schema/migration change.
- [ ] **No fingerprint/wire/encryption/parse change, no collector change, no migration, no new npm
      dependency.**
- [ ] `npm run repo-health` passes; `npm run repo-health -- --require-db` passes with the int layer run,
      0 skipped (DB up); no stray artifacts/NUL bytes; manual validation produced a real, secret-free
      Markdown interpretation and the not-configured path returned 503.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately (paste exit codes).
- [ ] `claude-api` skill READ before implementing `anthropic.ts`; the request/response/headers/model-ids
      reconciled with it.
- [ ] Full suite passes (unit always; integration with `DATABASE_URL_TEST` — run WITH the DB up at least
      once via `repo-health -- --require-db`, 0 int tests skipped).
- [ ] Manual generation on real data returned a valid versioned Markdown interpretation (findings +
      Mermaid); the stored artifact + provider request were inspected and contain NO leaked secret/path;
      the not-configured path returned 503 and the rest of the API still worked.
- [ ] Deferred scope honored (only the two AI report types; no §21 search projection; no scheduling; no
      diff/compare; no failure classifier; no governance engine; no decryption in the project bundle).
- [ ] README Status updated; `repo-health` green; NO migration and NO new dependency in the diff.

---

## NOTES

**Why the bundle decrypts RAW records, not `events.payload` (spike 1):** message text is NOT in
`events.payload` (it's NULL for message events — the parsers attach payloads only to tool/file/context
events). The prompts/outputs live in the verbatim raw record (one per JSONL line), reachable via
`events.rawRecordId = raw_source_records.sourceRecordId`. Selecting `message.*` events and decrypting
their raw records yields the conversation while excluding the attachment/tool-result bulk that dominates a
session's bytes — no server-side connector re-parsing required.

**Why redaction operates on verbatim text, not structured fields:** the redaction engine is
connector-agnostic — it masks secrets/paths/PII in any text, so it works identically on Claude/Codex/
Gemini raw lines without re-implementing the collector parsers. The model reads semi-structured redacted
JSONL fine. This is the §18 "redaction applies before AI analysis" gate, implemented once.

**Why the provider is injected (not imported):** the live call is the one nondeterministic, billable,
network-bound mechanic. Injecting it via `buildApp` keeps it OFF the automated-test path entirely (all
int/unit tests use a deterministic stub) — the proven `db`/`adminToken` injection pattern. Only
`server.ts` and manual validation exercise the real client.

**Why no migration (contrast M7):** the AI findings are a `report_artifacts` row with a new `reportType`;
provider/model/redaction metadata fit the existing `metrics`/`params` jsonb. The M7 plan explicitly left
this seam ("a new artifact … without changing M7's table shape"). The risk M7 carried (did `db:generate`
emit only the intended CREATE) does not exist here — there is nothing to generate.

**What M9/M10 build on this:** the §21 **redacted search projection** reuses `redact()` to persist a
masked plaintext copy of events for Postgres FTS; **scheduled analysis** wraps the same orchestrator on a
timer; **export** (M10) can include the stored interpretations. M8 keeps artifacts replay-friendly
(`AI_REPORT_VERSION` + `model` + `REDACTION_VERSION` recorded) so a future re-interpretation with a
different model/ruleset is distinguishable.

**Confidence score: 9.4/10.** M8 composes proven layers (M6 projections, M7 `report_artifacts` store +
routes + version-bump, AES-GCM `decryptField` with a tested encrypt→decrypt round-trip, the `buildApp`
injection pattern, the int-test harness) and adds NO migration and NO dependency. The two genuinely new
mechanics were retired by spikes this session: the transcript join + one-record-per-line granularity were
**confirmed in connector source**, and the cap-budget was **grounded in a real 7 MB session profile**
(conversation ≈ 80 KB of 7 MB → select message events, not raw bytes). The redaction engine is a pure,
exhaustively-testable function; the provider is injected so the nondeterministic call never touches the
test path. The −0.6 is: (a) the live provider response/usage shape is specified-from-knowledge rather than
a live round-trip (user chose no test-path credential) — mitigated by the mandatory `claude-api`
cross-check, the stubbed-fetch unit tests, and the Level-4 manual gate; and (b) a regex+entropy redactor
can never guarantee 100% recall — mitigated by the entropy backstop, the explicit pattern table, the
findings/idempotence tests, and the single-user self-hosted trust boundary (the artifact stores the AI's
findings, not the raw content). Both residuals are contained and explicitly gated.
