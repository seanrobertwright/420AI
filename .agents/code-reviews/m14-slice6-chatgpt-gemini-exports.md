# Code Review — M14 Slice 14.6 (ChatGPT + Gemini chat-export connectors)

**Reviewed:** the slice-14.6 diff (commit `56d58d8`) — two pure parsers, two connector objects, the
registry/barrel wiring, redacted fixtures, docs. Review method: full-file read of every new/changed
source file, plus an **independent adversarial reviewer** (fresh context) over the two parsers and the
`fingerprint.ts`/`events.ts` invariants, plus **empirical verification against the real exports** for
each contingent finding.

**Stats:**

- Files Modified: 7 (+ 5 touched again by this review's fixes)
- Files Added: 9
- Files Deleted: 0
- New lines: ~1595 (commit) + ~60 (review fixes)
- Deleted lines: 25

## Verdict

**No critical/high issues.** The fingerprint/dedup design is sound: message events key on stable ids,
session events differ by `eventType` under a shared synthetic id (the shipped `claude-export` pattern),
and event ordering never feeds the fingerprint. Five lower-severity robustness findings were raised; the
three real ones were fixed, one was resolved by documentation (the reviewer's suggested fix would have
been worse), and one was verified a non-issue.

## Findings & Resolutions

### 1. Gemini — locale/wrong-file → silent total data-loss — MEDIUM — FIXED

- file: `packages/shared/src/parsers/gemini-export.ts` (header/prefix gates)
- issue: both skip gates (`header !== "Gemini Apps"`, `!startsWith("Prompted ")`) `continue`d without
  incrementing `skippedLines`. A non-English Takeout (localized header/prefix) or a wrong file would
  parse to `{events:[], skippedLines:0}` — indistinguishable from a legitimately-empty file. In
  snapshot mode the watcher treats 0-events/0-skipped as a clean success, advances, and never retries →
  the user captures nothing with no signal.
- fix: a **non-`"Gemini Apps"` header** (the unrecognized-shape / localized-export case) now increments
  `skippedLines`, so a wholesale mismatch trips the "0 events but N skipped" alarm. A legit
  **non-`"Prompted"` `"Gemini Apps"`** record (canvas/feedback/image activity) remains a deliberate
  silent skip per the plan — a normal English export still reports `skippedLines: 0` despite its ~188
  non-prompt records. New test: `counts UNEXPECTED-header records and malformed entries into skippedLines`.

### 2. Gemini — `sha256(time|title)` key collision drops raw + events — MEDIUM — RESOLVED (documented)

- file: `packages/shared/src/parsers/gemini-export.ts` (key derivation)
- issue: the derived key is both the raw-record id and the fingerprint seed; two records with an
  identical `time` AND `title` collapse to one session (second raw record + events deduped away).
- resolution: **verified 100% unique in the real export (1452/1452 distinct `time|title`)**, and the
  key is plan-mandated. The reviewer's suggested fix (fold the array index into the key) would be
  *worse*: Google Takeout prepends new activity (reverse-chronological), so every re-export shifts all
  indices and would churn **every** fingerprint — breaking the primary re-import dedup invariant. The
  content-derived key is the correct stability choice; the residual collision is a conscious,
  now-explicitly-documented tradeoff (code comment + connector `knownGaps`).

### 3. Gemini — malformed array entries not counted as skipped — LOW — FIXED

- file: `packages/shared/src/parsers/gemini-export.ts` (`if (!record || typeof record !== "object")`)
- issue: `null`/primitive array entries were skipped without `skippedLines++`, inconsistent with the
  sibling parsers (`chatgpt-export.ts`, `claude-export.ts`) which count malformed entries.
- fix: `skippedLines++` before `continue`. Covered by the new skip-counting test.

### 4. ChatGPT — positional rawRecordId fallback is churn-prone — LOW — FIXED

- file: `packages/shared/src/parsers/chatgpt-export.ts` (message rawId fallback)
- issue: when `message.id` is absent the fallback keyed on the `create_time`-sorted position
  (`${sessionId}:msg:${i}`); adding/removing an earlier node between exports would shift indices and
  churn those fingerprints (duplicate turns on re-import).
- fix: prefer the node's own `mapping` key (`node.id`) — **verified `node.id === mapping key` on 100%
  of nodes**, and it is order-independent/stable across re-imports. The positional index remains only as
  a last-resort. New test: `falls back to the stable node id (not sorted position) when message.id is
  absent`.

### 5. ChatGPT/Claude — message fingerprint assumes GLOBAL id uniqueness — LOW — VERIFIED, NO CHANGE

- file: `packages/shared/src/parsers/chatgpt-export.ts` (rawId = `message.id`, no conversation prefix)
- issue: `rawRecordId` is the bare `message.id`; if node ids were only unique *within* a conversation,
  two conversations could collide.
- resolution: **verified globally unique — 1013/1013 distinct message ids across all 63 conversations.**
  ChatGPT ids are UUIDs. Namespacing with the conversation id would (a) change existing fingerprints and
  (b) diverge from the shipped `claude-export`, which likewise keys on the bare message uuid. Left
  unchanged, consistent with the precedent.

## Things checked and found NOT to be bugs

- ChatGPT `${sessionId}:session` shared by `session.started`/`session.ended` (index 0) — safe (differ by
  `eventType`); matches `claude-export`. Verified 0/1013 real message ids contain `":session"`.
- ChatGPT `create_time` sort — stable (Node ≥24) and deterministic; message fingerprints key on
  `message.id`, so order cannot churn dedup. A NaN comparator has no dedup impact.
- Gemini's four event types sharing `key`/index 0 — collision-safe (distinct `eventType`s).
- Model stamped on `message.user` via `default_model_slug` — harmless: `usageByModel` filters to
  `usage.reported`/`cost.estimated` (none emitted here); `array_agg(distinct model)` collapses the
  correct duplicate value. No projection is affected.
- Tolerance/no-throw — both parsers survive malformed blobs, wrong top-level shapes, string/array
  `mapping`/`message`, and missing nested fields (`?.` throughout). No throwing path found.
- `ts` non-determinism from the `ingestedAt` fallback — present but harmless (`ts` is not a fingerprint
  input).

## Validation after fixes

- `npm run typecheck` — exit 0
- `npx vitest run <both parser test files>` — 24 passed (was 22; +2 for the new skip/fallback tests)
- `npm run lint` — exit 0
- `npx prettier --check <changed>` — clean
