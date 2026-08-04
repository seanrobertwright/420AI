# Execution Report — M16 Slice 16.4: Data-Quality Audit Report

**Date:** 2026-08-04 · **Branch:** `m16-slice4-data-quality-audit-report` · **Commit:** `1ed0f38`

## Meta

**Plan file:** [`.agents/plans/m16-slice4-data-quality-audit-report.md`](../plans/m16-slice4-data-quality-audit-report.md)

**Files added (14):**

| Path                                                      | Purpose                                           |
| --------------------------------------------------------- | ------------------------------------------------- |
| `packages/shared/src/data-quality.ts`                     | `MetricValue` union, `ratioMetric`, the pure derivation |
| `packages/shared/src/data-quality.test.ts`                | Unit tests for every metric branch                 |
| `packages/shared/src/reports-audit.ts`                    | `renderDataQualityAuditReport` (Markdown)          |
| `packages/shared/src/reports-audit.test.ts`               | Renderer unit tests                                |
| `packages/db/src/repositories/data-quality.ts`            | Seven windowed aggregate reads                     |
| `packages/db/src/repositories/data-quality.int.test.ts`   | Two-role integration suite                         |
| `packages/db/src/repositories/recoverability.ts`          | `reparseDryRun` — read-only re-parse twin          |
| `packages/db/src/repositories/recoverability.int.test.ts` | Two-role integration suite (incl. "writes nothing") |
| `apps/ingest/src/reports/generate-report-audit.ts`        | The orchestrator                                   |
| `apps/ingest/src/reports/reports-audit.int.test.ts`       | HTTP-level suite through `buildApp`                |
| `apps/ingest/src/routes/data-quality.ts`                  | `POST /v1/audit/data-quality`                      |
| `apps/dashboard/src/app/api/audit/data-quality/route.ts`  | Same-origin POST proxy                             |
| `apps/dashboard/src/components/reports/audit-actions.tsx` | The one generate button                            |
| `.agents/plans/m16-slice4-data-quality-audit-report.md`   | The plan itself                                    |

**Files modified (15):** `packages/shared/src/{index,reports,capture-health}.ts`,
`packages/db/src/{index.ts,repositories/reparse.ts}`, `apps/ingest/src/{app,schemas,rls.int.test}.ts`,
`apps/dashboard/src/components/reports/reports-view.tsx`,
`scripts/generate-reports.{mjs,test.ts}`, `docs/PRD.md`, `docs/guide/data-boundary.md`,
`.agents/research/weekly/TEMPLATE.md`, `SUMMARY.md`.

**Lines changed:** +5209 −16 across 29 files.

## Validation Results

| Lane                                    | Result                                        |
| --------------------------------------- | --------------------------------------------- |
| Type checking (root `tsc -b`)           | ✓ 0 errors                                    |
| Type checking (`typecheck:dashboard`)   | ✓ 0 errors                                    |
| Type checking (`typecheck:desktop`)     | ✓ 0 errors                                    |
| Unit tests                              | ✓ 48 passed, 0 failed, 0 skipped              |
| Integration — new suites                | ✓ 39 passed, 0 failed, **0 skipped**          |
| Integration — `rls` + `org-scoping`     | ✓ 22 passed, 0 failed, 0 skipped              |
| NUL / stray-artifact / SUMMARY scans    | ✓ PASS (pre-commit `repo-health --fast`)      |
| Lint, `format:check`, `build:dashboard` | Run at the pre-push gate (see the PR)          |

The DB-backed layer **actually ran** — `skipped ≠ passed` — against `420ai_test` on :5433 with the
test database migrated separately from `db:migrate`.

## What Went Well

- **The three-state `MetricValue` did its job as a type, not as a discipline.** Because
  `ratioMetric` is the only constructor and returns `unknown` on a zero denominator, there was never
  a moment where a call site had to *remember* the honesty rule. Seven call sites, one property.
