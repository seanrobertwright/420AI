# Feature: Milestone 4 — Connectors to Full Fidelity (Claude Code + Codex CLI + Gemini CLI)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types, and models. Import from the right files
(`@420ai/shared`, `.js` relative specifiers, `import type` for types). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **PRE-FLIGHT recon is already done and baked into this plan.** The token arithmetic, record shapes,
> and registry mechanics below were verified against REAL on-disk files on this machine during
> planning (Codex `gpt-5.5` rollout, Gemini `gemini-3-flash-preview` session). Each grounded fact is
> marked **[VERIFIED]** with the assertion that proved it. If a fixture you build contradicts a
> **[VERIFIED]** assertion, the fixture is wrong — fix the fixture, not the assertion.

---

## Feature Description

Milestone 4 takes the collector's connector layer from a single partial-fidelity Claude Code
connector to **three required connectors at full fidelity**, all feeding the existing M2 Ingest API
through the existing M3 durable-queue/sync framework. Three workstreams:

1. **Thicken the existing Claude Code connector** to full fidelity: correlate the tool-call lifecycle
   (`tool.call.completed` / `tool.call.failed`), emit file events (`file.read` / `file.modified` /
   `file.referenced`), and emit `context.loaded`.
2. **Add the OpenAI Codex CLI connector** — append-only JSONL, streaming (tail), same `Connector`
   contract as Claude.
3. **Add the Gemini CLI connector** — a single JSON file **rewritten** per turn, which does NOT fit
   the append-only byte-offset tailer. This requires a **minimal, additive watcher-framework
   extension** (a `snapshot` capture mode) that coexists with the proven `tail` path without
   weakening the durable-queue dedup or fingerprint guarantees.

## User Story

As a developer running multiple AI coding tools (Claude Code, Codex CLI, Gemini CLI) on one machine,
I want every session from all three tools captured at full fidelity — exact tokens, per-tool-call
outcomes, file touches, and context loads — into my self-hosted archive,
So that downstream reports (M6/M7) can attribute cost, context waste, and tool-failure metrics
accurately across every tool I use, not just Claude Code.

## Problem Statement

Today only Claude Code is captured, and only partially: `tool.call.started` fires but is never
correlated to a completion or failure, no file-interaction events exist, and no context-load events
exist. Codex CLI and Gemini CLI — both verified high-fidelity, exact-token sources — are not captured
at all. The Gemini store is a whole-file-rewrite JSON, which the current append-only tailer cannot
read correctly. Without these, M6 projections and M7 reports would cover one tool with gaps.

## Solution Statement

Extend the shared event taxonomy with the four missing event types (client-only — the server stores
`event_type` as free `text` and validates it as `{type:"string"}`, so **no server change or migration
is required**). Thicken the Claude parser to a two-pass tool-lifecycle + file + context derivation and
bump its `PARSER_VERSION`. Add a Codex parser (per-turn `last_token_usage` deltas, model carried
forward from `turn_context`) and a Gemini parser (whole-file JSON, thoughts folded into `output`).
Add a `captureMode: "tail" | "snapshot"` discriminant to the `Connector` contract and a pure
`readSnapshot` helper so the `FileWatcher` reads whole-file-rewrite sources by content change without
touching the byte-offset tail path. The durable-queue content-hash dedup and the machine-independent
event fingerprint make whole-file re-parse idempotent at both the local and server layers.

## Feature Metadata

