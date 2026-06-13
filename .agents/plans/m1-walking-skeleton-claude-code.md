# Feature: Milestone 1 — Walking Skeleton (Claude Code → store → one Markdown report)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing. This is a **greenfield repo** —
there is no existing application code, so most "patterns to follow" are defined *by this plan* and
become the conventions every later feature mirrors. Build them deliberately.

Pay special attention to the **normalized token shape** and the **event fingerprint** — they are
the load-bearing contracts of the whole product (PRD §10.3, §12). Get their names and signatures
right; everything downstream imports them.

## Feature Description

Build the **thinnest possible end-to-end vertical slice** of the AI Coding Session Intelligence
Platform: read one real Claude Code session file from disk, parse it into a permanent **raw source
record** plus **normalized events**, store both, compute **cost from exact tokens × catalog
pricing**, and render **one Markdown report** for a session (tokens + computed cost + confidence).

Value only appears when the whole pipe exists (SUMMARY.md §2, "thinnest end-to-end pipe first"), so
this slice deliberately wires every stage — parse → store → cost → report — but keeps each stage
minimal. It establishes the shared-types contract, the storage shape, and the project conventions
that milestones 2–10 thicken.

## User Story

As an AI-heavy developer,
I want to point a CLI at one of my Claude Code session files and get a Markdown report of its token
usage and computed cost,
So that I can see — end to end — that my AI session data can be captured, archived, and turned into
a cost report, proving the platform's core loop works before any server, queue, or dashboard exists.

## Problem Statement

Claude Code records exact token usage and model per session in append-only JSONL
(`~/.claude/projects/<cwd-slug>/<uuid>.jsonl`), but **none of it is surfaced as cost or archived
durably** — the data lives only in vendor files that can be lost. There is currently no code in this
repo at all; nothing reads, normalizes, stores, or reports on that data.

## Solution Statement

A Node/TypeScript monorepo (npm workspaces) with two workspaces:

1. **`packages/shared`** — pure, dependency-free TypeScript defining the durable contracts: the
   normalized token shape, the normalized event types, the raw-record shape, the deterministic
   event fingerprint, the model pricing catalog, and the cost-confidence ladder.
2. **`apps/collector`** — depends on `shared`; contains the Claude Code JSONL parser, a `node:sqlite`
   store (relational tables with a JSON column — a local mirror of the eventual Postgres/JSONB
   archive, requiring **no Docker, no native deps**), a Markdown session-report generator, and a
   small CLI exposing `ingest <file>` and `report <sessionId>`.

Storage uses Node 24's built-in `node:sqlite` so the skeleton requires zero install beyond
TypeScript tooling, while keeping a relational + JSON-payload shape that maps cleanly onto the
future Supabase/Postgres schema (raw records sacred, events disposable — SUMMARY.md §5).

## Feature Metadata

**Feature Type**: New Capability (greenfield bootstrap)
**Estimated Complexity**: Medium
**Primary Systems Affected**: NEW — shared types package, collector app (parser + store + report + CLI)
**Dependencies**: Node 24 (`node:sqlite`, built-in), TypeScript ^6, tsx ^4, vitest ^4. No Docker, no native modules.

---

## PRE-FLIGHT VERIFICATION (completed during planning — these risks are RETIRED, not assumed)

These were run on this machine (Node v24.16.0, npm 11.13.0) before the plan was finalized. The
executor should not re-derive them, but the commands are reproducible if needed.

1. **`node:sqlite` does exactly what the store task requires — VERIFIED.** A smoke test created a
   table, ran `PRAGMA journal_mode=WAL`, performed an `INSERT ... ON CONFLICT(fingerprint) DO UPDATE`
   twice with the same key (row count stayed 2 → idempotent upsert works), round-tripped
   `JSON.stringify`/`JSON.parse` token+cost columns intact, bound `null` cleanly, and `close()`
   succeeded. **No `ExperimentalWarning` printed** on Node 24.16 — the earlier concern about warning
   friction does not occur here. → Risk "node:sqlite ergonomics" is closed.
2. **The greenfield toolchain composes — VERIFIED.** A throwaway monorepo with the EXACT
   `package.json` / `tsconfig.base.json` / `tsconfig.json` from this plan was scaffolded; `npm install`
   created the `@420ai/shared` workspace symlink; `tsc -b` compiled `shared` then the consumer app
   through project references under `module/moduleResolution: NodeNext` + `verbatimModuleSyntax`; the
   built app resolved `import { ping } from "@420ai/shared"` and ran. → Risk "toolchain integration"
   is closed. **Note:** global TypeScript is **6.0.3** (pin `"typescript": "^6"`); `tsx`/`vitest` are
   fetched by `npm install` as declared devDeps (first install needs network — already assumed).
3. **Pricing numbers are now real, not placeholders — VERIFIED via public 2026 rates** (see Task 6
   for the exact seed values + source). → Risk "placeholder pricing" is closed.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING!

There is **no source code yet**. Read these specification docs — they are the source of truth:

