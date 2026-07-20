# Execution Report — M14 Slice 14.5 (Chat export-file connectors)

## Meta Information

- **Plan file:** `.agents/plans/m14-slice5-chat-export-connectors.md`
- **Shipped surface:** **Claude** (`claude-export`). **ChatGPT deferred** — export not obtainable at
  build time (email round-trip pending); recorded as a gap per the plan's Phase-0 "ship-what's-
  feasible" gate rather than parsed from documentation.
- **Files added:**
  - `packages/shared/src/parsers/claude-export.ts` (205) — pure parser
  - `packages/shared/src/parsers/claude-export.test.ts` (125) — 9 fixture-based unit tests
  - `packages/shared/src/parsers/fixtures/sample-claude-export.json` — redacted real-export fixture
  - `apps/collector/src/connectors/claude-export.ts` (49) — connector object
  - `.agents/code-reviews/m14-slice5-claude-export.md` — pre-commit review
- **Files modified:**
  - `packages/shared/src/index.ts` — export the parser
  - `apps/collector/src/connectors/connector.ts` — register the connector (`connectors[]`)
  - `docs/guide/usage.md` — import drop-dir workflow (§2)
  - `docs/research/chat-capture-spike.md` — Task-1 follow-up box (Claude verified 2026-07-20)
  - `.agents/plans/m14-slice5-chat-export-connectors.md` — Task-1 findings in NOTES
  - `.agents/plans/m14-general-ai-chat-capture.md` — 14.5-shipped status note
- **Lines changed:** ~380 new source + ~80 doc/plan; −3.

## The Phase-0 gate (the defining event of this slice)

The plan was deliberately two-layered: parser bodies (Layer B) were **gated** behind Task 1 —
obtaining a **real** export per surface — with an explicit prohibition on writing a parser from
documentation. Execution honored that seam exactly:

1. Execution **paused at the gate** when no export existed on disk (drop dirs empty, nothing in
   Downloads). This was surfaced to the user as a decision, not worked around.
2. The user obtained the **Claude** export (16.7 MB, 71 conversations). ChatGPT's had not arrived.
3. Task 1 inspected the real file **structure-only** (string values truncated — no chat content
   pulled into context), producing a verified field map, then a **redacted** fixture (all free text
   → `redacted`/`""`, account uuid faked) scanned secret-free.
4. Parser + connector + tests were written **against that fixture**, then the shipped-surface set was
   narrowed to Claude alone, with ChatGPT explicitly deferred.

## Validation Results

- **Type Checking:** ✓ root `tsc -b` 0 errors (`npm run typecheck`); dashboard + desktop lanes 0.
- **Unit Tests:** ✓ 766 passed / 0 failed (103 files) via `npm run repo-health` — includes the 9 new
  `claude-export` tests. (754 → 766 = +9 new + 3 pre-existing counted in the same run.)
- **Gate:** ✓ `npm run repo-health` **PASS** (typecheck + full vitest + NUL/stray-artifact scans; the
  76 KB fixture JSON is valid UTF-8, no NULs).
- **Integration Tests:** N/A for this slice — **zero `@420ai/db` / `apps/ingest` diff** (the connector
  reuses already-verified nullable insert paths). `--require-db` remains a milestone-sign-off gate,
  not a per-slice one (`CLAUDE.md`).
- **Lint:** ✓ `npm run lint` (eslint .) exit 0.
- **Formatting:** ✓ `prettier --check` clean on all changed files (after `--write` on 5 files).

## What Went Well

- **The framework needed zero change**, exactly as the plan's recon predicted. The parser is pure; the
  connector is a 49-line snapshot-mode object; registration is a one-line `connectors[]` append. No
  edit to `file-watcher.ts`, `snapshot.ts`, `capture-engine.ts`, the ingest schema, the DB schema, or
  `fingerprint.ts`.