**Feature Type**: Enhancement (Claude) + New Capability (Codex, Gemini, snapshot watcher)
**Estimated Complexity**: High (three parsers + a framework extension + token-arithmetic correctness)
**Primary Systems Affected**: `packages/shared` (event taxonomy, pricing), `apps/collector`
(connectors, watcher, tailer, report)
**Dependencies**: None new. Node ≥ 24 built-ins only (`node:sqlite`, `node:fs`). No new npm packages.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/collector/src/connectors/claude-code.ts` — Why: the connector being thickened; the
  two-pass tolerant parser + `makeEvent` fingerprint helper + `Connector` object to mirror for
  Codex/Gemini. Note current `knownGaps` literally tag "tool.call completion not yet correlated (M4)".
- `apps/collector/src/connectors/connector.ts` — Why: the `Connector` interface + `ConnectorFidelity`
  (PRD §10.3) + the `connectors[]` registry you append to. `captureMode` gets added here.
- `apps/collector/src/connectors/claude-code.test.ts` — Why: the exact test style to mirror (fixture
  read via `import.meta.url`, fingerprint-stability test, token `toEqual` with all 7 sub-fields).
- `apps/collector/src/fixtures/sample-session.jsonl` — Why: the Claude fixture shape; extend it (or
  add a sibling) with `tool_use` + `tool_result` + file-tool + context records.
- `packages/shared/src/events.ts` — Why: the `EventType` union to extend; `NormalizedEvent` shape.
  The union ALREADY contains `tool.call.completed`/`tool.call.failed` — you only ADD `file.read`,
  `file.modified`, `file.referenced`, `context.loaded`.
- `packages/shared/src/tokens.ts` — Why: `NormalizedTokens`, `zeroTokens`, `computeTotal`. **Read the
  `computeTotal` comment** — it deliberately excludes `reasoning`/`tool` because they are subsets of
  `output`. This invariant is load-bearing for the token mapping below; do NOT change the formula.
- `packages/shared/src/cost.ts` — Why: `computeCost` prices input/output/cache_read/cache_write only.
  This is correct as-is for all three connectors (reasoning is inside output) — do NOT add reasoning
  pricing.
- `packages/shared/src/pricing.ts` — Why: `PRICING_CATALOG` keyed by EXACT model id; add Codex/Gemini
  model entries. `getPricing` returns `undefined` → graceful `estimated-model-unknown` fallback.
- `apps/collector/src/watcher/tailer.ts` — Why: the PURE byte-offset tailer (`readGrownPrefix`). Read
  its doc comment on whole-file-prefix semantics — `readSnapshot` is its snapshot-mode sibling.
- `apps/collector/src/watcher/file-watcher.ts` — Why: `tickOnce` is where the `captureMode` branch
  goes; it currently calls `readGrownPrefix` + `saveCursor`. The "cursor is the commit point after
  onChange" ordering MUST be preserved for both modes.
- `apps/collector/src/queue/queue-store.ts` — Why: `enqueue` content-hash dedup (the idempotency
  backstop that makes whole-file re-parse safe); `getCursor`/`saveCursor` (`{byteOffset, size}`) you
  repurpose for snapshot change-detection. Read the `enqueue` `WHERE content_hash <> excluded` no-op.
- `apps/collector/src/capture-engine.ts` — Why: the `onChange` closure that enqueues
  `parsed.rawRecords` + `parsed.events`; it is connector-agnostic and needs NO change.
- `apps/collector/src/report/session-report.ts` — Why: consumes events; counts `tool.call.*` via
  `startsWith`. New event types won't break it; optional light additions noted in tasks.
- `apps/ingest/src/schemas.ts` (lines 48-77) — Why: PROOF that `eventType` is `{type:"string"}` (not
  an enum) → extending the taxonomy needs no server change. Read-only confirmation; do not edit.
- `packages/db/src/schema.ts` (lines 96-123) — Why: PROOF `event_type` is `text(...)` with no enum/
  CHECK → no migration. Read-only confirmation; do not edit.
- `docs/research/connector-capture-spike.md` — Why: the original recon. **NOTE: the Codex section is
  now STALE** — the on-disk format evolved to a two-level envelope (see [VERIFIED] facts below). Trust
  this plan's verified facts over the spike for Codex record shape.

### New Files to Create

- `apps/collector/src/connectors/codex-cli.ts` — Codex CLI connector + parser.
- `apps/collector/src/connectors/codex-cli.test.ts` — Codex parser unit tests.
- `apps/collector/src/connectors/gemini-cli.ts` — Gemini CLI connector + parser.
- `apps/collector/src/connectors/gemini-cli.test.ts` — Gemini parser unit tests.
- `apps/collector/src/watcher/snapshot.ts` — pure `readSnapshot` helper (tailer sibling).
- `apps/collector/src/watcher/snapshot.test.ts` — snapshot read/change-detect unit tests.
- `apps/collector/src/fixtures/sample-codex-rollout.jsonl` — small synthetic Codex fixture grounded
  in the [VERIFIED] shapes.
- `apps/collector/src/fixtures/sample-gemini-session.json` — small synthetic Gemini fixture.
- `apps/collector/src/fixtures/sample-session-tools.jsonl` — Claude fixture with tool_use/tool_result/
  file-tool/context records (or extend the existing fixture — see task).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/PRD.md` §10 (Connector Strategy), §10.1 (store locations), §10.1.1 (liveness levels), §10.3
  (fidelity fields + **token normalization** — the common sub-type shape), §12 (fingerprint), §13
  (pricing/cost ladder), §23 (replay/idempotency). Why: the contract every connector must satisfy.
- `.agents/plans/m3-collector-foundation.md` — Why: the framework being extended (queue, cursors,
  tailer, watcher, sync) and its design decisions; mirror its test/PRE-FLIGHT discipline.

### Patterns to Follow

**Connector object shape** (mirror `claudeCodeConnector`, `claude-code.ts:219-235`):

```ts
export const codexCliConnector: Connector = {
  id: CODEX_CLI_CONNECTOR,            // "codex-cli"
  captureMode: "tail",               // NEW field; Claude/Codex = "tail", Gemini = "snapshot"
  fidelity: { status: "stable", captureMethod: "tail-jsonl", liveness: "streaming",
              tokens: "exact", cost: "computed", knownGaps: [...], testedVersions: ["0.137.x"] },
  watchGlobs: (home) => [join(home, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl")],
  parse: (text) => parseCodexSession(text),
};
```

**Fingerprint helper** (mirror `makeEvent`, `claude-code.ts:121-140`): every event's fingerprint is
`eventFingerprint(CONNECTOR_ID, rawRecordId, eventIndex, eventType)`. **Stable `rawRecordId` is
critical** — for line-based sources with no per-record uuid, use `` `${sessionId}:${lineIndex}` ``
(Claude already does this fallback at `claude-code.ts:107`). For Gemini messages use
`` `${sessionId}:msg:${messageIndex}` `` so the fingerprint is stable across whole-file rewrites.

**Tolerant parsing** (mirror `claude-code.ts:96-116`): a malformed line is skipped and counted in
`skippedLines`, never thrown. Raw records are pushed verbatim (`payload: line`) BEFORE any
normalization — raw is sacred.

**Library files never log or `process.exit`** (CLAUDE.md). Parsers are pure; the watcher takes no
logger. Only `cli.ts` logs.

**Test style** (mirror `claude-code.test.ts`): fixture via `new URL("../fixtures/x", import.meta.url)`;
assert token mapping with full 7-field `toEqual`; include a fingerprint-stability test (parse twice
with different `ingestedAt`, expect identical fingerprints).

> **Spike-snippet fidelity:** the token mappings below are pinned to **[VERIFIED]** arithmetic from
> real files. Keep the assertion next to the mapping in your fixture tests so drift is detectable.

---

## KEY DESIGN DECISIONS (read before coding — these resolve the hard parts)

### D1 — Token normalization: `output` always includes reasoning; `reasoning`/`tool` are informational subsets

`computeTotal` = `input + output + cache_read + cache_write` and **deliberately excludes
`reasoning`/`tool`** (`tokens.ts:42-48`). Honor this for all three connectors by ensuring every
vendor token that contributes to the vendor's reported total lands in `input`/`output`/`cache_read`/
`cache_write`, with `reasoning`/`tool` populated only as informational breakouts (subsets of
`output`). Result: `computeTotal` reproduces the vendor total exactly and `computeCost` needs **no
change**.

Per-connector mapping (all **[VERIFIED]** against real files):