- **Spike fidelity paid off exactly where the plan predicted.** The parse-success denominator
  (`count(*) filter (where exists ...)` rather than a join) and the duplicate grouping key that omits
  `session_id` were both transcribed from spikes S1–S3 and both worked first time against a real
  database. No re-derivation, no drift between plan snippet and implementation.
- **`report_artifacts` genuinely absorbed an org-scoped artifact with no migration.** Spike F had
  proven the write path; listing, version history, compare and Markdown export were inherited with
  literally zero changes to those endpoints, which the HTTP suite asserts rather than assumes.
- **The two-role harness copied cleanly from `capture-health.int.test.ts`**, role-identity test and
  all. Having a known-good template for the hardest-to-get-right kind of test is worth more than any
  amount of guidance about it.
- **Importing `deriveCaptureHealth` rather than pre-counted verdicts** turned D-16.4-2 from a
  convention into a structural fact: there is no code path in which a second connector verdict can
  exist, because the pure layer calls the same function the panel does.

## Challenges Encountered

- **The `int4` overflow was the one genuine bug this slice shipped and then caught.** `lag_ms` was
  cast `::bigint::int` by reflex, matching every other count in the file. A back-dated fixture event
  overflowed `int4`, Postgres raised `22003 integer out of range`, and the entire audit 500'd. The
  distinction that matters: **a count is bounded by the table; a difference between two clocks is
  not.** Only `rls.int.test.ts` caught it, because it is the one suite whose fixtures sit a year
  before `now` — every other suite seeds near the present and passed happily.
- **Drizzle binds a JS array inside a raw `sql` template as ONE scalar parameter.** `= any(${ids}::text[])`
  reached the driver as the bare string `s1` and Postgres rejected it with `22P02 malformed array
  literal`. The fix was to drop to the query builder's `inArray`, which expands the list into
  individual bound parameters. Measured, not reasoned about.
- **Deciding what the recoverability dry run should compare against was harder than writing it.**
  Comparing the fresh fingerprint set against *every* event of the session reports another machine's
  longer capture as `missing` — a fabricated failure. The stored set has to be scoped to the raw ids
  this machine holds, unioned with the ids the fresh parse produced, which is what `reparseAll`'s
  orphan GC already does. Getting this wrong would have produced a plausible-looking recoverability
  failure against a perfectly recoverable archive.
- **Reserving the literal token `100%`.** The empty-org regression test asserts `100%` appears
  nowhere in an all-`unknown` report. `§5.1` words recoverability's target as "100% of monthly
  sample", which would have made the assertion unwritable. Rendering percentages with one decimal
  (`100.0%`) keeps a genuine perfect score expressible while reserving the bare token — a small
  decision that took longer to justify than to implement.

## Divergences from Plan

**Seven repository reads, not six-plus-one**

- **Planned:** `sessionQualityRows`, `rawRecordTotals`, `duplicateRawRecords`, `ingestLagRows`,
  `connectorTokenEligibility`, `gitLinkageBuckets`, plus `reconciliationSample`.
- **Actual:** the last two were renamed to `connectorDeclarations` and `gitLinkageRows`, and a
  seventh read `recoverabilityTargets` was added.
- **Reason:** the planned names promised work the functions deliberately do not do. Eligibility and
  bucketing are *judgements* — "does a connector count as token-capable when two machines disagree",
  "does a session with both a confirmed and a suggested link count once" — and the plan itself
  argues those belong in TS where they are unit-testable, not in a `case` expression buried in SQL.
  A function named `gitLinkageBuckets` that returns unbucketed pairs is a comment that lies.
  `recoverabilityTargets` is new because raw records are per-machine while the sample is per
  (session, connector): the dry run's subjects are not the sample's rows.
- **Type:** Better approach found.

**`isLiveCapture` exported from `capture-health.ts`**

- **Planned:** `capture-health.ts` was not in the files-to-modify list; only `reparse.ts` was to gain
  `export` keywords.