- **Every honesty decision landed on a verified-tolerant path.** Code review confirmed against real
  code: `raw_record_id` is plain `text` (no FK) → session events need no raw record; `payload:{}`
  accepts arbitrary JSON on any event type and is encrypted on insert → conversation titles ride along
  safely; `catalog_version`/`project_path`/`model`/`tokens`/`cost` are nullable → uncosted/non-repo
  omissions are clean NULLs; `onChange` never reads `ParseResult.sessionId` → the multi-conversation
  file is fine with it unset.
- **The real file was richer than the docs implied**, and the edge probe caught it before it became a
  bug: `uuid`/`sender`/`created_at` present on 480/480 messages (no positional fallbacks needed);
  all message uuids globally unique (perfect stable `rawRecordId`); 3 empty conversations and 2
  empty-titled conversations (both fixtured + tested); microsecond timestamps (normalized).
- **Code review found zero issues** — the three novel choices (session rawRecordId, title payload,
  unset ParseResult.sessionId) were each verified against the schema/wiring rather than assumed.

## Challenges Encountered

- **The gate was a hard external dependency, not a code problem.** The correct action was to stop and
  ask, then resume when the file appeared — the slice could not be completed autonomously, and forcing
  it (guessing the parser from the spike's `[documented]` shapes) was explicitly the wrong move.
- **The real export carries tool activity the plan didn't fully anticipate** (`tool_use`/`tool_result`/
  `thinking` content blocks, populated `files`/`attachments`). Rather than guess those unverified block
  shapes, they were recorded as a declared `knownGap` and deferred — the same gate discipline applied
  one level down.

## Divergences from Plan

**Fixture path uses the repo convention, not the plan's literal path**

- **Planned:** `packages/shared/src/parsers/__fixtures__/claude-export.sample.json`.
- **Actual:** `packages/shared/src/parsers/fixtures/sample-claude-export.json`.
- **Reason:** all three existing parser tests (`claude-code`, `codex-cli`, `gemini-cli`) read from
  `./fixtures/sample-*` — matching the established codebase pattern outweighs the plan's literal path.
- **Type:** Standards adherence.

**ChatGPT surface deferred**

- **Planned:** ChatGPT + Claude connectors (ChatGPT first, since its export carries `model_slug`).
- **Actual:** Claude only; ChatGPT deferred to a follow-up.
- **Reason:** the ChatGPT export was not obtainable at build time (email pending). The plan's own gate
  mandates shipping the feasible surface and recording the gap rather than parsing from documentation.
- **Type:** Scope (planned fallback exercised).

**Conversation title captured in `session.started.payload`**

- **Planned:** title noted as an attribution input; attribution + sessionId resolved to the uuid.
- **Actual:** additionally stash `{title}` in the `session.started` event payload when non-empty.
- **Reason:** cheap, honest, useful (human-readable topic in the archive); the payload column already
  exists and is encrypted at rest. Guarded for empty/missing titles.
- **Type:** Better approach found (additive, verified against the ingest schema).

## Skipped Items

- **ChatGPT parser/connector/tests** — deferred (see above); not a skip of completable work.
- **Tool-lifecycle + file-interaction events** — the export carries the data but the block shapes are
  unverified; deferred as a declared `knownGap` rather than guessed (Phase-0 discipline).
- **No new integration test** — no new DB/ingest code; the connector rides verified-nullable paths.
  Per the plan's testing strategy, fixture-based unit tests are the correct + sufficient layer.

## Recommendations

- **When ChatGPT's export arrives**, the follow-up is mechanical: run the same structure-only
  inspection (its shape differs — a `mapping` node tree with `create_time` + `metadata.model_slug`),
  redact a fixture, and write `chatgpt-export.{ts,test.ts}` + connector against it. Model IS present
  there, so revisit whether the token-estimation confidence tier should apply (still deferred).
- **Consider a follow-up slice for tool/file events** from the Claude export now that the block types
  are known (`tool_use`/`tool_result`/`thinking`, `files`/`attachments`) — a per-block verification
  pass would let the parser emit the tool-call lifecycle the coding-tool connectors already model.
