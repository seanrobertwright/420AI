# Feature: M14 Slice 14.5 — Chat export-file connectors (ChatGPT + Claude)

> Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (event/fingerprint invariants, raw-records-sacred,
> validation gate). Milestone + spike:
> [`m14-general-ai-chat-capture.md`](./m14-general-ai-chat-capture.md) (slice 14.5, D-M14-2) and
> [`docs/research/chat-capture-spike.md`](../../docs/research/chat-capture-spike.md) (the 14.0 spike
> that shapes this slice). This plan links, not re-pastes.

## Feature Description

Capture ChatGPT and Claude **chat** conversations (distinct from the Claude Code / Codex / Gemini
**coding-tool** connectors already shipped) by snapshot-parsing the surfaces' **official data
exports**. The 14.0 spike proved none of the three chat surfaces persist a local conversation store —
so batch export files are the only feasible first pipe (a browser extension is the later 14.7 path).
Exports are whole-file JSON; the existing **`snapshot` capture mode** (Gemini's precedent) ingests
them with **zero framework change** — the only new code is a connector object + a pure parser per
surface.

Chat conversations have **no cwd/git and no token counts**, so this slice also does the milestone's
one taxonomy-level design task — **non-repo attribution** (Work-Session/topic grouping) — and labels
chat events honestly: `experimental`, `batch` liveness, **uncosted** (settled with the user).

### The Phase-0 gate (why this plan is deliberately two-layered)

The spike marks all three export formats **[documented], not [verified]** and names, as its #1 open
follow-up, *"live-verify all three export flows end-to-end before 14.5 planning locks the parser
contracts."* A parser field-extraction map written against an unobserved format is a guess. So this
plan splits along that seam (agreed with the user):

- **Layer A — fully specified now (high confidence):** the connector objects, the snapshot/drop-dir
  wiring, the parser *skeleton + contract* (what events each parser MUST emit, tolerant parsing,
  stable `rawRecordId`, fingerprint safety, uncosted labeling), the non-repo attribution design, and
  the test harness shape.
- **Layer B — GATED behind Task 1 (a Phase-0 the executor runs FIRST):** the exact JSON field paths
  each parser reads. Task 1 produces a **real, redacted export fixture** per surface; the parser
  bodies and their fixture-based unit tests are written against that fixture, not against docs.

**The executor MUST complete Task 1 before writing any parser body.** If a surface's export cannot be
obtained, ship the other surface and record the gap (12.7d "ship-what's-feasible" discipline) — do NOT
implement a parser from documentation alone.

## User Story

As the self-hosting admin
I want to import my ChatGPT and Claude chat exports and have them captured as sessions/events
So that my AI chat history is searchable and analyzable in the same archive as my coding-tool activity,
grouped by topic since there's no repo to attribute it to.

## Problem / Solution

**Problem:** chat conversations live only server-side; the existing connectors capture coding tools
only. No dashboard/archive visibility into ChatGPT/Claude chat usage.

**Solution:** two `snapshot`-mode connectors over a user drop-dir (`~/.420ai/chat-imports/<surface>/`),
each wrapping a pure parser that maps the export JSON onto the **existing** `NormalizedEvent` taxonomy
(no fingerprint change, no schema change). Events land unattributed or under a synthetic topic key
mapped via the existing `workspace_keys` alias mechanism. Uncosted, experimental, honest `batch`
liveness.

## Feature Metadata

**Feature Type**: New Capability (additive connectors)
**Estimated Complexity**: Medium (Layer A) + External-dependency gate (Layer B parsers)
**Primary Systems Affected**: `packages/shared` (new parsers) + `apps/collector` (new connectors).
No DB schema change; no ingest/server change; fingerprint untouched.
**Dependencies**: real export samples (Task 1 Phase-0) — external, user-supplied.

---

## CONTEXT REFERENCES — READ BEFORE IMPLEMENTING

- `apps/collector/src/connectors/connector.ts:103-136` — the `Connector` interface (`id`,
  `captureMode?: "tail"|"snapshot"|"poll"`, `fidelity`, `watchGlobs(home)`, `parse(fileText)`,
  optional `discoverRoots`/`poll`). `ConnectorFidelity` `:26-44`; `Liveness` `:23-24`. Registry array
  `connectors` `:142-147` (append a connector — "no framework change", per `:11-13`).
- `apps/collector/src/connectors/gemini-cli.ts:64-86` — THE precedent to mirror: `captureMode:
  "snapshot"`, `watchGlobs` `:15-17`, `parse` delegates to the pure shared parser, `discoverRoots`
  optional. Copy this shape.
- `packages/shared/src/parsers/gemini-cli.ts` — the pure parser to mirror: signature `(fileText:
  string, opts?) => ParseResult` `:96`; `makeEvent` builder `:114-134` (stamps `eventFingerprint`,
  `parserVersion`, `sessionId`, `ts`); tolerant parse returns `{rawRecords:[],events:[],skippedLines:1}`
  on bad JSON `:104-107`; stable `rawRecordId` keyed on a message id `:145-147`; parserVersion const
  `:19-22`. Emits `session.started`/`message.user`/`message.assistant`/`usage.reported`+`cost.estimated`
  (tokens present only)/`session.ended`.
- `packages/shared/src/parsers/parse-result.ts:13-19` — `ParseResult` contract.
- `packages/shared/src/events.ts:26-39` — `EventType` union (use `session.started`, `message.user`,
  `message.assistant`, `session.ended`; tool events only if the export carries them). `:57-75`
  `NormalizedEvent` (`projectPath?`/`gitBranch?`/`tokens?`/`cost?` all OPTIONAL).
- `packages/shared/src/fingerprint.ts` (whole) — INVARIANT. Inputs: `sourceConnector | rawRecordId |
  eventIndex | eventType`. No git/cwd/ts. A chat event needs only a **stable per-message id** as
  `rawRecordId`. Do NOT change this file.
- Non-repo attribution (all nullable/optional — chat events land unattributed cleanly):
  `packages/db/src/schema.ts:149-150` (`project_path`/`git_branch` nullable), `apps/ingest/src/schemas.ts:64-84`
  (`projectPath` NOT required), `packages/db/src/repositories/ingest.ts:70-84` (passthrough → NULL),
  `packages/db/src/repositories/workspaces.ts:116-128` (`resolveWorkspaceId` → undefined for unknown
  key, never throws). The `workspace_keys` alias (`schema.ts:231-249`) maps an emitted `project_key`
  (== `events.projectPath`) to a workspace — the SAME mechanism that maps Gemini's opaque `projectHash`.
- Capture wiring (ALREADY complete — no change): `apps/collector/src/watcher/file-watcher.ts:57-85`
  (snapshot dispatch), `.../snapshot.ts:36-49` (whole-file re-read on size/mtime change; idempotent via
  content-hash dedup + server fingerprint upsert), `apps/collector/src/capture-engine.ts:187-197`
  (`onChange` → `connector.parse(text)` → enqueue). `discover()` `:37-54` globs every connector each
  tick, so a dropped file is auto-picked-up.
- 12.7b approval gate: a new connector reading a new surface is a **Capture Surface Change** — its
  `requiredPermissions` are declared on the fidelity and reviewed/approved (`connector.ts:35-41`).

### New Files to Create

- `packages/shared/src/parsers/chatgpt-export.ts` (+ `.test.ts`) — pure parser, id `chatgpt-export`.
- `packages/shared/src/parsers/claude-export.ts` (+ `.test.ts`) — pure parser, id `claude-export`.
- `apps/collector/src/connectors/chatgpt-export.ts` — connector object (thin wrapper).
- `apps/collector/src/connectors/claude-export.ts` — connector object (thin wrapper).
- `packages/shared/src/parsers/__fixtures__/chatgpt-export.sample.json`,
  `.../claude-export.sample.json` — **redacted real export samples from Task 1** (the parser test
  inputs). Must be scrubbed of secrets/PII before committing.

### Files to Update

- `packages/shared/src/index.ts` — export the two new parsers + their version/id consts (mirror the
  Gemini export line).
- `apps/collector/src/connectors/connector.ts` — append the two connectors to `connectors[]` (`:142`).
- `scripts/CATALOG-SIGNING.md` or a new `docs/guide/` note — document the import drop-dir workflow
  (where to place export files). (Confirm the right doc during implementation.)
- `docs/research/chat-capture-spike.md` — check the two Task-1 follow-up boxes once verified.

---

## STEP-BY-STEP TASKS (STRICT ORDER — Task 1 gates everything)

### 1. PHASE-0 GATE — obtain + inspect a real export per surface (DO THIS FIRST)

- **ChatGPT**: request Settings → Data controls → Export data; unzip the emailed archive; locate
  `conversations.json`. **Claude**: Settings → Privacy → Export data; locate `conversations.json`.
- **INSPECT** each file's actual shape and RECORD, in this plan's NOTES (or a scratch note the
  parser cites): the conversation container shape, the per-message node shape, the **stable message
  id** field (→ `rawRecordId`), the role field (→ `message.user`/`message.assistant`), the timestamp
  field + format (→ `ts`, normalize to ISO), the model field if any (ChatGPT: `metadata.model_slug`),
  and a conversation id + title (→ `sessionId` + the topic-attribution key). ChatGPT's export is a
  `mapping` node tree (walk it in create order); Claude's is a flatter message list — CONFIRM against
  the real file, do not assume.
- **PRODUCE** a redacted fixture per surface under `__fixtures__/` (scrub all message text/PII to
  short placeholders, keep structure + ids + timestamps + roles + model). These fixtures are the
  parser unit-test inputs.
- **GATE**: if a surface's export can't be obtained, SKIP that surface's parser (Tasks 2–3 for it),
  ship the other, and record the gap. Do NOT proceed to its parser body without a fixture.
- **VALIDATE**: fixtures exist and are secret-free (`git grep` for obvious secret patterns; the
  redaction is manual since these are test inputs, not pipeline data).

### 2. CREATE the pure parsers (bodies written against the Task-1 fixtures)

- **IMPLEMENT** `chatgpt-export.ts` / `claude-export.ts` mirroring `gemini-cli.ts`'s structure:
  - Consts: `export const CHATGPT_EXPORT_CONNECTOR = "chatgpt-export";` + `..._PARSER_VERSION =
    "1.0.0";` (same for Claude).
  - `export function parseChatgptExport(fileText: string, opts?: { ingestedAt?: string }): ParseResult`.
    Tolerant: wrap `JSON.parse` in try/catch → on failure return `{rawRecords:[],events:[],
    skippedLines:1}` (never throw). A whole export may contain MANY conversations → emit one session
    per conversation (see below) within the single ParseResult, or (if the collector drops one file
    per conversation) one session per file — DECIDE based on Task-1's observed file shape; document it.
  - For each conversation: `sessionId` = the export's stable conversation id. For each message (in
    create order): build a `rawRecord` (the verbatim message node — raw records are SACRED) with a
    stable `sourceRecordId` = the message id, and a `NormalizedEvent` via the `makeEvent` pattern:
    `eventFingerprint(CONNECTOR, rawRecordId, eventIndex, eventType)`, `eventType` from role, `ts`
    ISO-normalized, `model` when present (ChatGPT), **NO `tokens`/`cost`** (uncosted — do NOT emit
    `usage.reported`/`cost.estimated`). Emit `session.started` (first) + `session.ended` (last) per
    conversation, mirroring Gemini `:139`/`:197`.
  - **Non-repo attribution**: set `projectPath` = a synthetic topic key `chat:<surface>:<conversationId>`
    (stable, so the user can alias it to a workspace via `workspace_keys` — the Gemini `projectHash`
    mechanism). This is the "Work-Session/topic grouping" design: each conversation is its own
    work-session; grouping several conversations under a topic is a user-side `workspace_keys` mapping,
    no code. `gitBranch` omitted.
  - **Fidelity honesty**: the parser emits nothing it can't source — no tokens, no tool calls unless
    the export carries them.
