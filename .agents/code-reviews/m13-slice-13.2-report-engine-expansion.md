# Code Review — M13 Slice 13.2 (Report engine expansion + §17 context governance)

Reviewed against: full diff on branch `m13-slice2-report-engine-expansion`, prior to commit.

**Stats:**

- Files Modified: 6
- Files Added: 5 (`packages/shared/src/report-metrics.ts` + `.test.ts`,
  `packages/db/src/repositories/report-projections.ts`,
  `apps/ingest/src/reports/generate-report-m13.ts` + `reports-m13.int.test.ts`)
- Files Deleted: 0
- New lines: ~495 (modified files) + ~1000 (new files)
- Deleted lines: 34

## Issues Found

```
severity: high
file: apps/ingest/src/reports/generate-report-m13.ts
line: 191 (pre-fix)
issue: Trend-anomalies' failure-rate series silently dropped calendar gaps instead of filling them
detail: `failureSeries` (report-projections.ts) OMITS a bucket entirely when it had zero terminal
  tool calls (by design — an unfiltered GROUP BY would produce a noisy phantom bucket). The
  orchestrator built `failureRateSeries` by mapping directly over `failureSeriesRows`, so a quiet
  bucket didn't contribute a 0 — it simply never appeared. `detectAnomalies`'s rolling window then
  treated the two nearest PRESENT buckets as adjacent regardless of how many quiet calendar buckets
  actually separated them, silently mislabeling the window's "last 4 buckets" as "last 4 calendar
  periods" when a project's tool-call activity is sparse (the common case — most sessions have some
  tool-free days). The in-code comment claimed a "0 rather than being dropped" behavior that the
  code did not actually implement — a real discrepancy between stated intent and behavior, not just
  a doc nit.
suggestion: Extracted a pure `alignFailureRateSeries(referenceBuckets, series)` helper into
  `packages/shared/src/report-metrics.ts` that reindexes the failure series onto `costSeries`'s
  bucket set (a superset — it groups over ALL event types, not just terminal tool calls), filling
  any bucket missing from `failureSeriesRows` with a genuine 0 rate. Added 3 dedicated unit tests
  proving the fill behavior and one composing it with `detectAnomalies` to show the fix actually
  changes the anomaly-detection window's behavior, not just its call signature.
```

```
severity: low
file: packages/shared/src/reports.ts
line: 7-13 (pre-fix)
issue: Two separate import statements from the same module (`./report-metrics.js`)
detail: One `import type {...}` and one `import { CONTEXT_WASTE_CLASSES } from ...` from the same
  path — a minor DRY/style issue, no functional impact.
suggestion: Consolidated into a single `import { CONTEXT_WASTE_CLASSES, type ... } from
  "./report-metrics.js"`.
```

## Verification performed

- Re-read `report-projections.ts`, `generate-report-m13.ts`, `report-metrics.ts`, and the new
  renderers in `reports.ts` in full, cross-checking every payload-shape assumption
  (`tool.call.failed`'s `{name}` vs `{failureClass, call_id}` split between Claude/Codex,
  `context.loaded`'s `{attachmentType}` carrying no path) directly against the connector source
  (`claude-code.ts`, `codex-cli.ts`) rather than trusting the plan's paraphrase — confirmed accurate.
- Confirmed `events.payloadCiphertext/Iv/Tag` are populated directly on the event's own row at
  ingest time (`ingest.ts:58-59`), so `failedToolBreakdown`/`contextPathSample` correctly skip the
  `raw_source_records` join the plan suggested mirroring — verified this is not a shortcut that loses
  data, just an unnecessary join avoided.
- Verified the `toolCalls` terminal-outcome convention (completed+failed, excluding `started`)
  matches the existing `connectorHealth` precedent and its stated rationale, rather than the
  alternative `tool.call.%`-inclusive convention `sessionAggregateColumns` uses elsewhere in the
  codebase — deliberately picked the one appropriate for a success/failure ratio.
- After the `alignFailureRateSeries` fix, re-ran the full gate: `npm run repo-health -- --require-db`
  — PASS, 651/651 tests, 166 integration tests ran with 0 skipped (was 648 before the 3 new tests).
- Ran `npm run build:dashboard` — clean; the type-select + Generate-report button compiles and the
  route table shows no new/changed routes (proxy already forwarded `{type}` verbatim).
- Rendered all 5 new Markdown reports directly via a throwaway script (no server, no secrets) to
  visually confirm table/Mermaid formatting; all 5 render cleanly (`pie showData` / `xychart-beta`
  blocks are syntactically valid, tables well-formed).
- Ran `npm run format:check` (the full CI glob, not just `.md`) and fixed 4 files it flagged — this
  exact gap bit slice 13.1's CI run, so checked proactively this time before commit.
- Investigated and resolved an unrelated environment hiccup: a stale TypeScript incremental build
  cache (`tsconfig.tsbuildinfo`) left the root `tsc -b` reporting `Cannot find module '@420ai/shared'`
  across dozens of files after a manual out-of-band `tsc -b` build (run for the Level-4 visual check)
  and a partial `dist/` cleanup. Fixed by clearing `dist/`+`tsconfig.tsbuildinfo` for the 4
  project-references packages and rebuilding clean. Confirmed this was a self-inflicted, local-only
  artifact — not a source-code defect — since `git status` showed none of it was ever tracked/staged.

## Non-issues considered and ruled out

- `toolStatsByModel` grouping by `events.model` restricted to 5 specific event types (not all
  message/file/context events, which also inherit `model`) — deliberate, documented, avoids
  inflating `sessions`/`firstSeen`/`lastSeen` for a model that did nothing measurable. Not a bug.
- A `.map` file inside `/dist/` classifies as `build-output`, not `generated`, because structural
  (directory) precedence is checked before extension precedence — this is an intentional, tested
  design decision (see the dedicated "structural wins" unit test), not an inconsistency.
- Markdown table cells (tool names, paths) are not escaped against a literal `|` character — a
  pre-existing characteristic shared by every renderer in this codebase (including the original M7
  `renderCostOverTimeReport`/`renderSessionAutopsyReport`), not a regression introduced by this slice.
- The orchestrator re-calls `getProjectName` internally despite the route already checking existence
  — mirrors the exact pattern the existing `generateProjectCostReport` already uses; not new
  redundancy introduced by 13.2.

## Conclusion

One real (functional) issue found and fixed, with regression tests added. One minor style nit fixed.
No security issues (redaction paths verified against a seeded secret fixture in the int tests), no
performance concerns beyond what the plan already anticipated (event-type-filtered decrypt loops).
Full gate green after fixes.
