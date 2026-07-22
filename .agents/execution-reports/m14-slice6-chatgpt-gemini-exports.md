# Execution Report — M14 Slice 14.6 (ChatGPT + Gemini chat-export connectors)

## Meta Information

- **Plan file:** `.agents/plans/m14-slice6-chatgpt-gemini-exports.md`
- **Shipped surfaces:** **ChatGPT** (`chatgpt-export`, model-attributed/uncosted) and **Gemini**
  (`gemini-export`, Takeout activity log, uncosted/model-less) — both `snapshot`-mode drop-dir
  connectors mirroring the shipped `claude-export` (14.5). This completes the M14 chat-export surfaces
  (ChatGPT was the 14.5-deferred half).
- **Files added (9):**
  - `packages/shared/src/parsers/chatgpt-export.ts` — pure parser
  - `packages/shared/src/parsers/chatgpt-export.test.ts` — 13 fixture-based unit tests
  - `packages/shared/src/parsers/gemini-export.ts` — pure parser
  - `packages/shared/src/parsers/gemini-export.test.ts` — 11 fixture-based unit tests
  - `packages/shared/src/parsers/fixtures/sample-chatgpt-export.json` — redacted real-export fixture
  - `packages/shared/src/parsers/fixtures/sample-gemini-export.json` — redacted real-export fixture
  - `apps/collector/src/connectors/chatgpt-export.ts` — connector object
  - `apps/collector/src/connectors/gemini-export.ts` — connector object
  - `.agents/code-reviews/m14-slice6-chatgpt-gemini-exports.md` — pre-PR review
- **Files modified (8):**
  - `.gitignore` — gitignore `docs/data/` (raw PII exports)
  - `packages/shared/src/index.ts` — barrel-export both parsers
  - `apps/collector/src/connectors/connector.ts` — register both connectors
  - `docs/guide/usage.md` — chatgpt/gemini drop-dir workflow (§2)
  - `docs/research/chat-capture-spike.md` — ChatGPT + Gemini follow-up boxes (verified 2026-07-21)
  - `SUMMARY.md` — 14.6-shipped status
  - `.agents/plans/m14-general-ai-chat-capture.md` — 14.6-shipped note
  - `.agents/plans/m14-slice6-chatgpt-gemini-exports.md` — plan (committed with the slice)
- **Lines changed:** +1777 / −25 across two commits (`56d58d8` feat, `00baaaf` review-fix).

## Validation Results

- **Syntax & Linting:** ✓ `npm run lint` (eslint .) exit 0; `prettier --check` clean on all changed
  files (after `--write` on the parsers/tests/spike doc).
- **Type Checking:** ✓ root `tsc -b` 0 errors; dashboard + desktop lanes 0.
- **Unit Tests:** ✓ 818 passed / 0 failed (108 files) via `npm run repo-health` — includes the 24 new
  parser tests (13 ChatGPT + 11 Gemini).
- **Integration Tests:** N/A for this slice — **zero `@420ai/db` / `apps/ingest` diff** (the connectors
  reuse the already-verified nullable insert paths 14.5 exercised). `--require-db` remains a
  milestone-sign-off gate, not a per-slice one (`CLAUDE.md`). The event pipeline is exercised by the
  existing int suite unchanged.
- **Gate:** ✓ `npm run repo-health` **PASS** (typecheck + full vitest + NUL/stray-artifact scans; both
  fixture JSONs valid UTF-8).

## What Went Well

- **The plan's Phase-0 field maps were exact.** Both formats had been inspected structure-only during
  planning; my own re-inspection confirmed every claim (ChatGPT: 63 conversations, `children[]`
  empty/absent → order-by-`create_time`, epoch-seconds, `model_slug` present, content-type histogram
  text/thoughts/reasoning_recap/multimodal_text; Gemini: 1452 records, header 100% "Gemini Apps",
  `time` 100% unique, no native id). No parser was written against a wrong assumption.
- **The framework needed zero change, as predicted.** Each connector is a ~50-line snapshot-mode object;
  the parsers are pure `string → ParseResult`; wiring is two barrel lines + two `connectors[]` appends.
  No edit to `file-watcher.ts`, `snapshot.ts`, `capture-engine.ts`, the ingest/DB schema, or
  `fingerprint.ts`.
- **PII safety was handled first (Task 0) and held.** `docs/data/` went from committable
  (`git check-ignore` non-zero) to ignored before any risk of `git add -A` staging 14 MB of real
  conversations. The committed fixtures are redacted and scanned secret-free.
- **The two parser shapes were genuinely different and both landed cleanly.** ChatGPT mirrored
  `claude-export` + three deltas (epoch×1000, order-by-create_time, skip reasoning nodes) + model
  stamping. Gemini was a new shape (flat activity log, no threading, derived `sha256(time|title)` key) —
  the "one single-turn session per Prompted record" design is the only honest representation Takeout
  supports.