| normalized   | Claude (existing)            | Codex `last_token_usage`                         | Gemini per-msg `tokens`            |
|--------------|------------------------------|--------------------------------------------------|------------------------------------|
| `input`      | `input_tokens`               | `input_tokens − cached_input_tokens`             | `input − cached`                   |
| `cache_read` | `cache_read_input_tokens`    | `cached_input_tokens`                            | `cached`                           |
| `cache_write`| `cache_creation_input_tokens`| `0`                                              | `0`                                |
| `output`     | `output_tokens`              | `output_tokens` (already incl. reasoning)        | `output + thoughts + tool`         |
| `reasoning`  | `0`                          | `reasoning_output_tokens` (⊂ output, info)       | `thoughts` (⊂ output, info)        |
| `tool`       | `0`                          | `0`                                              | `tool` (⊂ output, info)            |
| `total`      | `computeTotal(...)`          | `computeTotal(...)` → `= total_tokens` ✓         | `computeTotal(...)` → `= total` ✓  |

- **[VERIFIED — Codex]** `total_tokens = input_tokens + output_tokens` (e.g. 19806+215=20021);
  `reasoning_output_tokens` (92) < `output_tokens` (215) ⇒ reasoning is INSIDE output;
  `cached_input_tokens` (4992) < `input_tokens` (19806) ⇒ cached is INSIDE input. So mapping
  `input := input_tokens − cached`, `cache_read := cached`, `output := output_tokens` gives
  `computeTotal = (input_tokens−cached) + output_tokens + cached = total_tokens`. ✓
- **[VERIFIED — Gemini]** `total = input + output + thoughts` (27206+42+332=27580). `thoughts` is
  ADDITIVE (NOT inside output, unlike Codex). So fold `thoughts` (and `tool`) into normalized
  `output` to keep `computeTotal` correct.
- **[VERIFIED — Gemini cached⊂input]** A real message with `cached>0` settles it: `input 28118,
  output 198, cached 20241, thoughts 0, total 28316` → `input + output + thoughts = 28316 = total`,
  and adding cached (48557) does NOT equal total. So `cached` is a SUBSET of `input` (exactly like
  Codex): map `cache_read := cached`, `input := input − cached`. Confirmed in fixture tests.
- **Residual (low risk):** no Gemini message with `tool>0` exists in any of the 71 on-disk sessions,
  so `tool`-additivity is unobserved. Fold `tool` into `output` defensively (if `tool===0`, a no-op;
  matches the additive pattern of `thoughts` if it ever appears). Note this in the connector
  `knownGaps`.

### D2 — Codex emits CUMULATIVE token snapshots; use the per-turn DELTA

**[VERIFIED — Codex]** `token_count.info` has BOTH `total_token_usage` (running cumulative; grew
20021 → 2,945,104 across the session) and `last_token_usage` (per-turn delta). The sum of all
`last_token_usage.total_tokens` equals the final `total_token_usage.total_tokens` EXACTLY
(2,945,104 == 2,945,104). ⇒ Emit one `usage.reported` + `cost.estimated` per `token_count` record
using **`last_token_usage`** (the delta). Using `total_token_usage` would multiply the session cost by
~the number of token_count records. This is the single most important Codex correctness rule.

### D3 — Codex record envelope is TWO-LEVEL (spike is stale)

**[VERIFIED]** Real records (cli 0.137.x) are `{ timestamp, type, payload }` where `type` ∈
`session_meta | event_msg | response_item | turn_context`, and the meaningful sub-type is
`payload.type`:
- `event_msg.payload.type` ∈ `task_started | user_message | agent_message | token_count |
  task_complete | web_search_end | patch_apply_end`
- `response_item.payload.type` ∈ `message | reasoning | function_call | function_call_output |
  web_search_call | custom_tool_call | custom_tool_call_output`

Parse on `payload.type`, not the top-level `type`. Field locations **[VERIFIED]**:
- `session_meta.payload`: `id` (= sessionId), `cwd`, `git.branch`, `cli_version`, `timestamp`.
- `turn_context.payload`: `model` (e.g. `"gpt-5.5"`), `cwd`. Model is per-turn — **carry the most
  recent `turn_context.model` forward** and stamp it on subsequent events (token_count/tool records
  carry no model of their own).
- `function_call.payload`: `{ name, arguments, call_id }`; `function_call_output.payload`:
  `{ call_id, output }`; `custom_tool_call(_output)` analogous. `patch_apply_end` = a diff applied.
- **[VERIFIED — no structured tool-error signal]** `function_call_output.output` is a PLAIN STRING
  (e.g. `"Exit code: 0\nWall time: 0.5 seconds\nOutput:\n..."`), with no `is_error`/`status` field;
  `custom_tool_call_output.output` is the same shape. `turn_aborted` did not occur in the sampled
  session. ⇒ In M4, emit `tool.call.completed` for every `*_output` record and DEFER failure
  classification (record it in the connector `knownGaps`). Do NOT regex `"Exit code: N"` — the format
  is not guaranteed across tool types and a wrong `failed` is worse than a deferred one.

### D4 — Gemini snapshot capture: minimal additive watcher extension

Add `captureMode?: "tail" | "snapshot"` to `Connector` (optional; absent/`"tail"` = today's exact
behavior, so Claude/Codex are untouched). In `FileWatcher.tickOnce`, branch:
- `tail` (default): unchanged — `readGrownPrefix` + `saveCursor(offset, offset)`.
- `snapshot`: `readSnapshot(path, prev)` where `prev` is the stored cursor repurposed as
  `{ byteOffset = fileSizeBytes, size = floor(mtimeMs) }`. If size+mtime unchanged → skip (cheap, no
  read). On change → read whole file, `onChange(connector, wholeText)`, then
  `saveCursor(connectorId, path, fileSizeBytes, floor(mtimeMs))` AFTER onChange (preserve the
  commit-point ordering). Document the field repurposing in `snapshot.ts`.

**Why this is safe (no new dedup risk):** whole-file re-parse yields the same events with the same
fingerprints; `QueueStore.enqueue`'s `WHERE content_hash <> excluded` makes an unchanged re-enqueue a
true no-op, and the server upserts by fingerprint (§23). The mtime/size gate is only an optimization;
the dedup is the correctness backstop. Restart-resume is preserved by the stored size+mtime; even a
missed gate re-sends idempotently.

