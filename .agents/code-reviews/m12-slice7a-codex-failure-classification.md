# Code Review — M12 Slice 12.7a: Codex CLI tool-call failure classification

**Date:** 2026-06-21
**Branch:** `m12-slice6-alert-delivery`
**Scope reviewed:** the three code files changed by slice 12.7a (the Codex connector, its test, its
fixture). `SUMMARY.md` and the `.agents/plans/m12-slice7{a..d}-*.md` files are planning artifacts, not
code under review.

## Stats

- Files Modified: 3 (`codex-cli.ts`, `codex-cli.test.ts`, `sample-codex-rollout.jsonl`)
- Files Added: 0
- Files Deleted: 0
- New lines: ~193 insertions
- Deleted lines: ~21

## Verdict

**Code review passed. No technical issues detected.**

The change mirrors the blessed Claude Code connector pattern (`claude-code.ts:205-213` — branch on a
detected signal, emit the terminal record's type conditionally), stays inside the stated blast radius
(one source file + its fixture/test — no `@420ai/shared`, DB, ingest, migration, or fingerprint-delimiter
change), and passed the full `repo-health` gate (typecheck 0 errors across backend + dashboard + desktop;
540 tests; NUL + stray-artifact scans clean).

## Adversarial checks performed (all clear)

1. **`classifyCodexOutput` never throws / no mis-read on non-envelope JSON.** `JSON.parse` is wrapped in
   try/catch. The `parsed && typeof parsed === "object"` guard correctly rejects `JSON.parse` results
   that are a bare number (`"127"` → `127`), `null`, or a string before dereferencing `.metadata`, so
   bare-valid-JSON outputs fall through to the text branch rather than crashing or false-positiving.
   `typeof output !== "string"` (absent/object `payload.output`) returns `{ failed: false }` — tolerant,
   matches the repo-wide "output-shape variance is a completed call, not a skip" rule.

2. **Classification ordering is correct.** Structured `exit_code` is checked *before* the plain-text
   branch, so the exit-124 envelope (whose `output` text also contains "command timed out after …")
   classifies via the authoritative exit code, and the text regex is a pure fallback for un-enveloped
   outputs. `exit_code: 0` short-circuits to `completed` before any failure path.

3. **Fingerprint stability/uniqueness preserved.** `eventFingerprint` inputs are
   connector + rawId + eventIndex + eventType — `payload` is *not* an input, so adding
   `failureClass`/`exitCode` to failed payloads cannot affect dedup. The only fingerprint change is the
   intended `completed → failed` eventType flip, which the `PARSER_VERSION 1.0.0 → 2.0.0` bump and its
   doc-comment document explicitly. "Identical fingerprints across two parses" + uniqueness test still
   green.

4. **Out-of-order fixture timestamps are harmless.** The six appended records carry `12:00:09.x`
   timestamps (earlier than the pre-existing `12:00:11`/`12:00:12` lines) but `session.started`/`ended`
   use min/max of the sorted timestamp set (still `12:00:00` / `12:00:12`), and each event's rawId is
   `${session}:${physicalLineIndex}`, so uniqueness is by line position, not timestamp. Bracketing test
   still asserts the correct endpoints.

5. **Back-compat for `patch_apply_end`.** `payload.success === false` (strict) means `success` absent or
   `true` keeps the existing `file.modified` emission, so the legacy "emits file.modified for
   patch_apply_end" behavior is preserved. The failure sub-branch is correctly documented as defensive
   (real rollouts route apply_patch failures through `custom_tool_call_output` text instead).

6. **Logging/process boundaries honored.** Pure functions, no stdout/stderr, no `process.exit` — consistent
   with the library-vs-entrypoint convention. `classifyCodexOutput` exported for direct unit testing
   (consistent with the connector already exporting parser internals).

## Notes (non-blocking, already captured in the plan NOTES/ACCEPTANCE)

- **Re-parse double-count (deferred to 12.5b):** upsert-by-fingerprint never deletes, so a future re-parse
  of an already-ingested session would leave a stale `completed` row beside the new `failed` row. This is
  identical to the property the Claude connector already lives with; there is no automatic re-parse path
  today (content-hash dedup skips unchanged files). Stale-typed-event GC is explicitly owned by the
  deferred 12.5b replay engine. No action here.
- **`CodexFailureClass` is local, not in `@420ai/shared`** — intentional, to keep blast radius to one
  file; flagged in NOTES for promotion when a second connector needs the enum.
