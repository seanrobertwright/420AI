# Code Review — M14 Slice 14.5: Claude chat-export connector

**Date:** 2026-07-20 · **Reviewer:** automated pre-commit technical review (`/lril:code-review`)
**Scope:** the `claude-export` connector + parser and its wiring, written against a Task-1-verified
redacted fixture. ChatGPT surface deferred (export not obtainable at build time).

## Stats

- Files Modified: 6
- Files Added: 4
- Files Deleted: 0
- New lines: ~380 source (parser 205, test 125, connector 49) + ~80 docs/plan
- Deleted lines: 3

**Added**

- `packages/shared/src/parsers/claude-export.ts` — pure parser
- `packages/shared/src/parsers/claude-export.test.ts` — 9 fixture-based unit tests
- `packages/shared/src/parsers/fixtures/sample-claude-export.json` — redacted real-export fixture
- `apps/collector/src/connectors/claude-export.ts` — connector object

**Modified**

- `packages/shared/src/index.ts` — export the parser
- `apps/collector/src/connectors/connector.ts` — register the connector
- `docs/guide/usage.md` — import drop-dir workflow
- `docs/research/chat-capture-spike.md` — Task-1 box (Claude verified)
- `.agents/plans/m14-*` — findings + status

## Verification performed

Each cross-system assumption was checked against the real code, not assumed:

| Concern | Check | Result |
| --- | --- | --- |
| Session events reference a `<uuid>:session` `rawRecordId` with no matching raw record | `events.raw_record_id` schema | `text().notNull()`, **no FK** (schema.ts:143) — safe; matches shipped Gemini parser |
| `payload:{title}` on a `session.started` event (no existing connector does this) | ingest wire schema + insert path | `payload:{}` accepts arbitrary JSON on ANY event type (schemas.ts); insert encrypts it (ingest.ts:59) — valid + encrypted at rest |
| `ParseResult.sessionId` left unset for the multi-conversation file | `onChange` consumption | capture-engine.ts:187 enqueues raw/events by their own keys, never reads `parsed.sessionId` — safe |
| Uncosted / unmodeled / non-repo omissions | nullable columns | `catalog_version`/`project_path`/`model`/`tokens`/`cost` all nullable — clean NULLs |
| Fingerprint stability across re-imports | unit test + fingerprint inputs | `rawRecordId = message.uuid` (480/480 unique in real file); re-parse yields identical fingerprints (test) |
| Tolerant parse | unit tests | malformed JSON / wrong-shape / no-uuid conv → `skippedLines >= 1`, never throws |

## Findings

**1. Logic Errors** — none.
- Off-by-one / ordering: messages walked in array order; fingerprints are position-independent
  (keyed on message uuid), so ordering cannot churn dedup. Verified by the re-import test.
- Empty conversation (observed 3/71) is `continue`d without incrementing `skippedLines` (legitimate,
  not malformed); a conversation lacking a stable `uuid` IS counted skipped and dropped rather than
  keyed on array position. Both behaviors are unit-tested.
- `normalizeTs` guards non-string + `NaN` and falls back to `ingestedAt` — never emits a non-ISO
  `ts`, never throws.

**2. Security Issues** — none.
- No SQL (pure parser). No secrets. The fixture was scrubbed (all free text → `redacted`/`""`, the
  account uuid replaced with a fake) and scanned: 0 secret-pattern matches, only uuid/ISO/enum
  strings survive. Conversation titles are carried in an encrypted `payload` (ingest.ts:59), not in
  a plaintext column.

**3. Performance** — none. Single `JSON.parse` + linear walk; snapshot mode already dedups by
content hash upstream, so re-reads are cheap.

**4. Code Quality** — clean. Mirrors the `gemini-cli.ts` precedent (same `makeEvent` shape, tolerant
parse, stable `rawRecordId`). Deliberate departures (no `catalogVersion`/`model`/`tokens`/`cost`)
are documented inline and honest to the export's actual fidelity.

**5. Standards adherence** — conforms. ESM `.js` imports, `import type`, kebab-case files, strict TS.
One intentional deviation from the plan: the fixture lives at `fixtures/sample-claude-export.json`
(the established repo convention used by all 3 existing parser tests), not the plan's literal
`__fixtures__/claude-export.sample.json`.

## Gates

- `npm run typecheck` (root `tsc -b`): **0 errors**
- `npm run repo-health`: **PASS** (766 tests, all typecheck lanes 0)
- `npx prettier --check` (changed files): **clean**
- `npm run lint`: **0**

## Verdict

**Code review passed. No technical issues detected.** The connector is additive, mirrors a verified
in-repo precedent, and every honesty decision lands on a verified-nullable / arbitrary-JSON path.