Do **not** generalize the cursor into an opaque token or add a `readSince(cursor)` to the connector
contract — that is a larger refactor than M4 needs. The two-branch `captureMode` is the minimal cut.

### D5 — Parser versions

Bump Claude `PARSER_VERSION` `"1.0.0" → "2.0.0"` (new derived events change the projection; replay
re-derives, fingerprints for pre-existing event types are unchanged so they upsert in place). New
connectors start at `"1.0.0"`. Connector ids: `"codex-cli"`, `"gemini-cli"`.

### D6 — Claude fidelity derivations (tool lifecycle / file / context)

- **Tool lifecycle [VERIFIED]:** `assistant` records carry `message.content[]` blocks of
  `type:"tool_use"` `{ type, id, name, input, caller }`. The NEXT `user` record carries
  `message.content[]` blocks of `type:"tool_result"` `{ type, content, is_error, tool_use_id }`
  (`is_error` IS present and boolean). Correlate by `tool_use_id`: emit `tool.call.completed` when
  `is_error` is falsy, `tool.call.failed` when truthy. Keep `tool.call.started` as today. Build a
  `Map<tool_use_id → result record>` in a pass over user records, then emit completion/failure on the
  RESULT record (its `rawId`) so the fingerprint is stable.
- **File events [VERIFIED key]:** from `tool_use` blocks by tool `name`: `Read` → `file.read`;
  `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `file.modified`. The input key is `file_path`
  (confirmed: `Read.input` keys = `["file_path"]`). Put `{ path: input.file_path }` in the event
  `payload`. **Skip `file.referenced` in M4** — there is no single reliable structured signal for it
  in the store; record it as a `knownGap` rather than guessing. (The `EventType` still includes it for
  a later milestone.)
- **context.loaded [VERIFIED source]:** emit for `attachment` records. A real `attachment` record has
  top keys `{ parentUuid, isSidechain, attachment, type, uuid, timestamp, userType, entrypoint, cwd,
  sessionId, version, gitBranch }`, where `attachment` is `{ type: "deferred_tools_delta", addedNames:
  [...] }` (and other subtypes). Emit `context.loaded` per `attachment` record with `payload:
  { attachmentType: record.attachment?.type }`. Do NOT map `system` records (those are
  `subtype:"compact_boundary"` compaction markers — a different concern, deferred).

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (shared types + pricing + fixtures)

Extend the event taxonomy, add pricing entries, and build the grounded fixtures every parser test
reads. No connector behavior yet.

### Phase 2: Core Implementation (three parsers + watcher extension)

Thicken the Claude parser; write the Codex and Gemini parsers; add the `snapshot` capture mode and
`readSnapshot` helper.

### Phase 3: Integration (registry + watcher wiring)

Register the new connectors; wire the `captureMode` branch in `tickOnce`; confirm `capture-engine`
needs no change; optional light report additions.

### Phase 4: Testing & Validation

Unit tests per parser + snapshot watcher; extend/confirm the capture-engine int test path;
`npm run repo-health` green.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### Task 1 — UPDATE `packages/shared/src/events.ts` (extend EventType)

- **ADD** to the `EventType` union: `"file.read"`, `"file.modified"`, `"file.referenced"`,
  `"context.loaded"`. (`tool.call.completed`/`tool.call.failed` already exist — do not re-add.)
- **UPDATE** the doc comment listing the M1 subset to reflect the M4 additions.
- **GOTCHA**: this also flows into `EventPayload.eventType` (ingest.ts) automatically — the wire type
  reuses `EventType`. No server change: `apps/ingest/src/schemas.ts:68` validates
  `eventType: {type:"string"}` and `packages/db/src/schema.ts:106` is `text("event_type")`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 1b — REFACTOR `ParseResult` into the contract module (avoid cross-connector imports)

- **PROBLEM**: `ParseResult` is currently defined/exported in `connectors/claude-code.ts` (lines
  23-29) and `connector.ts` imports it from there. If `codex-cli.ts` and `gemini-cli.ts` also import
  it from `claude-code.js`, two sibling connectors take a sideways dependency on a third connector's
  module purely for a type — a smell that hurts AI-navigability.
- **MOVE** the `ParseResult` interface into `connectors/connector.ts` (the contract module, which
  already declares the `Connector` interface that references it). Export it from there.
- **UPDATE** `claude-code.ts` to `import type { ParseResult } from "./connector.js"` (it already
  imports the `Connector` type pattern). `codex-cli.ts`/`gemini-cli.ts` then import `ParseResult` from
  `./connector.js` too.
- **GOTCHA**: `connector.ts` imports the `claudeCodeConnector` VALUE from `claude-code.js` for the
  registry; `claude-code.ts` importing only the `ParseResult`/`Connector` TYPES from `connector.js` is
  erased at runtime (type-only), so no runtime import cycle is introduced. Keep both imports
  `import type`.
- **VALIDATE**: `npm run typecheck` (exit 0) and `npm test -w @420ai/collector -- claude-code`
  (existing tests still green).

### Task 2 — UPDATE `packages/shared/src/pricing.ts` (add Codex + Gemini models)

- **ADD** `PRICING_CATALOG` entries keyed by the EXACT model ids the connectors write:
  `"gpt-5.5"` (Codex — **[VERIFIED]** model string) and `"gemini-3-flash-preview"` (Gemini —
  **[VERIFIED]**). Add `"gpt-5.4"` too (older Codex sessions on disk use it).
- **IMPLEMENT**: fill `{input, output, cache_read, cache_write, sourceUrl, asOf}` in USD-per-single-
  token (per-MTok ÷ 1e6), mirroring the existing Anthropic entries. **VALIDATE the current public
  rates** from OpenAI and Google pricing pages at implementation time; set `sourceUrl`/`asOf`
  accordingly. Codex has no separate cache-write tier → set `cache_write` = `input` rate (it will be
  multiplied by 0 tokens anyway, per D1).
- **GOTCHA**: if you cannot confirm a rate, it is acceptable to OMIT that model — `getPricing` returns
  `undefined` → `computeCost` degrades gracefully to `estimated-model-unknown` (usd 0), no crash. Do
  NOT invent rates silently; a missing entry is safer than a wrong one. Note any omission in NOTES.
- **VALIDATE**: `npm test -w @420ai/shared` (existing cost/pricing tests still pass; exit 0).

### Task 3 — CREATE Claude tool/file/context fixture

- **PREFER** a new sibling `apps/collector/src/fixtures/sample-session-tools.jsonl` (keep the existing
  fixture's assertions intact). Include, as valid JSONL lines mirroring the **[VERIFIED]** real Claude
  shapes:
  - an `assistant` record whose `message.content` has a `tool_use` block `{type:"tool_use", id,
    name:"Read", input:{file_path}}` and another `{type:"tool_use", id, name:"Edit",
    input:{file_path}}`;
  - a following `user` record whose `message.content` has matching `tool_result` blocks
    `{type:"tool_result", tool_use_id, content, is_error}` — one with `is_error:false`, one with
    `is_error:true`;
  - an `attachment` record `{type:"attachment", attachment:{type:"deferred_tools_delta", addedNames:
    [...]}, uuid, timestamp, cwd, gitBranch, sessionId}` (drives `context.loaded`).
- **GOTCHA**: keep token values small and deterministic; this fixture drives exact `toEqual`
  assertions.
- **VALIDATE**: `node -e "require('fs').readFileSync('apps/collector/src/fixtures/sample-session-tools.jsonl','utf8').split(/\\r?\\n/).filter(Boolean).forEach(l=>JSON.parse(l))"` (every line parses; exit 0).

### Task 4 — UPDATE `apps/collector/src/connectors/claude-code.ts` (full fidelity)

- **IMPLEMENT** in `parseClaudeCodeSession`, preserving the existing two-pass tolerant structure:
  - **Tool lifecycle**: in a pass over parsed records, build `Map<tool_use_id → resultRecord>` from
    `user` records' `tool_result` blocks. When emitting events for the assistant `tool_use` block,
    keep `tool.call.started` (eventIndex as today). On the RESULT record, emit `tool.call.completed`
    (is_error falsy) or `tool.call.failed` (truthy), with `payload:{ name, tool_use_id }`, fingerprint
    keyed off the result record's `rawId`.
  - **File events**: for `tool_use` `name` ∈ {`Read`}→`file.read`; {`Edit`,`Write`,`MultiEdit`,
    `NotebookEdit`}→`file.modified`. `payload:{ path: input.file_path }`. Increment `eventIndex` within
    the record after the existing tool/usage/cost indices to keep fingerprints unique per record.
  - **context.loaded**: emit one per `attachment` record, `payload:{ attachmentType:
    record.attachment?.type }` (see D6 — VERIFIED). Do not map `system` records.
- **UPDATE** `PARSER_VERSION` → `"2.0.0"` (D5).
- **UPDATE** `claudeCodeConnector.fidelity.knownGaps` to drop "tool.call completion not yet correlated
  (M4)" and add `captureMode: "tail"`.
- **GOTCHA**: eventIndex must stay deterministic and unique *within a raw record* (it is part of the
  fingerprint). Assign a stable, documented index order; never derive it from iteration that can
  reorder.
- **GOTCHA**: do not regress existing tests — `usage.reported` still exactly one per assistant record
  with usage; `session.started/ended` unchanged.
- **VALIDATE**: `npm test -w @420ai/collector -- claude-code` (exit 0; update the existing test file
  for the new events — see Task 11).

### Task 5 — CREATE `apps/collector/src/connectors/codex-cli.ts`

- **IMPLEMENT** `parseCodexSession(fileText): ParseResult` mirroring Claude's tolerant two-pass shape:
  - Split lines; tolerant `JSON.parse`; push raw record per line with `id = uuid?? `${sessionId}:${lineIndex}`` and `payload: line`. **[VERIFIED]** Codex lines have NO per-record uuid → use the
    lineIndex fallback.
  - sessionId = `session_meta.payload.id`. projectPath = `session_meta.payload.cwd` (or
    `turn_context.payload.cwd`). gitBranch = `session_meta.payload.git.branch`.
  - Carry `currentModel` forward from each `turn_context.payload.model` (D3).
  - `session.started` from earliest `timestamp`, `session.ended` from latest (mirror Claude).
  - For each `event_msg` with `payload.type === "token_count"`: map `payload.info.last_token_usage`
    via D1/D2 → emit `usage.reported` (tokens) + `cost.estimated` (computeCost(currentModel, tokens)).
  - For `response_item.payload.type === "function_call"` / `custom_tool_call`: emit
    `tool.call.started` `{name, call_id}`. For `function_call_output`/`custom_tool_call_output`: emit
    `tool.call.completed` `{call_id}` ONLY — `output` is a plain string with no structured error
    signal (D3, VERIFIED), so defer failure classification to `knownGaps`. For `patch_apply_end`:
    emit `file.modified` (path(s) from payload if present; else omit path).
  - `message`/`agent_message`/`user_message` → `message.assistant`/`message.user` as appropriate.
- **EXPORT** `CODEX_CLI_CONNECTOR = "codex-cli"`, `PARSER_VERSION = "1.0.0"`, and `codexCliConnector`
  with `captureMode:"tail"`, `watchGlobs(home) => [join(home,".codex","sessions","*","*","*","rollout-*.jsonl")]`, fidelity per PRD §10.3 (`status:"stable"`, `captureMethod:"tail-jsonl"`,
  `liveness:"streaming"`, `tokens:"exact"`, `cost:"computed"`, `testedVersions:["0.137.x"]`,
  `knownGaps:["tool-call failure classification deferred — outputs carry no structured is_error"]`).
- **GOTCHA (critical)**: use `last_token_usage`, NEVER `total_token_usage`, for per-event tokens (D2).
- **GOTCHA**: glob has three wildcard dirs (`YYYY/MM/DD`) — `node:fs/promises glob` is minimatch with
  forward slashes (file-watcher.ts:42 already normalizes `\`→`/`).
- **VALIDATE**: `npm test -w @420ai/collector -- codex` (after Task 6/12; exit 0).

### Task 6 — CREATE `apps/collector/src/fixtures/sample-codex-rollout.jsonl`

- **IMPLEMENT** a small synthetic rollout grounded in **[VERIFIED]** shapes: one `session_meta`
  (`{id, cwd, git:{branch}}`), one `turn_context` (`{model:"gpt-5.5", cwd}`), one `user_message`, one
  `agent_message`, two `token_count` records with realistic `last_token_usage`/`total_token_usage`
  (make `total_tokens == input_tokens + output_tokens`, `reasoning_output_tokens < output_tokens`,
  `cached_input_tokens < input_tokens`), one `function_call` + `function_call_output`, and one
  malformed line (to test `skippedLines`).
- **VALIDATE**: line-parse check as in Task 3.

### Task 7 — CREATE `apps/collector/src/watcher/snapshot.ts` (pure readSnapshot)

- **IMPLEMENT** `readSnapshot(path, prev?: {sizeBytes:number, mtimeMs:number}): { text:string,
  sizeBytes:number, mtimeMs:number, changed:boolean }`:
  - `statSync(path)` → `size`, `mtimeMs`. If `prev` and `prev.sizeBytes===size &&
    Math.floor(prev.mtimeMs)===Math.floor(mtimeMs)` → `{ text:"", ..., changed:false }` (no read).
  - Else read whole file (`readFileSync(path,"utf8")`), return `changed:true`.
- **PATTERN**: keep it PURE and synchronous like `tailer.ts`; no logging.
- **GOTCHA**: a partially-written JSON rewrite could be read mid-flush. Guard: if `JSON.parse(text)`
  would throw, the CONNECTOR parser must be tolerant and return empty (`parse` already is for Codex/
  Claude); for Gemini, wrap the whole-file `JSON.parse` in try/catch → on failure return empty
  `ParseResult` (skippedLines reflects it) so the cursor is NOT advanced and the next tick retries.
- **VALIDATE**: `npm test -w @420ai/collector -- snapshot` (after Task 13; exit 0).

### Task 8 — UPDATE `apps/collector/src/connectors/connector.ts` (captureMode)

- **ADD** `captureMode?: "tail" | "snapshot";` to the `Connector` interface (optional → default tail;
  Claude/Codex set `"tail"` explicitly, Gemini `"snapshot"`). Document: absent = `"tail"`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 9 — CREATE `apps/collector/src/connectors/gemini-cli.ts`

- **IMPLEMENT** `parseGeminiSession(fileText): ParseResult`:
  - `try { JSON.parse }` the WHOLE file; on throw return `{rawRecords:[],events:[],skippedLines:1}`
    (tolerant of mid-rewrite reads — see Task 7 gotcha).
  - sessionId = `obj.sessionId`; projectPath attribution = `obj.projectHash` (note: it's a hash, not a
    path — store it; real path mapping is M5). Iterate `obj.messages[]` with a STABLE index.
  - One raw record per message: **[VERIFIED]** every message (user/gemini/info) has a stable
    `message.id` → `id = message.id` (fall back to `` `${sessionId}:msg:${i}` `` only if `id` is ever
    absent). `payload: JSON.stringify(message)` (raw is sacred; the source is one JSON blob —
    per-message slicing keeps raw granular for dedup). Document this choice.
  - `user` → `message.user`; `gemini` → `message.assistant` + (if `tokens`) `usage.reported`
    (map per D1, all VERIFIED: `cache_read := cached`, `input := input − cached` (cached⊂input),
    `output := output + thoughts + tool`, `reasoning := thoughts`, `tool := tool`) + `cost.estimated`
    (computeCost(message.model, tokens)). `model` from `message.model`.
  - `toolCalls[]` per assistant message: `tool.call.started` `{name}`; then `tool.call.completed`
    (`status==="success"`) or `tool.call.failed` (`status==="error"`). Use a stable sub-index in the
    fingerprint.
  - `session.started` from `obj.startTime`, `session.ended` from `obj.lastUpdated`.
- **EXPORT** `GEMINI_CLI_CONNECTOR="gemini-cli"`, `PARSER_VERSION="1.0.0"`, `geminiCliConnector` with
  `captureMode:"snapshot"`, `watchGlobs(home)=>[join(home,".gemini","tmp","*","chats","session-*.json")]`,
  fidelity (`status:"stable"`, `captureMethod:"watch-diff-json"`, `liveness:"near-real-time"`,
  `tokens:"exact"`, `cost:"computed"`, `knownGaps:["projectHash is a hash, not a path (M5 maps it)"]`).
- **GOTCHA**: fingerprints MUST be stable across whole-file rewrites. Key the rawRecordId on
  `message.id` — **[VERIFIED]** present on 100% of messages across all 71 on-disk sessions (user,
  gemini, AND info). This is stable whether the session appends or rewrites earlier messages, so it is
  strictly safer than a positional index. The index fallback is defensive only.
- **VALIDATE**: `npm test -w @420ai/collector -- gemini` (after Task 10; exit 0).

### Task 10 — CREATE `apps/collector/src/fixtures/sample-gemini-session.json`

- **IMPLEMENT** a small synthetic session: `{sessionId, projectHash, startTime, lastUpdated,
  messages:[ {id, type:"user",...}, {id, type:"gemini", model:"gemini-3-flash-preview",
  tokens:{input,output,cached,thoughts,tool,total}, toolCalls:[{name,status:"success"},
  {name,status:"error"}]} ]}`. Every message MUST have an `id`. Set token values with a NON-ZERO
  `cached` and non-zero `thoughts` so the test proves the verified arithmetic:
  `total == input + output + thoughts` with `cached ⊂ input` (e.g. `input:28118, output:198,
  cached:20241, thoughts:0, total:28316` — or add thoughts and re-sum). The mapping under test:
  `cache_read=cached`, `input_normalized = input − cached`, `output_normalized = output + thoughts`.
- **VALIDATE**: `node -e "JSON.parse(require('fs').readFileSync('apps/collector/src/fixtures/sample-gemini-session.json','utf8'))"` (exit 0).

### Task 11 — UPDATE `apps/collector/src/connectors/claude-code.test.ts`

- **ADD** tests against `sample-session-tools.jsonl`: a `tool.call.completed` and a `tool.call.failed`
  are emitted and correlated by `tool_use_id`; `file.read`/`file.modified` carry the right `path`;
  `context.loaded` is emitted; fingerprint-stability still holds; existing assertions still pass.
- **VALIDATE**: `npm test -w @420ai/collector -- claude-code` (exit 0).

### Task 12 — CREATE `apps/collector/src/connectors/codex-cli.test.ts`

- **ADD** tests: `skippedLines===1`; sessionId/projectPath/gitBranch resolved from `session_meta`;
  model carried from `turn_context`; **exactly one `usage.reported` per token_count using the DELTA**
  (assert tokens equal the mapped `last_token_usage`, full 7-field `toEqual`, and that
  `tokens.total === last.total_tokens`); a `cost.estimated` with `estimated-model-known` IF pricing
  added (else `estimated-model-unknown`); fingerprint stability across two parses.
- **VALIDATE**: `npm test -w @420ai/collector -- codex` (exit 0).

### Task 13 — CREATE `apps/collector/src/connectors/gemini-cli.test.ts` + `watcher/snapshot.test.ts`

- **Gemini test**: token mapping `toEqual` proving `output === rawOutput + thoughts (+tool)` and
  `total === computeTotal(...)`; `tool.call.completed`/`failed` from `status`; tolerant of a malformed
  whole-file (parse `"{not json"` → empty ParseResult, skippedLines 1); fingerprint stability.
- **snapshot test**: `readSnapshot` returns `changed:false` (no read) when size+mtime match `prev`;
  `changed:true` with full text when they differ; behaves on first call (no `prev`).
- **VALIDATE**: `npm test -w @420ai/collector -- "gemini|snapshot"` (exit 0).

### Task 14 — UPDATE `apps/collector/src/connectors/connector.ts` registry

- **ADD** `codexCliConnector` and `geminiCliConnector` to the `connectors: Connector[]` array (import
  both). Keep Claude first.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 15 — UPDATE `apps/collector/src/watcher/file-watcher.ts` (captureMode branch)

- **IMPLEMENT** in `tickOnce`, per discovered file, branch on `connector.captureMode ?? "tail"`:
  - `"tail"`: existing path unchanged (`readGrownPrefix` + `saveCursor(id,path,newOffset,newOffset)`).
  - `"snapshot"`: read stored cursor as `prev={sizeBytes:cursor.byteOffset, mtimeMs:cursor.size}`;
    `readSnapshot(path, prev)`; if `!changed` continue; else `await onChange(connector, text)` THEN
    `saveCursor(id, path, sizeBytes, Math.floor(mtimeMs))`. Preserve the "cursor committed only after
    onChange" ordering (file-watcher.ts:64-68).
- **GOTCHA**: keep the existing comment's commit-point invariant true for BOTH branches — if
  `onChange` throws, the cursor is not advanced and the file is retried next tick.
- **VALIDATE**: `npm test -w @420ai/collector -- file-watcher` (extend its test with a snapshot
  connector + a temp file rewritten between ticks; exit 0).

### Task 16 — (OPTIONAL) UPDATE `apps/collector/src/report/session-report.ts`

- **ADD** light, non-breaking lines: a "Files touched" count (`file.read`/`file.modified`) and a "Tool
  outcomes" line (`completed`/`failed`). Skip if it risks the existing report tests; this is polish,
  not required for M4 acceptance.
- **VALIDATE**: `npm test -w @420ai/collector -- session-report` (exit 0).

### Task 17 — UPDATE `apps/collector/src/capture-engine.int.test.ts` (if cheap)

- **CONFIRM** the engine path works for a `snapshot` connector end-to-end: drive a temp Gemini-shaped
  JSON file through watcher → queue → in-process M2 ingest → Postgres (self-skips without
  `DATABASE_URL_TEST`). Mirror the existing int test. If the existing test already exercises the
  generic path, a focused addition asserting a snapshot file is captured is enough.
- **VALIDATE**: `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=... npm test` (int passes) OR
  `npm test` (self-skips; exit 0).

### Task 18 — UPDATE README "Status" + connector notes; run the gate

- **UPDATE** the README M3/Status prose to note M4 added Codex CLI + Gemini CLI connectors and Claude
  full fidelity (keep it brief; do not re-paste conventions).
- **VALIDATE (the gate)**: `npm run repo-health` (root `tsc -b` + full `vitest run` + NUL-byte scan +
  stray-artifact scan; must exit 0). This is the enforced pre-commit gate (CLAUDE.md).

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, no infra — always run)

- Claude: tool-lifecycle correlation, file events, context.loaded, no-regression on existing
  assertions, fingerprint stability.
- Codex: two-level envelope parse, `last_token_usage` delta mapping (with the **[VERIFIED]**
  arithmetic asserted), model carry-forward, tolerant skip, fingerprint stability.
- Gemini: whole-file parse, `output := output+thoughts(+tool)` mapping with `total === computeTotal`,
  tool-call status mapping, tolerant of malformed/mid-rewrite blob, fingerprint stability (keyed on
  `message.id`/index).
- snapshot: size+mtime change detection (read-skip vs read).
- file-watcher: `captureMode` branch (tail unchanged; snapshot reads on rewrite, skips when
  unchanged, commits cursor only after onChange).

### Integration Tests (`*.int.test.ts`, `DATABASE_URL_TEST`-gated, excluded from `tsc -b`)

- `capture-engine.int.test.ts`: a snapshot (Gemini-shaped) file flows watcher → queue → ingest →
  Postgres; re-tick with no change is a queue no-op; re-tick after rewrite upserts changed events.

### Edge Cases (must be covered)

- Codex `total_token_usage` is NEVER used for per-event tokens (regression guard against the
  cumulative double-count).
- Gemini file read mid-rewrite (invalid JSON) → empty ParseResult, cursor not advanced, retried.
- Gemini `messages[]` grows between snapshots → only new/changed message events enqueue (dedup).
- Claude `tool_use` with no matching `tool_result` (session still streaming) → `tool.call.started`
  with no completion yet; a later tick adds the completion (idempotent upsert).
- A model absent from the pricing catalog → `cost.estimated` confidence `estimated-model-unknown`,
  usd 0, no throw.
- Multibyte content in a tailed file → byte-offset tailer already handles via Buffer `lastIndexOf`
  (unchanged path).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with the stated pass signal.

### Level 1: Typecheck / Build (repo-root — catches cross-project + test-only imports)

- `npm run typecheck` → root `tsc -b`, **exit 0**. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests

- `npm test` → full `vitest run`; units always run, `*.int.test.ts` self-skip without
  `DATABASE_URL_TEST`. **All pass, exit 0.**
- Focused: `npm test -w @420ai/collector -- codex` / `gemini` / `claude-code` / `snapshot` /
  `file-watcher`.

### Level 3: Integration Tests

- `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test`
  → Postgres int tests run incl. the snapshot capture path. **All pass, exit 0.**

### Level 4: Manual Validation (real data, read-only)

- `npx tsx apps/collector/src/cli.ts watch --interval 1000` with a paired archive while a real Codex
  and Gemini session are active → `collector queue` shows backlog draining; no duplicate growth on a
  second `watch` run (idempotency). (Requires M2 pairing first.)
- Spot-check one captured Codex session's summed `usage.reported.total` against the session's final
  `token_count.total_token_usage.total_tokens` — they should match (D2).

### Level 5: The enforced gate

- `npm run repo-health` → typecheck + full vitest + NUL-byte scan + stray-artifact scan. **Exit 0.**
  This must pass before any commit (pre-commit hook runs the fast subset).

---

## ACCEPTANCE CRITERIA

- [ ] `EventType` includes `file.read`/`file.modified`/`file.referenced`/`context.loaded`; no server
      or DB change made.
- [ ] Claude connector emits correlated `tool.call.completed`/`failed`, file events, and
      `context.loaded`; `PARSER_VERSION` is `2.0.0`; old assertions still pass; stale knownGap removed.
- [ ] Codex connector parses the two-level envelope, emits per-turn `usage.reported` from
      `last_token_usage` (summing to the session total), carries model from `turn_context`, attributes
      `cwd`/`git.branch`; registered in `connectors[]`.
- [ ] Gemini connector parses the whole-file JSON, folds thoughts(+tool) into `output` so
      `computeTotal` reproduces the vendor `total`, maps tool-call status, tolerates mid-rewrite reads;
      registered with `captureMode:"snapshot"`.
- [ ] `FileWatcher` reads snapshot connectors by size+mtime change without disturbing the tail path;
      cursor committed only after `onChange`.
- [ ] All token mappings match the **[VERIFIED]** on-disk arithmetic (asserted in fixture tests).
- [ ] `npm run repo-health` passes (exit 0); no stray artifacts, no NUL bytes.
- [ ] No new npm dependencies; no new server code or Postgres tables.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately.
- [ ] Full suite passes (unit always; integration with `DATABASE_URL_TEST`).
- [ ] Token arithmetic spot-checked against a real session (Level 4).
- [ ] Deferred event categories (Claude `file.referenced`; Codex tool-failure) recorded in
      `knownGaps` rather than emitted incorrectly. (Token arithmetic + record shapes were verified
      against real files during planning — see the `[VERIFIED]` markers; no open PRE-FLIGHT remains
      except the unobservable Gemini `tool>0` case, handled defensively.)
- [ ] README Status updated.
- [ ] `npm run repo-health` green.

---

## NOTES

**Why no `computeTotal`/`computeCost`/shared-cost change (key design call):** `computeTotal` excludes
`reasoning`/`tool` by design because, normalized correctly, those are always SUBSETS of `output`. The
on-disk arithmetic confirms this holds natively for Codex (`output_tokens` already includes
`reasoning_output_tokens`) and is made to hold for Gemini by folding `thoughts`(+`tool`) into `output`.
This keeps the FROZEN token shape and the cost formula untouched and keeps `total` comparable
across connectors (input+output+cache). The rejected alternative — trusting each vendor's reported
`total` directly — would diverge per connector and force a change to a load-bearing invariant.

**Why snapshot mode over a cursor refactor:** the minimal additive `captureMode` discriminant adds
whole-file-rewrite support behind the same `Connector.parse(fileText)` contract, leaving the proven
byte-offset tail path byte-for-byte unchanged. The queue's content-hash dedup + server fingerprint
upsert make whole-file re-parse idempotent, so the mtime/size gate is a pure optimization, not a
correctness dependency. A general `readSince(cursor)` connector method was considered and rejected as
out-of-scope for M4.

**Stale spike warning:** `docs/research/connector-capture-spike.md`'s Codex section predates the
two-level-envelope format (cli 0.137.x). This plan's **[VERIFIED]** facts supersede it. Consider a
follow-up to refresh the spike doc (not required for M4).

**Deferred to later milestones (do not pull in):** Git outcome events (`git.commit.detected`/
`git.diff.detected`) → M6; project mapping of Codex `cwd` / Gemini `projectHash` → M5; Antigravity/
Cursor connectors → stretch/research-gated; richer Codex tool-failure classification (beyond
completed/failed) → can grow via `knownGaps` without a framework change.

**Confidence note for the executor:** the token arithmetic and record shapes are all `[VERIFIED]`
against real on-disk files (Codex `gpt-5.5`, Gemini `gemini-3-flash-preview` incl. a `cached>0`
message, Claude tool_use/tool_result/attachment/file_path). Remaining executor-side care:
(1) Codex delta-vs-cumulative (D2 — guard with a regression test asserting the deltas sum to the
session total); (2) eventIndex stability for the new Claude events (keep the index order documented
and deterministic — it is part of the fingerprint); (3) snapshot-mode mtime/size cursor repurposing
(the queue content-hash dedup is the correctness backstop if the gate ever misfires). The only
unverifiable item is a Gemini `tool>0` message (absent from all 71 sessions) — folded into `output`
defensively.

**Post-correction confidence: 9/10** (was 8/10). The +1 reflects retiring every Claude/Codex/Gemini
PRE-FLIGHT against real data during the read-&-correct pass, plus the `ParseResult` relocation
(Task 1b) removing a cross-connector import smell before it is written.
