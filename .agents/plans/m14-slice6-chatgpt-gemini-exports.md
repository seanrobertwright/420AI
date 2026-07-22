# Feature: M14 Slice 14.6 — ChatGPT + Gemini chat-export connectors

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils/types/models — import from the right files.

> Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (event/fingerprint invariants, raw-records-sacred,
> validation gate). Milestone + prior slice:
> [`m14-general-ai-chat-capture.md`](./m14-general-ai-chat-capture.md) and the shipped
> [`m14-slice5-chat-export-connectors.md`](./m14-slice5-chat-export-connectors.md) (the Claude export
> connector this slice mirrors). This plan **links, not re-pastes.**

## Feature Description

Two additional `snapshot`-mode chat-export connectors — **`chatgpt-export`** (OpenAI ChatGPT data
export) and **`gemini-export`** (Google Takeout "My Activity → Gemini Apps"). These complete the M14
chat-export surfaces: 14.5 shipped `claude-export` and explicitly deferred ChatGPT (*"export NOT yet
obtained → surface skipped, recorded as a gap… ChatGPT follows when its export lands"*) and named Gemini
Takeout as 14.6. **Both exports have now landed** (in `docs/data/OpenAI/` and `docs/data/Gemini/`) and
were inspected structure-only during planning — the field maps below are **verified against the real
files, not documentation.**

Each connector is a thin object + a pure parser in `@420ai/shared`, mapping the export JSON onto the
**existing** `NormalizedEvent` taxonomy. **Zero framework change** (the `snapshot` drop-dir path is the
shipped `claude-export`/Gemini precedent), no fingerprint change, no schema change, no server change.

## User Story

As the self-hosting admin
I want to import my ChatGPT and Gemini chat exports and have them captured as sessions/events
So that my AI chat history across all three assistants is searchable/analyzable in the same archive as my
coding-tool activity, grouped by topic since there's no repo to attribute it to.

## Problem Statement

`claude-export` (14.5) captures only Claude chat. ChatGPT and Gemini web/app conversations have no
dashboard/archive visibility. The 14.0 spike proved no chat surface persists a local conversation store,
so **official data exports are the only feasible batch pipe** (the extension is the separate 14.7 path,
Claude-only so far).

## Solution Statement

Two `snapshot`-mode connectors over user drop-dirs
(`~/.420ai/chat-imports/chatgpt/*.json`, `~/.420ai/chat-imports/gemini/*.json`), each wrapping a pure
parser that maps the export onto `session.started`/`message.user`/`message.assistant`/`session.ended`.
Non-repo attribution via a synthetic `chat:<surface>:<key>` topic key (the shipped `claude-export`
design, aliasable via `workspace_keys`). ChatGPT is **model-attributed** (`metadata.model_slug` is
present) but **uncosted** (no token counts); Gemini is uncosted and model-less. Both `experimental` /
`batch`.

## Feature Metadata

**Feature Type**: New Capability (two additive connectors)
**Estimated Complexity**: Medium (ChatGPT: clean, mirrors `claude-export` + tree ordering; Gemini: a
flat activity log with no threading + no natural id — a genuinely new parser shape)
**Primary Systems Affected**: `packages/shared` (two new pure parsers + fixtures) + `apps/collector`
(two new connector objects + registry). **No** DB schema / ingest / server / fingerprint change.
**Dependencies**: none new. Real export samples are already on disk (`docs/data/`).

---

## CONTEXT REFERENCES — READ THESE BEFORE IMPLEMENTING

- **`apps/collector/src/connectors/claude-export.ts` (whole, 49 lines)** — THE exact connector shape to
  copy. `captureMode:"snapshot"`, `fidelity` with `status:"experimental"`/`liveness:"batch"`/
  `tokens:"none"`/`cost:"none"`/`knownGaps`/`requiredPermissions`, `watchGlobs:(home)=>[join(home,
  ".420ai","chat-imports","claude","*.json")]`, `parse:(text)=>parseClaudeExport(text)`, re-exports the
  pure parser + consts from `@420ai/shared`. Copy this twice (chatgpt/, gemini/).
- **`packages/shared/src/parsers/claude-export.ts` (whole, 205 lines)** — THE pure parser to mirror:
  tolerant `JSON.parse` try/catch → `{rawRecords:[],events:[],skippedLines:1}` (`:86-91`); flat-array +
  `{conversations:[…]}` wrapper tolerance (`:96-106`); `normalizeTs` guarded ISO helper (`:63-68`);
  stable `rawRecordId` keyed on a message uuid (`:170-173`); `makeEvent` fingerprint builder
  (`:133-151`) — **note it stamps NO `catalogVersion`/`model`/`tokens`/`cost`** (uncosted); non-repo
  `projectPath = chat:claude:<uuid>` (`:130`); `session.started` carries a `{title}` payload
  (`:155-163`); empty-conversation guard (`:126`).
- **`packages/shared/src/parsers/gemini-cli.ts` (whole, 201 lines)** — mirror for the `makeEvent` builder
  that DOES stamp `model` (`:114-134`), and for the "raw record kept, no normalized event" pattern for
  message types that emit nothing (`:191`). NOTE: this is the unrelated Gemini **CLI** parser — the new
  `gemini-export` parser shares only its shape, not its input.
- **`packages/shared/src/parsers/parse-result.ts` (whole, 19 lines)** — `ParseResult { rawRecords,
  events, skippedLines, sessionId? }`. Verified.
- **`packages/shared/src/events.ts:26-75`** — `EventType` union (use ONLY `session.started`,
  `message.user`, `message.assistant`, `session.ended`); `RawSourceRecord {id, sourceConnector,
  sessionId, ingestedAt, payload}` (`:45-51`); `NormalizedEvent` — `projectPath?`/`model?`/`tokens?`/
  `cost?`/`catalogVersion?`/`payload?` all OPTIONAL (`:57-75`).
- **`packages/shared/src/fingerprint.ts` (whole, 24 lines)** — INVARIANT. `eventFingerprint(source,
  rawRecordId, eventIndex, eventType)` = `sha256_hex(join "|")`. Uses `node:crypto` `createHash` — the
  gemini-export key derivation reuses `createHash` from the same module. Do NOT edit this file.
- **`packages/shared/src/index.ts:25-26`** — parser barrel: `export * from "./parsers/<name>.js";`. Add
  two lines (chatgpt-export, gemini-export), mirroring the claude-export line.
- **`apps/collector/src/connectors/connector.ts:127-183`** — `Connector` interface (`captureMode?:
  "tail"|"snapshot"|"poll"|"push"`, `watchGlobs`, `parse`), and the `connectors[]` registry
  (`:176-183`) + its imports (`:2-7`). Append two imports + two array entries.
- **`packages/shared/src/parsers/claude-export.test.ts` (whole)** — THE test harness pattern: `import {
  describe, it, expect } from "vitest"`; `readFileSync(new URL("./fixtures/sample-<x>.json",
  import.meta.url),"utf8")`; `opts = { ingestedAt: "2026-07-20T00:00:00.000Z" }`; asserts event
  counts by type, fingerprint stability, uncosted (0 usage/cost), tolerant parse.
- **Fixture dir convention (VERIFIED): `packages/shared/src/parsers/fixtures/`** (NOT `__fixtures__` —
  the 14.5 plan text said `__fixtures__` but the shipped location is `fixtures/sample-<name>.json`,
  e.g. `sample-claude-export.json`).
- **Non-repo attribution is a solved case** (14.5 verified): `NormalizedEvent.projectPath?` optional
  (`events.ts:68`), nullable DB columns, ingest schema not requiring it, `workspace_keys` alias maps a
  `chat:<surface>:<key>` topic key to a workspace. No change needed here.
- **Capture wiring is COMPLETE — no change**: `apps/collector/src/watcher/file-watcher.ts`
  (snapshot dispatch), `.../snapshot.ts` (whole-file re-read on size/mtime change; idempotent via
  content-hash + server fingerprint upsert), `capture-engine.ts` (`onChange`→`parse`→enqueue),
  `discover()` globs every connector each tick. Verified unchanged for `claude-export`; identical here.

### New Files to Create

- `packages/shared/src/parsers/chatgpt-export.ts` (+ `chatgpt-export.test.ts`) — pure parser, id
  `chatgpt-export`.
- `packages/shared/src/parsers/gemini-export.ts` (+ `gemini-export.test.ts`) — pure parser, id
  `gemini-export`.
- `packages/shared/src/parsers/fixtures/sample-chatgpt-export.json` — **redacted** from
  `docs/data/OpenAI/conversations.json`.
- `packages/shared/src/parsers/fixtures/sample-gemini-export.json` — **redacted** from
  `docs/data/Gemini/MyActivity.json`.
- `apps/collector/src/connectors/chatgpt-export.ts`, `.../gemini-export.ts` — thin connector wrappers.

### Files to Update

- `packages/shared/src/index.ts` — two `export *` lines.
- `apps/collector/src/connectors/connector.ts` — two imports + two `connectors[]` entries.
- `.gitignore` — add `docs/data/` (raw exports carry PII — see Task 0).
- `docs/guide/usage.md` (or the drop-dir doc from 14.5) — add the chatgpt/ + gemini/ drop-dirs.
- `docs/research/chat-capture-spike.md` — check the ChatGPT + Gemini export follow-up boxes.
- `SUMMARY.md` + `.agents/plans/m14-general-ai-chat-capture.md` — mark 14.6 shipped.

---

## VERIFIED PHASE-0 FINDINGS (real files inspected during planning — the parser contracts)

> These were produced by structure-only inspection (string values truncated; no message content pulled
> into context) on 2026-07-21. They REPLACE the "executor runs Task 1 first" gate of 14.5 — the format
> is already verified. The executor still produces the **redacted fixtures** (Task 2) and writes parser
> bodies against them, but the field map is fixed below.

### ChatGPT — `docs/data/OpenAI/conversations.json` (4.7 MB)

- **File shape**: a **flat array of 63 conversation objects** (one export file, many sessions).
- **Conversation** keys: `conversation_id` (→ `sessionId` + attribution key), `title` (100% present),
  `create_time` / `update_time` (**Unix EPOCH SECONDS as float**, e.g. `1763306665.654753`),
  `default_model_slug` (e.g. `gpt-5-1`), `mapping` (the message store), `current_node`.
- **`mapping`**: an object keyed by node id; each node `{id, message, parent, children}`. **`children[]`
  arrays are EMPTY on 100% of nodes (verified 0 child-bearing nodes)** — so DO NOT tree-walk; **order
  messages by `message.create_time`** (present on 100% of messages). Each conversation has exactly **one
  null-`message` root node** (63 roots / 63 convos) — skip nodes with no `message`.
- **Message** keys: `id` (unique → `rawRecordId`), `author.role` (**only `user` (267) and `assistant`
  (746)** across the whole export — NO `system`/`tool`), `create_time` (epoch seconds, 0 nulls),
  `content:{content_type, parts[]}`, `metadata.model_slug`.
- **content_types** (whole export): `text` (591), `thoughts` (272), `reasoning_recap` (143),
  `multimodal_text` (7). `text` parts are strings; `multimodal_text` parts mix strings + objects
  (image/attachment refs).
- **Model IS present** (`metadata.model_slug`) — unlike Claude/Gemini. **Tokens/cost: none anywhere** →
  uncosted.
- **`metadata.is_visually_hidden_from_conversation` is undefined on all 1013 messages** — no hidden-flag
  filtering needed.

### Gemini — `docs/data/Gemini/MyActivity.json` (9.3 MB)

- **File shape**: a **flat array of 1452 activity records** (Google Takeout "My Activity → Gemini Apps",
  JSON format). NOT threaded conversations.
- **Record** keys (union): `header` ("Gemini Apps"), `title`, `time`, `products`, `activityControls`,
  `safeHtmlItem`, `subtitles`, `attachedFiles`, `imageFile`.
- **`title`** = `"Prompted <the user's prompt>"` for prompt records (1264), or `"Created…"`/`"Used…"`/
  `"Gave feedback…"` for non-conversation activity (188). **Prompt = `title` with the `"Prompted "`
  prefix stripped.**
- **Response** = `safeHtmlItem[0].html` (**HTML string**, may embed the model's reasoning). Present on
  **1255** "Prompted" records; **9** "Prompted" records have no response.
- **`time`** = ISO-8601 string (`2026-07-20T15:15:21.568Z`) — **already ISO**. **100% unique across all
  1452 records** (0 dupes; `(time+title)` also 1452-distinct).
- **NO id / uuid / titleUrl field anywhere** (verified: 0 records with any id/url key). → there is **no
  natural stable record id**; derive one deterministically (see Task 4).
- **NO conversation/thread grouping** — each record is a standalone prompt(+response) activity.
- `attachedFiles` (335 records) / `imageFile` (120) → attachments = **knownGap** (deferred).
- **No model, no tokens** → uncosted, model-less.

---

## STEP-BY-STEP TASKS (execute in order, top to bottom)

### Task 0 — GITIGNORE the raw exports (PII SAFETY — do FIRST)

- **UPDATE** `.gitignore`: add a line `docs/data/`. The real exports carry PII (the Gemini
  `safeHtmlItem` embeds personal reasoning/persona/correction-ledger content; ChatGPT carries full
  conversation bodies). They are currently **untracked but NOT ignored** (`git check-ignore` returns
  non-zero), i.e. one `git add -A` from being committed.
- **VALIDATE**: `git check-ignore docs/data/OpenAI/conversations.json` exits 0 (now ignored).

### Task 1 — CREATE the two connector objects + register (Layer A, no format risk)

- **MIRROR** `apps/collector/src/connectors/claude-export.ts` exactly, twice:
  - `apps/collector/src/connectors/chatgpt-export.ts`: `id: CHATGPT_EXPORT_CONNECTOR`,
    `captureMode:"snapshot"`, `watchGlobs:(home)=>[join(home,".420ai","chat-imports","chatgpt","*.json")]`,
    `parse:(text)=>parseChatgptExport(text)`, re-export the parser + consts from `@420ai/shared`.
    Fidelity: `status:"experimental"`, `captureMethod:"import-export-json"`, `liveness:"batch"`,
    **`tokens:"none"`, `cost:"none"`** (no token counts in the export even though the model IS known),
    `knownGaps` (see below), `requiredPermissions:["Read ChatGPT chat export files under
    ~/.420ai/chat-imports/chatgpt/*.json"]`, `testedVersions:[]`.
    - `knownGaps`: no token counts → uncosted; batch liveness (days-stale between manual exports);
      `thoughts`/`reasoning_recap` reasoning nodes and `multimodal_text` attachments are stored as raw
      records but not emitted as normalized events (deferred, not guessed); attribution is a synthetic
      `chat:chatgpt:<conversationId>` topic key, not a repo/git path.
  - `apps/collector/src/connectors/gemini-export.ts`: `id: GEMINI_EXPORT_CONNECTOR`,
    `watchGlobs:(home)=>[join(home,".420ai","chat-imports","gemini","*.json")]`,
    `parse:(text)=>parseGeminiExport(text)`. Fidelity: same skeleton, `tokens:"none"`, `cost:"none"`;
    `knownGaps`: Google Takeout "My Activity" is a **flat activity log with no conversation threading →
    each activity record is captured as its own single-turn session**; response body is HTML (search may
    include markup); no model, no tokens → uncosted; non-"Prompted" activity (image generation, feedback)
    is skipped; attachments (`attachedFiles`/`imageFile`) deferred; **records have no native id → the
    fingerprint key is derived from `time`+prompt** (stable while Google's activity `time` is stable).
    `requiredPermissions:["Read Gemini Takeout activity files under ~/.420ai/chat-imports/gemini/*.json"]`.
- **UPDATE** `connector.ts`: add `import { chatgptExportConnector } from "./chatgpt-export.js";` +
  `import { geminiExportConnector } from "./gemini-export.js";` (`:2-7` block) and append both to
  `connectors[]` (`:176-183`).
- **GOTCHA**: these files import parser consts from `@420ai/shared`, so Task 3/4 must define + barrel-
  export them first, OR create the parsers in the same pass. Recommended order: Task 3 (chatgpt parser)
  and Task 4 (gemini parser) BEFORE the `parse:` wiring compiles. If you scaffold connectors first,
  expect a red typecheck until the parsers + `index.ts` exports exist — that's fine mid-task.
- **VALIDATE** (after Tasks 3–5): `npm run typecheck` (exit 0).

### Task 2 — CREATE redacted fixtures from the real files

- **PRODUCE** `packages/shared/src/parsers/fixtures/sample-chatgpt-export.json`: a **small** (3–5
  conversation) subset of `docs/data/OpenAI/conversations.json`, structure-faithful but with **all
  message `parts` text replaced by short placeholders**. MUST cover: a normal user+assistant `text`
  conversation; an assistant turn with a `thoughts` and/or `reasoning_recap` node (to prove those are
  stored-raw-but-not-evented); a `multimodal_text` message; keep real-shaped `conversation_id`/message
  `id`/`create_time` (epoch)/`update_time`/`default_model_slug`/`metadata.model_slug`. Keep it a **flat
  array** (top-level).
- **PRODUCE** `packages/shared/src/parsers/fixtures/sample-gemini-export.json`: a **small** (5–8 record)
  subset of `docs/data/Gemini/MyActivity.json`, with **`title` prompts and `safeHtmlItem[].html`
  replaced by short placeholders** (the real HTML embeds PII — scrub aggressively). MUST cover: a
  "Prompted" record WITH `safeHtmlItem` response; a "Prompted" record with NO response; a non-"Prompted"
  record (e.g. `"Created …"`, to prove it's skipped); keep real-shaped `time` (unique ISO) + `header`.
- **GOTCHA**: fixtures are the parser test inputs AND are committed — they must be secret/PII-free. The
  raw `docs/data/` files are NOT committed (Task 0).
- **VALIDATE**: `node -e "JSON.parse(require('fs').readFileSync('packages/shared/src/parsers/fixtures/sample-chatgpt-export.json','utf8')); JSON.parse(require('fs').readFileSync('packages/shared/src/parsers/fixtures/sample-gemini-export.json','utf8')); console.log('ok')"`
  (both parse). `git grep -nI -e 'Sean Wright' -e 'EH&S' packages/shared/src/parsers/fixtures/` returns
  nothing (spot-check the redaction; extend patterns as needed).

### Task 3 — CREATE `chatgpt-export.ts` parser (against the fixture)

- **CONSTS**: `export const CHATGPT_EXPORT_CONNECTOR = "chatgpt-export";` +
  `export const CHATGPT_EXPORT_PARSER_VERSION = "1.0.0";`.
- **SIGNATURE**: `export function parseChatgptExport(fileText: string, opts?: { ingestedAt?: string }):
  ParseResult` — mirror `parseClaudeExport`.
- **BODY** (per the verified map):
  - Tolerant `JSON.parse` try/catch → `{rawRecords:[],events:[],skippedLines:1}`. Accept a flat array;
    defensively accept `{conversations:[…]}`; else `skippedLines:1` (mirror claude-export `:96-106`).
  - Per conversation: `sessionId = conversation_id` (string, non-empty) — else `skippedLines++`, skip.
    `projectPath = chat:chatgpt:${sessionId}`. `title = conversation.title` (for the `session.started`
    payload).
  - `session.started` with ts = **`epochToIso(conversation.create_time)`** and payload `{title}` if
    title non-empty. `session.ended` with ts = `epochToIso(conversation.update_time ?? create_time)`.
    Both reference `rawRecordId = ${sessionId}:session` (mirror claude-export).
  - Collect `Object.values(mapping)` where `node.message` is present; **sort ascending by
    `message.create_time`** (nulls last, but there are none). For each message node, in order:
    - **Push a raw record** for EVERY message node (raw is sacred): `{id: message.id, sourceConnector:
      CHATGPT_EXPORT_CONNECTOR, sessionId, ingestedAt, payload: JSON.stringify(message)}`. Fallback id
      `${sessionId}:msg:${orderIndex}` only if `message.id` missing (defensive; verified always present).
    - **Emit a normalized event ONLY for `content_type` in {`text`, `multimodal_text`}**. `eventType`
      from `author.role`: `user`→`message.user`, `assistant`→`message.assistant` (any other role → no
      event, raw kept). Stamp `model` = `message.metadata.model_slug ?? conversation.default_model_slug`
      on the event. eventIndex 0. `ts = epochToIso(message.create_time)`. **NO tokens/cost/catalogVersion.**
    - `thoughts` / `reasoning_recap` nodes → raw kept, **no event** (knownGap).
  - Reuse a `makeEvent` closure like `claude-export.ts:133-151` but stamping `model` (like
    `gemini-cli.ts:114-134`).
- **`epochToIso` helper** (LOCAL to this parser — ChatGPT is the only epoch-seconds surface):
  ```ts
  // ChatGPT create_time/update_time are Unix EPOCH SECONDS as float (verified,
  // e.g. 1763306665.654753). Convert to canonical ms-ISO; guard NaN/missing → fallback.
  function epochToIso(sec: number | undefined, fallback: string): string {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return fallback;
    return new Date(sec * 1000).toISOString();
  }
  ```
  **GOTCHA**: multiply by 1000 (seconds→ms). `ts` is not a fingerprint input, so precision is
  immaterial to dedup, but a raw `new Date(sec)` would emit 1970 timestamps.
- **GOTCHA**: `rawRecordId` = `message.id` MUST be stable across re-imports (snapshot re-reads the whole
  file) or the fingerprint churns — verified unique + present. Never key on `Object.keys` iteration order.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 4 — CREATE `gemini-export.ts` parser (against the fixture)

- **CONSTS**: `export const GEMINI_EXPORT_CONNECTOR = "gemini-export";` +
  `export const GEMINI_EXPORT_PARSER_VERSION = "1.0.0";`.
- **SIGNATURE**: `export function parseGeminiExport(fileText: string, opts?: { ingestedAt?: string }):
  ParseResult`.
- **BODY** (per the verified map):
  - Tolerant `JSON.parse` try/catch → `{rawRecords:[],events:[],skippedLines:1}`. Require a top-level
    array; else `skippedLines:1`.
  - For each record: **process ONLY records where `header === "Gemini Apps"` AND `title` starts with
    `"Prompted "`.** Skip all others silently (non-conversation activity — do NOT inflate `skippedLines`;
    they are intentional skips, mirroring `gemini-cli.ts:191`'s "info type carries no event").
  - **Derive a deterministic stable key** (there is no native id): `key =
    createHash("sha256").update(`${record.time}|${record.title}`).digest("hex").slice(0, 32)`. Import
    `createHash` from `node:crypto` (same module `fingerprint.ts` uses). Rationale: `time` is 100%
    unique + stable across re-exports (verified); hashing `time|title` is collision-safe and keeps the
    fingerprint invariant across re-imports. A record missing `time` → `skippedLines++`, skip (can't key).
  - `sessionId = gemini-${key}`. `projectPath = chat:gemini:${key}`.
  - **One raw record** for the whole activity entry: `{id: key, sourceConnector: GEMINI_EXPORT_CONNECTOR,
    sessionId, ingestedAt, payload: JSON.stringify(record)}` (verbatim — sacred; holds prompt + HTML
    response).
  - Emit, all referencing `rawRecordId = key`, eventIndex 0, distinct `eventType` (→ distinct
    fingerprints — verified fingerprint hashes connector|rawId|index|eventType):
    - `session.started`, ts = `normalizeTs(record.time)`, payload `{title}` where `title` = the prompt
      (`record.title` minus the `"Prompted "` prefix), bounded to a sane length (e.g. 200 chars).
    - `message.user`, ts = `normalizeTs(record.time)`.
    - `message.assistant`, ts = `normalizeTs(record.time)` — **ONLY IF** `safeHtmlItem?.[0]?.html` is a
      non-empty string.
    - `session.ended`, ts = `normalizeTs(record.time)`.
  - **NO model, NO tokens/cost/catalogVersion** (uncosted, model-less).
  - `normalizeTs` = the guarded ISO helper (copy `claude-export.ts:63-68`): Gemini `time` is already ISO
    but re-emit through `new Date().toISOString()` and fall back to `ingestedAt` on unparseable/missing.
- **GOTCHA**: each record → its own session by design (no threading exists in MyActivity). This is the
  honest representation; grouping is a user-side `workspace_keys` concern, not a parser guess. Document
  it in `knownGaps` (Task 1) so it's not read as a bug.
- **GOTCHA**: the response HTML is stored verbatim in the raw record — do NOT strip it in the parser
  (raw is sacred; downstream redaction/render handles it). Search-includes-markup is a declared knownGap.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 5 — UPDATE the shared barrel + verify registration compiles

- **UPDATE** `packages/shared/src/index.ts`: add `export * from "./parsers/chatgpt-export.js";` and
  `export * from "./parsers/gemini-export.js";` after the claude-export line (`:26`).
- **VALIDATE**: `npm run typecheck` (exit 0) — now the collector connector wrappers (Task 1) resolve
  `parseChatgptExport`/`parseGeminiExport` + the consts.

### Task 6 — CREATE the parser unit tests (fixture-based — the load-bearing layer)

- **MIRROR** `claude-export.test.ts`. `chatgpt-export.test.ts` asserts, over the fixture:
  - correct counts by type; every conversation → 1 `session.started` + 1 `session.ended`; `message.user`
    / `message.assistant` counts match the `text`+`multimodal_text` user/assistant nodes only (thoughts/
    reasoning_recap produce **raw records but no events** — assert `rawRecords.length > events` and that a
    known thoughts node's id appears in `rawRecords` but not in any event's `rawRecordId`).
  - **ISO timestamps** (assert a `session.started.ts` equals the expected `new Date(create_time*1000)
    .toISOString()` — proves the epoch×1000 conversion).
  - `model` present on assistant events (from `model_slug`); **NO `tokens`/`cost`/`catalogVersion` on any
    event**; `projectPath === chat:chatgpt:<conversation_id>`.
  - **fingerprint stability**: re-parsing the SAME fixture yields IDENTICAL fingerprints (dedup
    invariant); a truncated/garbage input → `skippedLines >= 1`, no throw.
- `gemini-export.test.ts` asserts:
  - a "Prompted" record with a response → `session.started`+`message.user`+`message.assistant`+
    `session.ended` (4 events, 1 raw record); a "Prompted"-no-response record → 3 events (no assistant);
    a non-"Prompted" record → **0 events, 0 raw records** (skipped, not counted in `skippedLines`).
  - ISO `ts`; NO model/tokens/cost; `projectPath === chat:gemini:<key>`; **identical fingerprints on
    re-parse** (proves the derived key is stable); garbage input → `skippedLines >= 1`, no throw.
- **VALIDATE**: `npx vitest run packages/shared/src/parsers/chatgpt-export.test.ts
  packages/shared/src/parsers/gemini-export.test.ts` (all pass).

### Task 7 — UPDATE docs + milestone/spike

- Add the `chatgpt/` + `gemini/` drop-dirs to the 14.5 drop-dir doc (`docs/guide/usage.md` — confirm the
  exact file 14.5 used). Check the ChatGPT + Gemini export follow-up boxes in
  `docs/research/chat-capture-spike.md`. Note in `m14-general-ai-chat-capture.md` + `SUMMARY.md` that
  14.6 shipped both connectors (uncosted, experimental, topic-attributed; ChatGPT model-attributed).
- **VALIDATE**: `npx prettier --check` on the changed docs (CI lints markdown — see memory).

---

## TESTING STRATEGY

### Unit Tests (load-bearing)

Fixture-based parser tests (Task 6) are the correct + sufficient correctness layer — the parsers are
pure. Key assertions: fingerprint stability on re-parse (dedup), uncosted (0 usage/cost), ISO ts (incl.
the ChatGPT epoch×1000 conversion), model-present (ChatGPT) / model-absent (Gemini), tolerant parse,
`thoughts`/`reasoning_recap` raw-kept-but-not-evented (ChatGPT), non-"Prompted" skipped (Gemini),
Gemini derived-key stability.

### Integration Tests

**No new DB/ingest/server code** (attribution + insert reuse the verified-nullable paths 14.5 exercised),
so no new `*.int.test.ts` is required. Still run `repo-health -- --require-db` before milestone sign-off
per `CLAUDE.md` (the event pipeline is exercised by the existing int suite).

### Edge Cases

Multi-conversation ChatGPT file; conversation with only a root node (no messages); a `thoughts`-only
assistant turn; `multimodal_text` with object-only parts; Gemini "Prompted"-no-response; non-"Prompted"
activity; mid-copy/truncated file (tolerant → `skippedLines`); re-importing the identical export
(idempotent — same fingerprints, server upsert dedups).

---

## VALIDATION COMMANDS (GATES — from repo root)

### Level 1: Syntax & Style
- `npm run typecheck` — root `tsc -b`, **exit 0**. Covers `packages/shared` (parsers) + `apps/collector`
  (connectors) — both in the root graph.
- `npm run lint` and `npx prettier --check <changed files>` — CI lints these (memory: not in
  repo-health). Expect clean.

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/parsers/chatgpt-export.test.ts
  packages/shared/src/parsers/gemini-export.test.ts` — all pass.
- `npm test` — full vitest suite green (no regressions).

### Level 3: Gate
- `npm run repo-health` — **PASS** (typecheck + full vitest + NUL/stray-artifact scans; the fixture JSON
  must be valid UTF-8, caught by the NUL scan).
- Before milestone sign-off: `npm run db:up && npm run db:migrate` then
  `npm run repo-health -- --require-db` — **PASS, 0 int tests skipped** (`CLAUDE.md` gate; the test DB
  needs its own migrate per memory).

### Level 4: Manual Validation (live)
- Create `~/.420ai/chat-imports/chatgpt/` and `~/.420ai/chat-imports/gemini/`; drop the real (or a
  redacted) export into each; run `npx tsx apps/collector/src/cli.ts watch`. Approve the two new capture
  surfaces if the §10.4 approval gate prompts. Confirm the chat sessions' events reach ingest and appear
  in the Monitor/Search, labeled `experimental`/`batch`/uncosted; ChatGPT assistant events carry a
  `model`. Re-drop the same file → 0 new events (idempotent).

---

## ACCEPTANCE CRITERIA

- [ ] `docs/data/` gitignored (raw PII exports never committable); only redacted fixtures committed.
- [ ] `chatgpt-export` + `gemini-export` connectors registered, `captureMode:"snapshot"`, drop-dir
      globs, `experimental`/`batch`/`tokens:"none"`/`cost:"none"` fidelity with honest `knownGaps` +
      `requiredPermissions`.
- [ ] ChatGPT parser: flat-array of conversations; messages ordered by `create_time`; `text`/
      `multimodal_text` → `message.*` events, `thoughts`/`reasoning_recap` raw-kept-no-event; epoch→ISO
      (×1000); `model` from `model_slug`; NO tokens/cost; `chat:chatgpt:<id>` attribution.
- [ ] Gemini parser: flat activity log; only "Prompted" records → one single-turn session each; derived
      stable key from `time|title`; response from `safeHtmlItem[0].html`; ISO ts; NO model/tokens/cost;
      non-"Prompted" skipped without inflating `skippedLines`; `chat:gemini:<key>` attribution.
- [ ] **Fingerprint invariant untouched** (`fingerprint.ts` unchanged); re-parsing either export yields
      identical fingerprints (dedup holds).
- [ ] No DB schema change, no ingest/server change, no cost-model change (uncosted).
- [ ] Parser unit tests pass over the redacted fixtures; `repo-health` PASS; `--require-db` 0 skipped;
      lint + prettier clean.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task validation passed immediately.
- [ ] Full suite (unit + int) passes; no typecheck/lint errors.
- [ ] Manual live drop-dir test confirms both surfaces capture end-to-end.
- [ ] Fixtures verified PII-free.
- [ ] Docs + milestone/spike updated.

---

## NOTES

### Design decisions (resolved — do not re-litigate at implementation time)

- **Two connectors, one slice** — mirrors 14.5's two-surface (ChatGPT+Claude) structure; both share the
  identical shipped `snapshot` drop-dir framework.
- **ChatGPT ordering by `create_time`, not tree-walk** — the `mapping` `children[]` arrays are empty
  (verified 0 child-bearing nodes across 63 convos), so `parent`-only links can't be walked forward;
  `create_time` is present on 100% of messages and is the reliable order.
- **Skip `thoughts`/`reasoning_recap` as events (keep as raw)** — parity with `claude-export` deferring
  thinking/tool blocks; these are the model's internal reasoning, not the delivered message. Raw is
  sacred → still stored, re-derivable if a later parser version wants them.
- **Gemini: one session per activity record** — Takeout "My Activity" has NO conversation threading and
  NO record id. Each record → a single-turn session keyed by a deterministic `sha256(time|title)` slice.
  This is the honest representation; topic/work-session grouping is a user-side `workspace_keys` mapping,
  not a parser heuristic (which would be a guess).
- **Both uncosted; ChatGPT model-attributed** — ChatGPT export carries `model_slug` but no token counts,
  so `model` is stamped but `tokens:"none"`/`cost:"none"` (no `usage.reported`/`cost.estimated`, no
  `catalogVersion`). Gemini carries neither.

### Spikes actually RUN during planning (evidence for the confidence score)

1. **Structure-only inspection of BOTH real exports** (`docs/data/OpenAI/conversations.json`,
   `docs/data/Gemini/MyActivity.json`) via `node` scripts that truncate string values — produced the
   entire "Verified Phase-0 Findings" section above (file shape, key maps, role/content-type histograms,
   epoch-seconds format, Gemini `time` 100%-unique + no-id fact, response-in-`safeHtmlItem`, prompt-in-
   `title`). This is the 14.5 Task-1 gate, already satisfied — the parser field maps are verified, not
   guessed.
2. **Verified every referenced symbol by reading source**: `ParseResult` (`parse-result.ts`),
   `eventFingerprint` + its `node:crypto createHash` (`fingerprint.ts`), `EventType`/`NormalizedEvent`/
   `RawSourceRecord` (`events.ts:26-75`), the `Connector` interface + `connectors[]` registry
   (`connector.ts:127-183`), the shipped `claude-export` connector + parser (the exact mirror), the
   `gemini-cli` `makeEvent` model-stamping pattern, the `index.ts:25-26` barrel lines.
3. **Confirmed the test/fixture harness exists**: `claude-export.test.ts` (the `readFileSync(new
   URL("./fixtures/…"))` + vitest pattern) and the real fixture dir
   `packages/shared/src/parsers/fixtures/` (NOT `__fixtures__` — corrected from the 14.5 plan text).
4. **Confirmed the PII/gitignore risk**: `docs/data/` is untracked but `git check-ignore` returns
   non-zero → committable. Task 0 fixes it.

### Confidence

- **ChatGPT connector: 9.6/10** — clean verified format; mirrors the shipped `claude-export` plus three
  verified deltas (epoch×1000, order-by-`create_time`, skip reasoning nodes) and `model_slug` stamping.
- **Gemini connector: 9.3/10** — feasible + fully verified, but a genuinely new parser shape (flat
  activity log, no threading, derived id). The one-session-per-record design is the only honest
  representation MyActivity supports; the derived key is provably stable (`time` 100% unique). Residual:
  HTML-in-body search-markup (declared knownGap, not a blocker) and the product-level "is per-record-
  session the right UX" question (honest default; revisitable via `workspace_keys`).
- **Overall: 9.4/10** — additive, mirrors a verified in-repo precedent, zero change to load-bearing
  wiring/invariants (`fingerprint.ts`, ingest, schema all untouched), every symbol verified by reading
  source, both formats verified against real data, test harness confirmed.