- **GOTCHA**: `rawRecordId` MUST be stable across re-imports (the file is re-read wholesale on every
  snapshot change) or the fingerprint churns and dedup breaks — key it on the export's own message id,
  never on array position alone. ISO-normalize timestamps (the export's epoch/string → ISO) — do not
  emit a non-ISO `ts`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 3. CREATE the connector objects + register

- **IMPLEMENT** `apps/collector/src/connectors/chatgpt-export.ts` / `claude-export.ts` mirroring
  `gemini-cli.ts:64-86`:
  - `captureMode: "snapshot"`.
  - `watchGlobs: (home) => [join(home, ".420ai", "chat-imports", "chatgpt", "*.json")]` (Claude:
    `.../claude/*.json`). Separate subdirs so each file routes to the right parser.
  - `fidelity`: `status: "experimental"`, `captureMethod: "import-export-json"`, `liveness: "batch"`,
    `tokens: "none"`, `cost: "none"`, `knownGaps` (e.g. "no token counts in export → uncosted", "batch
    — days-stale between exports", "attribution is topic-key only, no repo/git"), `requiredPermissions`
    (e.g. "Read ChatGPT export files under ~/.420ai/chat-imports/chatgpt/*.json"), `testedVersions: []`.
  - `parse: (text) => parseChatgptExport(text)`. OMIT `discoverRoots` (no filesystem roots).
  - Append both to `connectors[]` (`connector.ts:142`).
- **GOTCHA**: `join`/`home` — globs are absolute with `~` pre-expanded to `home` (per the interface
  doc). The drop-dir must exist for the glob to match; document that the user creates it (or the
  collector `mkdir`s it — confirm the watcher tolerates a missing dir; Gemini's globs tolerate absent
  dirs today).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 4. Parser unit tests (fixture-based — the load-bearing layer)

- **IMPLEMENT** `chatgpt-export.test.ts` / `claude-export.test.ts` (co-located, no infra — mirror
  `gemini-cli.test.ts` if present, else `claude-code.test.ts`): load the Task-1 fixture, run the
  parser, assert: correct event count + types; stable fingerprints (snapshot a couple, and assert
  re-parsing the SAME fixture yields IDENTICAL fingerprints — the dedup invariant); ISO timestamps;
  `model` present (ChatGPT) / absent (Claude); NO `tokens`/`cost` on any event; `sessionId` +
  synthetic `projectPath` topic key correct; a truncated/garbage input returns `skippedLines >= 1`
  and does not throw.
- **VALIDATE**: `npx vitest run packages/shared/src/parsers/chatgpt-export.test.ts
  packages/shared/src/parsers/claude-export.test.ts` (all pass).

### 5. UPDATE docs + milestone/spike

- Document the import drop-dir workflow (where to place export files); check the two Task-1 boxes in
  `docs/research/chat-capture-spike.md`; note in the milestone doc that 14.5 shipped ChatGPT+Claude
  export connectors (uncosted, experimental, topic-attributed), Gemini is 14.6, extension is 14.7.
- **VALIDATE**: `npx prettier --check` on the changed docs.

---

## TESTING STRATEGY

- **Unit (load-bearing here)**: fixture-based parser tests (Task 4) — the parser is pure, so unit
  tests over a real redacted fixture are the correct and sufficient correctness layer, exactly as the
  existing connector parsers are tested. Fingerprint-stability + uncosted + ISO-ts + tolerant-parse are
  the key assertions.
- **Integration**: no NEW DB/ingest code (attribution + insert reuse verified-nullable paths), so no
  new `*.int.test.ts` is strictly required. OPTIONAL end-to-end: drop a fixture into the drop-dir on a
  live collector and confirm events land unattributed and are searchable (manual, Level 4). Run
  `repo-health -- --require-db` before MILESTONE sign-off per `CLAUDE.md` (the event pipeline is
  exercised), even though this slice adds no DB code.
- **Edge cases**: multi-conversation export file; a conversation with zero messages; a mid-rewrite /
  truncated file (tolerant → skippedLines); re-importing the identical export (idempotent — same
  fingerprints, server upsert dedups).

---

## VALIDATION COMMANDS (GATES — from repo root)

1. **Level 1 — root typecheck**: `npm run typecheck` (exit 0). Covers shared (parsers) + collector
   (connectors) — both in the root graph.
2. **Level 2 — unit**: `npm test` (all pass, incl. the new parser fixtures).
3. **Level 3 — gate**: `npm run repo-health` (PASS — typecheck + vitest + hygiene scans; the
   fixture JSON must be valid UTF-8, caught by the NUL scan). Run `repo-health -- --require-db` before
   milestone sign-off.
4. **Lint + format** (CI-only, per memory): `npm run lint` and `npx prettier --check` changed files.
5. **Level 4 — manual (live)**: create `~/.420ai/chat-imports/chatgpt/`, drop a real (or fixture)
   export, run `collector watch`, confirm the chat session's events reach ingest, appear in the
   Monitor/Search, and are correctly labeled `experimental`/`batch`/uncosted; approve the connector's
   capture surface if the approval gate prompts.

---

## ACCEPTANCE CRITERIA

- [ ] **Task 1 done first**: a real (redacted) export fixture exists per shipped surface; parser
      bodies were written against it, not documentation.
- [ ] `chatgpt-export` + `claude-export` connectors registered, `captureMode:"snapshot"`, drop-dir
      globs, `experimental`/`batch`/`tokens:"none"`/`cost:"none"` fidelity with honest `knownGaps` +
      `requiredPermissions`.
- [ ] Parsers map exports onto the existing taxonomy: `session.started`/`message.*`/`session.ended`,
      stable `rawRecordId` (message id), ISO `ts`, `model` when present, NO tokens/cost.
- [ ] **Fingerprint invariant untouched** (`fingerprint.ts` unchanged); re-parsing the same export
      yields identical fingerprints (dedup holds).
- [ ] Non-repo attribution: events carry a synthetic `chat:<surface>:<conversationId>` topic key (or
      land cleanly unattributed); no git/cwd required; pipeline tolerates it (verified nullable).
- [ ] No DB schema change, no ingest/server change, no cost-model change (uncosted).
- [ ] Parser unit tests pass over the real fixtures; `repo-health` PASS; lint + prettier clean.
- [ ] If a surface's export was unobtainable, it's skipped + the gap recorded (never guessed).

## NOTES

### Task-1 findings — Claude export (VERIFIED 2026-07-20 against a real 16.7 MB `conversations.json`, 71 conversations / 480 messages)

Inspected structure-only (string values truncated) — no message content pulled into context.

- **File shape**: top-level is a **flat `array` of conversation objects** (NOT `{conversations:[…]}`). One
  export file carries MANY conversations → the parser emits **one session per conversation within a single
  `ParseResult`** (the collector drops one file; `captureMode:"snapshot"` re-reads it whole).
- **Conversation object**: `uuid` (100% present, unique) → `sessionId` + attribution key; `name`
  (conversation title, **absent on 2/71** — tolerate); `summary` (long text); `created_at`/`updated_at`
  (ISO-8601 **microsecond** precision, e.g. `2025-08-07T15:32:40.100663Z`); `account:{uuid}` (the user's
  account id — **scrubbed in the fixture**); `chat_messages: []`.
- **Message node**: `uuid` (480/480 present, **all unique across the file** → stable `rawRecordId`,
  fingerprint-invariant across re-imports); `sender` ∈ `{human, assistant}` (→ `message.user`/`message.assistant`);
  `created_at` (ISO micros, 480/480 present, already in create order — 0 out-of-order); `text`; `content[]`
  blocks `{start_timestamp, stop_timestamp, flags, type, text, citations}`; `attachments[]`; `files[]`;
  `parent_message_uuid`.
- **Model**: NONE at conversation or message level → `model` omitted (matches spike: Claude export model ✗).
- **Tokens/cost**: none → uncosted (settled).
- **Content-block types observed**: `text, thinking, tool_use, tool_result, token_budget`. The export DOES
  carry tool activity, BUT the `tool_use`/`tool_result`/`files`/`attachments` block shapes were NOT verified
  in this pass → per the Phase-0 gate, tool-lifecycle + file-interaction events are **deferred (knownGap)**,
  NOT guessed. This slice emits **session + message events only** — the load-bearing contract.
- **Timestamp normalization**: `created_at` is already ISO but with 6-digit micros; normalized through a
  guarded `new Date(v).toISOString()` → canonical millisecond ISO (micros truncated; immaterial, not a
  fingerprint input; the guard falls back to `ingestedAt` on an unparseable value).
- **Edge cases confirmed present in the real file** (all covered by fixture): multi-conversation file;
  **3 empty conversations** (0 messages → emit nothing); **2 conversations with no `name`**; microsecond
  timestamps; messages carrying `thinking`/`tool_use` content blocks.
- **ChatGPT**: export NOT yet obtained (email pending) → **surface skipped this slice**, recorded as a gap
  per the plan's "ship-what's-feasible" gate. Claude ships now; ChatGPT follows when its export lands.

### Prior spikes (planning-time evidence for Layer A confidence)

- **Spikes run during planning (evidence for Layer A confidence):**
  - Recon confirmed the framework wiring is COMPLETE for a snapshot drop-dir connector — no change to
    `file-watcher.ts:57-85`, `snapshot.ts:36-49`, `capture-engine.ts:187-197`, `registry.ts`, ingest
    schema, DB schema, or `fingerprint.ts`. The only new code is a connector object (`connectors[]`
    append) + a pure parser.
  - Verified the Gemini precedent end-to-end (`connectors/gemini-cli.ts:64-86` + `parsers/gemini-cli.ts`)
    — the exact shape to copy, incl. `captureMode:"snapshot"`, tolerant parse, stable `rawRecordId`,
    the `makeEvent` fingerprint builder.
  - Verified `NormalizedEvent.projectPath?`/`gitBranch?` optional (`events.ts:57-75`), nullable DB
    columns (`schema.ts:149-150`), ingest schema not requiring them (`schemas.ts:64-84`), passthrough
    insert (`ingest.ts:70-84`), and a REAL test proving unattributed events flow
    (`projections.int.test.ts:253-254`) — so chat events with no repo attribute are a solved case.
  - Verified `eventFingerprint` inputs exclude git/cwd/ts (`fingerprint.ts`) — a chat event fingerprints
    validly from a stable message id + `(eventIndex, eventType)`.
- **Confidence:**
  - **Layer A (framework, connectors, attribution design, test harness, uncosted labeling): 9.5/10** —
    additive, mirrors a verified in-repo precedent, zero change to load-bearing wiring/invariants.
  - **Layer B (parser field-extraction bodies): intentionally GATED**, not scored as ship-ready — it
    depends on the real export schema, obtained in Task 1. Once Task 1's fixtures exist, each parser is
    a mechanical map onto the fully-specified contract above and its fixture test, at ~9.4. This split
    is the honest handling the user approved: the plan does NOT claim a verified parser it cannot have,
    and it makes Task-1-before-parser a hard ordering so no parser is written from documentation.
- **Scope guard (D-M14-2 / spike):** ChatGPT + Claude export connectors only. Gemini Takeout = 14.6;
  browser extension (near-real-time, new `push` mode) = 14.7 with its own Phase-0. The
  `claude-code-sessions` desktop-app capture gap (spike side-finding) is a separate cheap `watchGlobs`
  fix, not this slice. Token-estimation confidence tier stays deferred (uncosted chosen).