- **The pre-PR code review caught real robustness gaps** an independent adversarial reviewer surfaced
  (a silent-data-loss window on a non-English Gemini export; an inconsistent skip-count; a churn-prone
  ChatGPT fallback) — all fixed before the PR, with the reviewer's one *wrong* suggested fix (index in
  the Gemini key) correctly rejected after reasoning about re-export ordering.

## Challenges Encountered

- **The plan's test assertion `rawRecords.length > events` for the ChatGPT thoughts case did not hold
  globally** (raw 8 < events 12 in my fixture, because session.started/ended add events without raw
  records). I asserted the *meaningful* invariant instead — the thoughts/recap node ids appear in
  `rawRecords` but in no `event.rawRecordId`, and raw count exceeds message-event count. This is the
  correct expression of "raw-kept-but-not-evented."
- **`thoughts` messages carry no `parts` array** (content keys `content_type`/`source_analysis_msg_id`/
  `thoughts`), which crashed a naive structure-inspection probe. The parser gates on `content_type`
  before touching `parts`, so it never dereferences a missing `parts`.
- **The Gemini silent-skip design (plan-mandated: don't inflate `skippedLines` for non-Prompted
  records) is correct per-record but created a file-level blind spot** — a wholesale locale/shape
  mismatch also produces `skippedLines: 0`. Resolving this without contradicting the plan required a
  precise split: count *unexpected-header* records (the wrong-file/locale signal) while keeping legit
  non-Prompted "Gemini Apps" activity a silent skip.

## Divergences from Plan

**ChatGPT rawRecordId fallback uses `node.id`, not the positional index**

- Planned: `Fallback id `${sessionId}:msg:${orderIndex}` only if `message.id` missing`.
- Actual: `message.id ?? node.id ?? `${sessionId}:msg:${i}`` — the node's own `mapping` key is
  preferred over the sorted-position index.
- Reason: code review — the positional index churns fingerprints across re-imports if an earlier node is
  added/removed; `node.id` is stable and order-independent (verified `node.id === mapping key` on 100%
  of nodes).
- Type: Better approach found.

**Gemini counts unexpected-header + malformed records into `skippedLines`**

- Planned: `Skip all others silently … do NOT inflate skippedLines`.
- Actual: legit non-"Prompted" "Gemini Apps" activity is still a silent skip (as planned), but a
  non-"Gemini Apps" header (localized/wrong export) and malformed array entries now increment
  `skippedLines`.
- Reason: code review — the plan's blanket silent-skip created a silent-total-data-loss window on a
  non-English Takeout (0 events / 0 skipped reads as clean success). The split preserves the plan's
  intent (a normal English export stays at `skippedLines: 0`) while restoring a signal for wholesale
  mismatch.
- Type: Security/robustness concern (data-loss).

**Gemini key documented as an intentional collision tradeoff (algorithm unchanged)**

- Planned: `key = sha256(`${time}|${title}`)…`.
- Actual: unchanged, but the code + connector `knownGaps` now explicitly state that identical
  `time`+`title` collapses to one session, and why folding in array position (a reviewer suggestion) was
  rejected.
- Reason: the suggested fix would churn every fingerprint on each re-export (Takeout prepends new
  activity), breaking the primary dedup invariant. Documentation is the correct resolution.
- Type: Plan assumption clarified (the tradeoff was implicit; now explicit).

## Skipped Items

- **`repo-health -- --require-db` and the Level-4 live drop-dir test** — deferred to the maintainer, not
  skipped in error. Per `CLAUDE.md`, `--require-db` gates milestones that touch `@420ai/db`/`apps/ingest`;
  this slice touches neither. The live test needs the collector running against real drop-dirs + the
  §10.4 approval gate — a manual maintainer step.
- **`thoughts`/`reasoning_recap`/`multimodal_text` attachment events (ChatGPT) and Gemini attachments**
  — deliberately deferred per the plan (declared `knownGaps`); those blocks are stored as raw records,
  re-derivable by a later parser version.

## Recommendations

- **Plan command:** when a plan hand-writes an illustrative test assertion (e.g. `rawRecords.length >
  events`), mark it as *illustrative, verify against the real fixture* — the exact inequality depended on
  fixture composition and was wrong as literally written. The plan already does this well for SQL
  normalization; extend the habit to fixture-count assertions.
- **Plan command:** for any parser with a "silently skip non-matching records" rule, the plan should
  prompt the executor to also consider the *file-level* failure mode (all records non-matching →
  indistinguishable from empty). The per-record rule was right; the file-level blind spot needed a
  review to catch.
- **Execute command:** the pre-PR independent adversarial review (fresh-context subagent + empirical
  verification of each contingent finding against the real data) paid for itself here — it should stay a
  standard step for any parser/dedup-key work, exactly as `CLAUDE.md` says `/lril:code-review` is for
  long-lived-resource work.
- **CLAUDE.md:** consider a one-line note that snapshot-mode parsers must make a *wholesale* parse
  failure (0 events from a non-empty file) distinguishable from a legitimately-empty file via
  `skippedLines`, so the watcher's "advanced cleanly" path can't hide total data-loss. This generalizes
  the Gemini finding.