- `docs/PRD.md` (§10.1 connector table; §10.3 token normalization; §12 event taxonomy + fingerprint;
  §13 cost model + confidence ladder; §23 replay/upsert-by-fingerprint) — Why: defines the exact
  shapes and names this slice must implement.
- `docs/research/connector-capture-spike.md` (Claude Code section + "Cross-connector normalization
  note" table) — Why: documents the real Claude Code record types and the token-field → normalized
  mapping you will implement in the parser.
- `SUMMARY.md` (§2 build loop, §3 build order, §4 decisions log, §5 principles) — Why: the
  walking-skeleton scope, the fingerprint formula, and the "raw sacred / events disposable" rule.
- `docs/CONTEXT.md` (Raw Source Record, Normalized Event, Event Fingerprint, Cost Confidence,
  Event Taxonomy) — Why: canonical terminology; name code after these terms.
- `.gitignore` — Why: already ignores `*.sqlite`/`*.db`/`node_modules`/`dist` — the skeleton DB file
  must use a `.sqlite`/`.db` extension so it is not committed.

### Ground-Truth Data Shapes (VERIFIED on this machine — do not re-derive, but DO re-confirm)

Real records live at `~/.claude/projects/C--Users-seanr-OneDrive-Documents-420AI/<uuid>.jsonl`.
Verified record-type counts in one file:
`last-prompt, mode, permission-mode, bridge-session, attachment, file-history-snapshot, user,
ai-title, assistant, system`.

**`assistant` record** (carries tokens + model) top-level keys:
`cwd, entrypoint, gitBranch, isSidechain, message, parentUuid, requestId, sessionId, timestamp,
type, userType, uuid, version`.

`assistant.message` keys: `content, diagnostics, id, model, role, stop_details, stop_reason,
stop_sequence, type, usage`. `message.model` example: `"claude-opus-4-8"` (NOTE: **no date suffix**).
`message.content` is an **array of typed blocks** (`thinking` | `text` | `tool_use`).

**`assistant.message.usage`** (verified real shape):
```jsonc
{
  "input_tokens": 12660,
  "cache_creation_input_tokens": 2542,
  "cache_read_input_tokens": 25946,
  "output_tokens": 252,
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": { "ephemeral_1h_input_tokens": 2542, "ephemeral_5m_input_tokens": 0 },
  "iterations": [ /* per-iteration token breakdown */ ]
}
```

**`user` record** top-level keys: `cwd, entrypoint, gitBranch, isSidechain, message, parentUuid,
permissionMode, promptId, promptSource, sessionId, timestamp, type, userType, uuid, version`.
`user.message` keys: `content, role` (content may be a string OR an array of blocks incl.
`tool_result`).

### New Files to Create

```
package.json                                  # root, private, npm workspaces
tsconfig.base.json                            # shared strict TS config
.nvmrc                                         # "24"
README dev section appended (see Task 14)
packages/shared/
  package.json                                 # name "@420ai/shared", type module
  tsconfig.json
  src/index.ts                                 # barrel re-export
  src/tokens.ts                                # NormalizedTokens shape + zero/add helpers
  src/events.ts                                # EventType union + NormalizedEvent + RawSourceRecord
  src/fingerprint.ts                           # deterministic eventFingerprint()
  src/pricing.ts                               # pricing catalog + ModelPricing type
  src/cost.ts                                  # computeCost() + CostConfidence ladder
  src/tokens.test.ts
  src/fingerprint.test.ts
  src/cost.test.ts
apps/collector/
  package.json                                 # name "@420ai/collector", type module, bin
  tsconfig.json
  src/connectors/claude-code.ts                # parseClaudeCodeSession()
  src/connectors/claude-code.test.ts
  src/store/sqlite-store.ts                     # SqliteStore (node:sqlite)
  src/store/sqlite-store.test.ts
  src/report/session-report.ts                  # renderSessionReport()
  src/report/session-report.test.ts
  src/cli.ts                                    # `ingest` and `report` commands
  src/fixtures/sample-session.jsonl             # tiny hand-built fixture (3-4 lines)
vitest.config.ts                                # root, workspace-aware
```

### Relevant Documentation — read before implementing

- Node `node:sqlite` API — https://nodejs.org/docs/latest-v24.x/api/sqlite.html
  - Sections: `new DatabaseSync(path)`, `db.exec()`, `db.prepare()`, `stmt.run()`, `stmt.all()`.
  - Why: this is the storage engine; API is synchronous and slightly different from better-sqlite3.
  - GOTCHA: `node:sqlite` is **experimental** in Node 24 and prints a runtime
    `ExperimentalWarning` on import. That is expected; do not try to suppress it by changing the
    import. Tests must still pass with the warning present.
- Node `crypto.createHash` — https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatehashalgorithm-options
  - Why: the event fingerprint is `sha256` hex of a canonical string.
- Vitest config — https://vitest.dev/config/
  - Why: test runner; use `projects` (or a single root config with `include`) to cover both workspaces.
- npm workspaces — https://docs.npmjs.com/cli/v11/using-npm/workspaces
  - Why: monorepo wiring; `apps/collector` depends on `@420ai/shared` via `"workspace"`-style local link.

### Patterns to Follow (defined BY this plan — these become the repo conventions)

**Module system:** ESM everywhere. Every `package.json` sets `"type": "module"`. TS compiles to
`NodeNext`. Import local files with explicit `.js` extensions in source (NodeNext requirement),
e.g. `import { eventFingerprint } from "./fingerprint.js"`.

**Naming conventions:**
- Files: `kebab-case.ts` (`session-report.ts`, `sqlite-store.ts`).
- Types/interfaces: `PascalCase` (`NormalizedEvent`, `NormalizedTokens`, `RawSourceRecord`).
- Functions/vars: `camelCase` (`parseClaudeCodeSession`, `computeCost`, `eventFingerprint`).
- Event type string literals: dotted lowercase exactly per PRD §12 (`"message.assistant"`,
  `"usage.reported"`, `"cost.estimated"`, `"session.started"`, `"session.ended"`,
  `"tool.call.started"`, `"tool.call.completed"`).
- Connector source id constant: `"claude-code"` (used in fingerprints and on every record/event).

**Token normalization (PRD §10.3, spike table) — map Claude → normalized shape:**
| Normalized      | Claude `usage` field |
| --------------- | -------------------- |
| `input`         | `input_tokens`       |
| `output`        | `output_tokens`      |
| `cache_read`    | `cache_read_input_tokens` |
| `cache_write`   | `cache_creation_input_tokens` |
| `reasoning`     | 0 in V1 (Claude folds thinking into output_tokens; leave 0, document it) |
| `tool`          | 0 in V1 (server_tool_use is request *counts*, not tokens; leave 0, document it) |
| `total`         | computed = input + output + cache_read + cache_write |

**Fingerprint (PRD §12, SUMMARY §4):** exact formula —
`fingerprint = sha256_hex( source_connector + "|" + raw_record_id + "|" + event_index_within_record + "|" + event_type )`.
Deterministic: same raw input always yields the same fingerprint regardless of parser version.
Use a `|` delimiter so fields cannot collide. This single primitive powers dedup/idempotent ingest
and replay upsert.

**Error handling:** parser is **tolerant** — a malformed JSONL line is skipped and counted (return a
`skippedLines` count), never throws the whole parse. The CLI throws a clear `Error` with the bad
path/sessionId for user-facing failures (missing file, unknown session). No `console.log` inside
library code (`packages/shared`, parser, store, report) — only `cli.ts` writes to stdout/stderr.

**Storage shape (mirror of future Postgres):** two tables.
- `raw_source_records(id TEXT PK, source_connector TEXT, session_id TEXT, ingested_at TEXT, payload TEXT)`
  — `payload` is the **verbatim** original JSONL line/record (raw is sacred — never mutate).
- `events(fingerprint TEXT PK, source_connector TEXT, parser_version TEXT, raw_record_id TEXT,
  event_index INTEGER, event_type TEXT, session_id TEXT, project_path TEXT, git_branch TEXT,
  model TEXT, ts TEXT, tokens_json TEXT, cost_json TEXT, payload_json TEXT)`.
  Upsert by `fingerprint` (`INSERT ... ON CONFLICT(fingerprint) DO UPDATE`) → idempotent re-ingest
  (PRD §23). Keep token counts and cost as JSON columns for now (queryable columns come in later
  milestones); `model`, `ts`, `session_id` are promoted to real columns because the report needs them.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (`packages/shared`)
Define the durable contracts first — every other file imports them. Build token shape, event types,
raw-record type, fingerprint, pricing catalog, and cost ladder, each with unit tests.

### Phase 2: Core Implementation (`apps/collector`)
Parser (JSONL → raw records + normalized events), store (`node:sqlite` upsert-by-fingerprint),
report (events → Markdown), each independently tested against a fixture.

### Phase 3: Integration (CLI)
`cli.ts` wires parser → store → report into two commands: `ingest <file>` and `report <sessionId>`.

### Phase 4: Testing & Validation
Unit tests per module + one integration test that ingests the fixture and asserts the rendered
report. Re-ingest the same file twice and assert event count is unchanged (idempotency).

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently
testable. After each task, run its VALIDATE command before moving on.

### Task 1 — CREATE root workspace scaffold

- **IMPLEMENT**: Root `package.json` (`"private": true`, `"type": "module"`,
  `"workspaces": ["packages/*", "apps/*"]`, `"engines": { "node": ">=24" }`). Scripts:
  `"typecheck": "tsc -b"`, `"test": "vitest run"`, `"build": "tsc -b"`. Add `.nvmrc` containing `24`.
- **IMPLEMENT**: `tsconfig.base.json` with `"strict": true`, `"module": "NodeNext"`,
  `"moduleResolution": "NodeNext"`, `"target": "ES2023"`, `"declaration": true`, `"composite": true`,
  `"verbatimModuleSyntax": true`, `"skipLibCheck": true`, `"forceConsistentCasingInFileNames": true`.
- **IMPORTS**: dev deps at root: `typescript`, `tsx`, `vitest`, `@types/node` (Node 24 types).
- **GOTCHA**: Use `npm install` (pnpm is NOT installed on this machine — verified). `composite: true`
  is required for `tsc -b` project references.
- **VALIDATE**: `npm install && npx tsc --version` (expect TypeScript 6.x — verified 6.0.3 on this
  machine; pin `"typescript": "^6"`).

### Task 2 — CREATE `packages/shared` package + tsconfig

- **IMPLEMENT**: `packages/shared/package.json`: `"name": "@420ai/shared"`, `"version": "0.0.0"`,
  `"type": "module"`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`,
  script `"build": "tsc -b"`. `packages/shared/tsconfig.json` extends `../../tsconfig.base.json`,
  `"outDir": "dist"`, `"rootDir": "src"`, `"include": ["src/**/*"]`.
- **PATTERN**: ESM + NodeNext from "Patterns to Follow".
- **VALIDATE**: `npm run -w @420ai/shared build` (will succeed once src files exist; OK to defer to Task 7).

### Task 3 — CREATE `packages/shared/src/tokens.ts`

- **IMPLEMENT**: `export interface NormalizedTokens { input: number; output: number; cache_read:
  number; cache_write: number; reasoning: number; tool: number; total: number; }`. Plus
  `export const zeroTokens = (): NormalizedTokens => ({...all 0});` and
  `export const addTokens = (a, b) => ({...field-wise sum});` and a
  `export const computeTotal = (t) => t.input + t.output + t.cache_read + t.cache_write;` helper.
- **PATTERN**: This is the single normalized shape every connector targets (PRD §10.3).
- **GOTCHA**: `total` is **derived** (sum of input+output+cache_read+cache_write); do not include
  `reasoning`/`tool` in the total in V1 (they are 0 for Claude and would double-count later).
- **VALIDATE**: covered by `tokens.test.ts` in Task 11.

### Task 4 — CREATE `packages/shared/src/events.ts`

- **IMPLEMENT**:
  - `export type EventType = "session.started" | "session.ended" | "message.user" |
    "message.assistant" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" |
    "usage.reported" | "cost.estimated";` (subset of PRD §12 sufficient for this slice; full
    taxonomy lands in later milestones — list the omitted ones in a code comment).
  - `export interface RawSourceRecord { id: string; sourceConnector: string; sessionId: string;
    ingestedAt: string; payload: string; }` (`payload` = verbatim original JSONL text).
  - `export interface NormalizedEvent { fingerprint: string; sourceConnector: string;
    parserVersion: string; rawRecordId: string; eventIndex: number; eventType: EventType;
    sessionId: string; projectPath?: string; gitBranch?: string; model?: string; ts: string;
    tokens?: NormalizedTokens; cost?: CostResult; payload?: unknown; }` (import `NormalizedTokens`
    from `./tokens.js`, `CostResult` from `./cost.js`).
- **GOTCHA**: NodeNext requires `.js` extensions on relative type imports even for types.
- **VALIDATE**: `npm run -w @420ai/shared build` after Task 7.

### Task 5 — CREATE `packages/shared/src/fingerprint.ts`

- **IMPLEMENT**: `import { createHash } from "node:crypto";`
  `export function eventFingerprint(sourceConnector: string, rawRecordId: string,
  eventIndex: number, eventType: string): string {
    return createHash("sha256").update(
      [sourceConnector, rawRecordId, String(eventIndex), eventType].join("|")
    ).digest("hex"); }`
- **PATTERN**: EXACT formula from PRD §12 / SUMMARY §4 — do not reorder fields, do not change the
  `|` delimiter (changing either silently breaks dedup/replay across versions).
- **VALIDATE**: `fingerprint.test.ts` (Task 11) asserts a known input → stable hex digest and that
  changing any one field changes the output.

### Task 6 — CREATE `packages/shared/src/pricing.ts`

- **IMPLEMENT**: `export interface ModelPricing { input: number; output: number; cache_read: number;
  cache_write: number; sourceUrl: string; asOf: string; }` (USD per **single token**).
  `export const PRICING_CATALOG: Record<string, ModelPricing> = { ... }` seeded with the models the
  spike observed, keyed by the **exact** id Claude writes. Seed at least:
  `"claude-opus-4-8"`, `"claude-sonnet-4-6"`, `"claude-haiku-4-5-20251001"`. Use these **verified
  2026 public rates** (USD per **single token** = per-MTok ÷ 1e6). `cache_read` = 0.1× input;
  `cache_write` seeds to the 5-minute ephemeral rate = 1.25× input (the real record also carries a
  1-hour tier at 2× input — V1 collapses both into `cache_write`; see NOTES). Set every entry's
  `sourceUrl: "https://www.anthropic.com/pricing"` and `asOf: "2026-06-13"`:

  | model | input | output | cache_read (0.1×) | cache_write (1.25×) |
  | --- | --- | --- | --- | --- |
  | `claude-opus-4-8`           | 5e-6 | 25e-6 | 0.5e-6  | 6.25e-6 |
  | `claude-sonnet-4-6`         | 3e-6 | 15e-6 | 0.3e-6  | 3.75e-6 |
  | `claude-haiku-4-5-20251001` | 1e-6 | 5e-6  | 0.1e-6  | 1.25e-6 |

  Export `export function getPricing(model: string): ModelPricing | undefined`. (Source: Anthropic
  API pricing, June 2026 — Opus 4.8 $5/$25 per MTok, cache hits at 0.1× input.)
- **GOTCHA**: rates are **per token**, not per million — a flat input/output split mis-costs every
  session (PRD §13.1). Keep cache_read and cache_write distinct (cache_read is far cheaper).
- **VALIDATE**: `cost.test.ts` exercises this via `computeCost`.

### Task 7 — CREATE `packages/shared/src/cost.ts` + `src/index.ts` barrel

- **IMPLEMENT**:
  - `export type CostConfidence = "exact" | "estimated-model-known" | "estimated-model-unknown" |
    "subscription-amortized" | "unknown";` (PRD §13.3 ladder).
  - `export interface CostResult { usd: number; confidence: CostConfidence; model?: string;
    pricingAsOf?: string; }`
  - `export function computeCost(model: string | undefined, tokens: NormalizedTokens): CostResult` —
    if `model` and `getPricing(model)` exist → multiply each token sub-type by its rate, sum to
    `usd`, confidence `"estimated-model-known"`; if model present but not in catalog → `usd: 0`,
    `"estimated-model-unknown"`; if no model → `usd: 0`, `"unknown"`. (No tool reports cost in V1, so
    `"exact"` is unreachable here — leave it in the type for later, note it.)
  - `src/index.ts` barrel re-exports everything from `tokens`, `events`, `fingerprint`, `pricing`,
    `cost` (all with `.js` extensions).
- **PATTERN**: Cost confidence ladder (PRD §13.3); spike confirms the normal path is
  `estimated-model-known`.
- **VALIDATE**: `npm run -w @420ai/shared build && npm run -w @420ai/shared test` (after Task 11).

### Task 8 — CREATE `apps/collector` package + tsconfig

- **IMPLEMENT**: `apps/collector/package.json`: `"name": "@420ai/collector"`, `"type": "module"`,
  `"dependencies": { "@420ai/shared": "*" }`, `"bin": { "collector": "./dist/cli.js" }`,
  scripts `"build": "tsc -b"`, `"start": "tsx src/cli.ts"`. `tsconfig.json` extends base, adds
  `"references": [{ "path": "../../packages/shared" }]`, `outDir dist`, `rootDir src`.
- **GOTCHA**: After editing root `package.json` workspaces or adding this dep, re-run `npm install`
  so the `@420ai/shared` symlink is created in `node_modules`.
- **VALIDATE**: `npm install && npm run -w @420ai/collector build` (succeeds once src exists).

### Task 9 — CREATE `apps/collector/src/fixtures/sample-session.jsonl`

- **IMPLEMENT**: A tiny **hand-authored** fixture (3–4 JSONL lines) mirroring the verified real
  shape: one `user` record, one `assistant` record with a realistic `message.usage` block and
  `message.model: "claude-opus-4-8"`, `cwd`, `gitBranch`, `sessionId`, `timestamp`, `uuid`; and one
  deliberately-malformed line (e.g. `{ broken json`) to exercise tolerant parsing. Keep token
  numbers small and round for easy assertion.
- **GOTCHA**: Do NOT copy a real user session (privacy + size). Author minimal synthetic data. Keep
  `sessionId` identical across the valid lines.
- **VALIDATE**: file is valid input for Task 10's test.

### Task 10 — CREATE `apps/collector/src/connectors/claude-code.ts`

- **IMPLEMENT**: `export const CLAUDE_CODE_CONNECTOR = "claude-code";`
  `export const PARSER_VERSION = "1.0.0";`
  `export interface ParseResult { rawRecords: RawSourceRecord[]; events: NormalizedEvent[];
  skippedLines: number; sessionId?: string; }`
  `export function parseClaudeCodeSession(fileText: string, opts?: { ingestedAt?: string }):
  ParseResult`:
  - Split on newlines; for each non-empty line, `try { JSON.parse }`; on failure increment
    `skippedLines` and continue (tolerant — see error-handling pattern).
  - For each parsed record, create ONE `RawSourceRecord` (`id` = the record's `uuid` if present else
    `${sessionId}:${lineIndex}`; `payload` = the verbatim line text; `sourceConnector` =
    `CLAUDE_CODE_CONNECTOR`).
  - Emit normalized events **per record** with a stable `eventIndex` (0-based within the record) and
    `fingerprint = eventFingerprint(CLAUDE_CODE_CONNECTOR, rawRecord.id, eventIndex, eventType)`:
    - `type === "user"` → `message.user` (index 0).
    - `type === "assistant"` → `message.assistant` (index 0); if `message.usage` present, also emit
      `usage.reported` (index 1) with `tokens` mapped via the token table above and
      `total = computeTotal(...)`; then `cost.estimated` (index 2) with
      `cost = computeCost(message.model, tokens)` and `model`/`ts`/`tokens` populated.
    - Walk `message.content[]`: each `tool_use` block → `tool.call.started` (index 3+i). (Keep tool
      events minimal — no completion correlation in this slice; note it.)
    - First record overall → also emit `session.started` (use earliest `timestamp`); after the loop,
      emit one `session.ended` using the latest `timestamp`. (Use a separate synthetic
      `rawRecordId` like `${sessionId}:session` with eventIndex 0/0 and distinct event_type so
      fingerprints differ.)
  - Populate `projectPath` from `cwd`, `gitBranch` from `gitBranch`, `model` from `message.model`,
    `ts` from `timestamp` on every event where available.
- **IMPORTS**: `import { eventFingerprint, computeCost, computeTotal, zeroTokens, type
  NormalizedEvent, type RawSourceRecord, type NormalizedTokens } from "@420ai/shared";`
- **GOTCHA**: `message.content` may be a string (older user records) OR an array — guard with
  `Array.isArray`. `usage` may be absent on some assistant records — guard before mapping. Never
  throw on a single bad record.
- **VALIDATE**: `claude-code.test.ts` (Task 11): parse fixture → assert `skippedLines === 1`, exactly
  one `usage.reported` event, its `tokens.total` equals the expected sum, the `cost.estimated`
  event has confidence `"estimated-model-known"` and `usd > 0`, and parsing the SAME text twice
  yields **identical fingerprints**.

### Task 11 — CREATE unit tests for shared + parser

- **IMPLEMENT**: `tokens.test.ts` (addTokens/computeTotal), `fingerprint.test.ts` (stable digest +
  field-sensitivity), `cost.test.ts` (known model → known-confidence non-zero; unknown model →
  `estimated-model-unknown` + 0; no model → `unknown`), `claude-code.test.ts` (per Task 10 VALIDATE).
- **PATTERN**: vitest `describe/it/expect`; read the fixture with
  `readFileSync(new URL("./fixtures/sample-session.jsonl", import.meta.url), "utf8")`.
- **VALIDATE**: `npx vitest run` (all green).

### Task 12 — CREATE `apps/collector/src/store/sqlite-store.ts`

- **IMPLEMENT**: `import { DatabaseSync } from "node:sqlite";`
  `export class SqliteStore { constructor(dbPath: string) ` — open DB, `PRAGMA journal_mode=WAL`,
  `exec` the two `CREATE TABLE IF NOT EXISTS` statements (schema from "Storage shape" pattern).
  Methods:
  - `insertRawRecords(records: RawSourceRecord[]): void` — `INSERT OR IGNORE` by `id`.
  - `upsertEvents(events: NormalizedEvent[]): void` — `INSERT INTO events (...) VALUES (...)
    ON CONFLICT(fingerprint) DO UPDATE SET parser_version=excluded.parser_version,
    tokens_json=excluded.tokens_json, cost_json=excluded.cost_json,
    payload_json=excluded.payload_json` (idempotent re-parse, PRD §23). Serialize `tokens`/`cost`/
    `payload` with `JSON.stringify`.
  - `getSessionEvents(sessionId: string): NormalizedEvent[]` — select by `session_id`, ordered by
    `ts`, `JSON.parse` the JSON columns back into typed objects.
  - `listSessions(): { sessionId: string; model: string | null; eventCount: number }[]` — for CLI help.
  - `close(): void`.
- **IMPORTS**: `@420ai/shared` types; `node:sqlite`.
- **GOTCHA**: `node:sqlite` is synchronous (`stmt.run(...)`, `stmt.all(...)`). It is experimental →
  an `ExperimentalWarning` prints on import; that is expected, do not suppress via flags in a way
  that breaks tests. Use parameterized statements (`?` placeholders) — never string-concatenate
  values. Bind `undefined` as `null`.
- **VALIDATE**: `sqlite-store.test.ts` (Task 13).

### Task 13 — CREATE `sqlite-store.test.ts` (idempotency is the key assertion)

- **IMPLEMENT**: Use an in-file temp DB path under the OS temp dir (e.g.
  `join(tmpdir(), `m1-test-${process.pid}.sqlite`)`), delete it in `afterEach`. Parse the fixture,
  `insertRawRecords` + `upsertEvents`, assert `getSessionEvents` returns the expected event count.
  Then ingest the SAME parse result **again** and assert the event count is **unchanged** (upsert by
  fingerprint = idempotent). Assert a round-tripped event's `tokens.total` and `cost.usd` survive
  JSON serialize/parse.
- **VALIDATE**: `npx vitest run sqlite-store`.

### Task 14 — CREATE `apps/collector/src/report/session-report.ts`

- **IMPLEMENT**: `export function renderSessionReport(events: NormalizedEvent[]): string` returning
  Markdown. Aggregate across the session: sum `NormalizedTokens` from all `usage.reported` events
  (use `addTokens`); sum `cost.usd` from all `cost.estimated` events; collect distinct models;
  count `message.user` / `message.assistant` / `tool.call.*` events; read `projectPath`/`gitBranch`
  from any event. Output sections:
  - `# Session Report — <sessionId>`
  - metadata line(s): project path, git branch, model(s), event count, time range (min/max `ts`).
  - a **Markdown table** of token sub-types (input / output / cache_read / cache_write / total).
  - **Total estimated cost** with the cost-confidence label (lowest-confidence wins if mixed).
  - a small **Mermaid** `pie`/`bar` of token composition (PRD §15 wants Mermaid; keep it simple).
- **GOTCHA**: pure function, returns a string — NO file writes here (the CLI decides where to write).
  Format USD with 6 decimals (sessions are cheap; 2 decimals reads as `$0.00`).
- **VALIDATE**: `session-report.test.ts`: render from fixture-derived events → assert the string
  contains the sessionId, the token total, a `| input |` table header, and the confidence label.

### Task 15 — CREATE `apps/collector/src/cli.ts` (integration glue)

- **IMPLEMENT**: A minimal arg parser (no dependency — read `process.argv.slice(2)`):
  - `collector ingest <file> [--db <path>]` → read file (`readFileSync`), `parseClaudeCodeSession`,
    open `SqliteStore` (default db `./420ai.sqlite`), `insertRawRecords` + `upsertEvents`, print a
    summary to stdout: records, events, skippedLines, sessionId. Non-zero exit on missing file.
  - `collector report <sessionId> [--db <path>] [--out <file>]` → open store, `getSessionEvents`,
    if empty throw `Error("No events for session <id>")`, else `renderSessionReport`, write to
    `--out` if given else print to stdout.
  - `collector` with no/unknown command → print usage including `listSessions()` if a db exists.
- **PATTERN**: ONLY file allowed to `console.log`/`process.exit`/write files. Wrap `main()` in
  `try/catch`, print `error.message` to stderr, `process.exit(1)`.
- **GOTCHA**: default DB filename must end in `.sqlite` so `.gitignore` excludes it. Use
  `import.meta` / top-level `await main()` guarded by `if (process.argv[1])`.
- **VALIDATE**: see Task 16.

### Task 16 — CREATE end-to-end integration test + manual run

- **IMPLEMENT**: `cli` integration coverage via a vitest test that calls the exported `runIngest`
  / `runReport` functions (refactor `cli.ts` to export these so they are testable without spawning a
  process) against a temp DB and the fixture, asserting the report string contains expected cost and
  tokens, and that running `runIngest` twice does not change `getSessionEvents().length`.
- **VALIDATE (manual, against REAL data)**:
  `npx tsx apps/collector/src/cli.ts ingest "$HOME/.claude/projects/C--Users-seanr-OneDrive-Documents-420AI/21135092-dcd8-40cf-b8e5-187964110f20.jsonl" --db ./420ai.sqlite`
  then `npx tsx apps/collector/src/cli.ts report 21135092-dcd8-40cf-b8e5-187964110f20 --db ./420ai.sqlite`
  → expect a Markdown report with non-zero opus token totals and an `estimated-model-known` cost.

### Task 17 — UPDATE root README with a "Development (Milestone 1)" section

- **IMPLEMENT**: Append a short dev section: prerequisites (Node ≥24), `npm install`,
  `npm run typecheck`, `npm test`, and the two example CLI commands above. Note that the SQLite file
  is gitignored and that `node:sqlite` prints an experimental warning by design.
- **VALIDATE**: `npm run typecheck && npm test` both pass from a clean `npm install`.

---

## TESTING STRATEGY

### Unit Tests
- `shared`: token math, fingerprint determinism + sensitivity, cost ladder branches (known/unknown/
  no-model).
- `connector-claude-code`: tolerant parsing (skips malformed line), correct event emission +
  token mapping, fingerprint stability across re-parse.
- `store`: idempotent upsert (re-ingest → same count), JSON round-trip fidelity.
- `report`: required sections/values present in the Markdown string.

### Integration Tests
- Parse fixture → store → report, asserting end-to-end values.
- Idempotency across the whole pipe (ingest fixture twice → event count stable).

### Edge Cases (must be covered)
- Malformed JSONL line → skipped + counted, parse still succeeds.
- Assistant record with **no** `usage` → no `usage.reported`/`cost.estimated` emitted, no throw.
- `message.content` as a string vs array → both handled.
- Model **not** in pricing catalog → `estimated-model-unknown`, `usd: 0`, no throw.
- Re-ingesting the same file → zero new events (fingerprint upsert).
- Empty file / file with only blank lines → empty `ParseResult`, CLI reports 0 cleanly.

---

## VALIDATION COMMANDS

### Level 1: Syntax & Style / Types
- `npm run typecheck`  (alias for `tsc -b`, must be 0 errors)

### Level 2: Unit Tests
- `npx vitest run`  (all suites green)

### Level 3: Integration Tests
- `npx vitest run cli`  and  `npx vitest run sqlite-store`

### Level 4: Manual Validation (real data)
- `npx tsx apps/collector/src/cli.ts ingest "$HOME/.claude/projects/C--Users-seanr-OneDrive-Documents-420AI/21135092-dcd8-40cf-b8e5-187964110f20.jsonl"`
- `npx tsx apps/collector/src/cli.ts report 21135092-dcd8-40cf-b8e5-187964110f20`
- Confirm the Markdown shows opus token sub-types, a non-zero total cost, and confidence
  `estimated-model-known`.

### Level 5: Additional
- Run the ingest command **twice**; confirm the second run reports 0 newly-added events (or stable
  total) — proves idempotency on real data.

---

## ACCEPTANCE CRITERIA

- [ ] `npm install` from a clean checkout sets up both workspaces with no native build step.
- [ ] `npm run typecheck` passes with zero errors (strict mode).
- [ ] `npx vitest run` passes all unit + integration suites.
- [ ] `parseClaudeCodeSession` tolerantly skips malformed lines and emits correct normalized events
      with mapped token sub-types.
- [ ] `eventFingerprint` matches the PRD §12 formula exactly and is deterministic across re-parse.
- [ ] Cost is computed from tokens × catalog pricing with the correct confidence label.
- [ ] `SqliteStore` upserts events by fingerprint → re-ingest is idempotent (verified by test AND on
      real data).
- [ ] `collector report <sessionId>` renders a Markdown report (token table + Mermaid + total cost +
      confidence) for a REAL Claude Code session on this machine.
- [ ] No `console.log` outside `cli.ts`; raw payloads stored verbatim (raw-records-sacred).
- [ ] README has a working "Development (Milestone 1)" section.

## COMPLETION CHECKLIST

- [ ] All 17 tasks completed in order, each VALIDATE passing immediately.
- [ ] Full test suite passes (unit + integration).
- [ ] No type or lint errors.
- [ ] Manual run against real Claude Code data produces a correct cost report.
- [ ] `*.sqlite` DB is NOT committed (already gitignored — confirm `git status` is clean of it).
- [ ] Acceptance criteria all met.

## NOTES

**Design decisions / trade-offs:**
- **`node:sqlite` over better-sqlite3:** built into Node 24, zero native install, synchronous API,
  relational + JSON-column shape that mirrors the future Supabase/Postgres archive. Risk: it's
  experimental (prints a warning) and its API could shift — acceptable for a skeleton; the store is
  a thin, replaceable adapter. If a reviewer objects to experimental APIs, `better-sqlite3` is a
  drop-in fallback (same SQL), at the cost of a native build.
- **Two workspaces, not five:** `shared` (the durable contract) is isolated so every future connector
  imports the same token shape + fingerprint; parser/store/report live together in `collector` for
  now and can be split into packages when a second connector (Codex) arrives in milestone 4.
- **`reasoning`/`tool` tokens are 0 for Claude in V1:** Claude folds thinking into `output_tokens`
  and `server_tool_use` reports request *counts*, not tokens. Left as 0 and documented so the
  normalized shape stays honest; Codex/Gemini will populate `reasoning`.
- **Two cache-write tiers collapsed:** the real record splits `ephemeral_1h` vs `ephemeral_5m` cache
  creation at different prices. V1 sums them into `cache_write`; the raw record preserves the split
  so a later parser_version can price them separately (replay, PRD §23). This is the
  raw-records-sacred principle paying off on day one.
- **Pricing numbers are real (verified June 2026), not placeholders:** seeded from public Anthropic
  rates (Opus 4.8 $5/$25 per MTok, cache-read 0.1× input, cache-write 1.25× for the 5-min tier) with
  `sourceUrl` + `asOf` — see Task 6. The catalog is still designed to be updated independently (PRD
  §13.2), and the **cost-confidence label already encodes pricing drift**, so even when rates age the
  *implementation* stays correct — only the dollar figure's freshness changes, which is the
  catalog's job, not this slice's.
- **Tool-call completion not correlated in this slice:** `tool.call.started` is emitted from
  `tool_use` blocks but not matched to its `tool_result`; full tool-call lifecycle + failure
  classification (PRD §14) is a later milestone.

**Confidence Score: 9.5/10** for one-pass success (raised from 8.5 after pre-flight verification).
All three originally-named risks are retired with execution evidence (see PRE-FLIGHT VERIFICATION):
`node:sqlite` upsert/JSON/null/close proven on this machine, the exact toolchain configs compiled and
ran in a throwaway monorepo, and pricing is seeded with real verified rates. Data shapes are verified
against real session files; there are no external services to stand up.

**Why not a literal 10/10 — and why that's the honest answer.** A 10 would claim certainty that
greenfield code runs perfectly the first time, which no plan can guarantee before execution: the
irreducible residual is ordinary first-write risk — a typo, an unmapped record-type quirk in some
real session, a Mermaid/string-format detail — all caught by the unit tests and the real-data manual
run in Tasks 11–17, but not provable *in advance*. The truthful way to reach 10/10 is to **execute
the plan**; the verification done here has already eliminated every risk that could be retired
without writing the product code. Inflating the number instead would just hide that last half-point,
not remove it.