- **Actual:** `isLiveCapture` gained an `export` too.
- **Reason:** sync freshness needs the same live-vs-batch split 16.3 already decided (D-16.3-4) — a
  batch connector's "agreed liveness window" is "whenever an export is dropped in", which the archive
  cannot know. Copying the two-line predicate would have been exactly the drift D-16.4-2 exists to
  prevent, one layer down. Same rule as the reassemblers, applied to a predicate rather than a verdict.
- **Type:** Better approach found.

**A fourth skip reason: `no-raw-records`**

- **Planned:** `skippedReason: "gemini" | "unsupported-connector" | "decrypt-error" | null`.
- **Actual:** `"no-raw-records"` added as a fourth.
- **Reason:** it is unreachable by construction today (targets are selected *from*
  `raw_source_records`, so only a concurrent delete gets there), and the tempting move was to fold it
  into `unsupported-connector`. That would put a **wrong explanation** on a worksheet row, which is
  the single failure mode this module exists to prevent. An honest "cannot tell" beats a tidy but
  false one.
- **Type:** Other (honesty rule applied to the module's own edge case).

**`ingestLagRows` takes both window representations**

- **Planned:** the pattern snippet showed reads taking one `sinceIso`.
- **Actual:** `ingestLagRows(db, orgId, sinceIso, since)` takes both.
- **Reason:** it is the one read that touches *both* timestamp mechanisms — `events.ts`
  (`mode:"string"`, compared against an ISO string) and `raw_source_records.ingested_at` (plain
  timestamptz, compared against a `Date`). Deriving one from the other inside the function would have
  re-introduced the conflation the file's header warns about. Both are derived once in the
  orchestrator and threaded down.
- **Type:** Plan assumption wrong (the snippet under-specified this read).

**`lag_ms` is `::bigint` + `Number()`, not `::int`**

- **Planned:** "GOTCHA: `::int` every count."
- **Actual:** every count is `::int`; the lag is `::bigint` and coerced with `Number()`.
- **Reason:** see Challenges — the plan's gotcha is correct *for counts* and wrong for a difference
  between two clocks. This is the bug the slice shipped and caught.
- **Type:** Plan assumption wrong.

## Skipped Items

- **Level-4 manual validation** (the hand-count of ten worksheet sessions against the tool-native
  files under `~/.claude/projects` and `~/.codex/sessions`, and the dashboard click-through). This is
  the §4.4 reconciliation itself — a **human** judgement the slice deliberately does not automate
  (see the plan's "Why not a `reconciliation_results` table?"). It is now unblocked *because* this
  slice emits the worksheet, and it is the remaining item before M16 sign-off. `SUMMARY.md` records
  this explicitly rather than implying the milestone is closed.
- Nothing else from the 18 tasks was skipped.

## Recommendations

**CLAUDE.md addition — the one this slice earned:**

> **`::int` is right for a COUNT and wrong for a DIFFERENCE.** node-postgres returns a bare
> aggregate as a string, so casting counts `::int` is the repo idiom — but a count is bounded by the
> table while a difference between two clocks is not. `extract(epoch from (a - b)) * 1000` over a
> back-dated event overflows `int4` and Postgres raises `22003`, 500ing the request. Cast durations
> `::bigint` and coerce with `Number()`. Corollary about TESTING it: **every suite that seeds near
> `now` will pass.** Only a fixture set placed far from the present exercises the range at all, which
> is why `rls.int.test.ts` — seeded a year back — was the only suite that caught it.

**Plan command improvement:** the plan's repository-read list named two functions after the
*judgements* their callers make rather than the *rows* they return, and both were renamed during
execution. When a plan specifies a shared/db split whose whole argument is "the judgement lives in
TS so it is unit-testable", the read's name should describe its rows. Worth a line in the planning
skill: **name a repository function after what it returns, not what its caller concludes.**

**Execute command improvement:** none. The plan's spike-snippet fidelity discipline — every snippet
carrying the assertion it encodes, so drift is detectable — is the reason the two hardest queries
worked first time, and it should be kept as-is.
