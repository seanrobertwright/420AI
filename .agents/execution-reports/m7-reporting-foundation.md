# Execution Report — Milestone 7: Reporting Foundation

**Date:** 2026-06-14 · **Branch:** `m7` (stacked on M6 HEAD `54c060a`)

## Meta Information

- **Plan file:** `.agents/plans/m7-reporting-foundation.md`
- **Files added (8):**
  - `packages/shared/src/reports.ts` (187) — `ReportType`, `REPORT_VERSION`, `fmtUsd`,
    `renderCostOverTimeReport`, `renderSessionAutopsyReport`
  - `packages/shared/src/reports.test.ts` (196) — 11 pure unit tests
  - `packages/db/src/repositories/reports.ts` (92) — `insertReportArtifact` (version-bump tx),
    `getReportArtifact`, `listReportArtifacts`
  - `packages/db/src/repositories/reports.int.test.ts` (105) — 5 DB int tests
  - `packages/db/drizzle/0002_certain_stark_industries.sql` (18) — additive `CREATE TABLE` migration
  - `packages/db/drizzle/meta/0002_snapshot.json` — generated drizzle snapshot
  - `apps/ingest/src/reports/generate-report.ts` (88) — generation orchestrator
  - `apps/ingest/src/routes/reports.ts` (120) — admin-gated generate/fetch/list endpoints
- **Files modified (8):** `README.md`, `apps/ingest/src/app.ts`, `apps/ingest/src/schemas.ts`,
  `apps/ingest/src/app.int.test.ts`, `packages/db/src/index.ts`, `packages/db/src/schema.ts`,
  `packages/db/drizzle/meta/_journal.json`, `packages/shared/src/index.ts`
- **Lines changed:** +243 (modified files) / −5, plus ~806 lines across new files

## Validation Results

- **Syntax & Linting:** ✓ — NUL-byte scan clean (129 tracked text files); no stray emitted artifacts
- **Type Checking:** ✓ — root `tsc -b` exit 0 (ran after every task)
- **Unit Tests:** ✓ — 203 tests across 35 files pass (`repo-health`)
- **Integration Tests:** ✓ — `repo-health --require-db`: **56 integration tests ran, 0 skipped**
  (new: 5 db-repo report tests + 4 ingest report-endpoint tests, all against real Postgres)
- **Migration gate:** ✓ — `0002_*.sql` confirmed single additive CREATE TABLE; applied to both dev +
  test DBs; `db:generate` then reports "No schema changes, nothing to migrate"

## What Went Well

- **The plan's "compose proven layers" thesis held exactly.** Every structural half (renderer pattern
  from M1 `renderSessionReport`, table/migration/CRUD/admin-route from M2/M5, projection inputs from M6)
  was reused verbatim — no new dependency, no new external surface. The renderers dropped in as pure
  string-builders with zero infra.
- **The migration-verification gate (Task 5) worked as designed.** `db:generate` emitted exactly the
  intended `CREATE TABLE report_artifacts` + its two FKs + two indexes, touching no frozen table. Reading
  the SQL before applying it retired the only genuinely-new mechanic with no surprises.
- **`--require-db` proved the DB layer actually ran.** The mandated stricter gate confirmed 56 int tests
  executed (0 skipped) — directly applying the M5 lesson that a green `repo-health` with self-skipped int
  tests is not green. The new table, version-bump transaction, and all four endpoints were exercised
  against real Postgres, not just typechecked.
- **Clock injection stayed clean.** `generatedAt` is computed once in the route and threaded into both
  the renderer and the stored row, so the Markdown timestamp and the artifact row agree, and the renderer
  remained `new Date()`-free and trivially unit-testable.
- **Two-DB migration was handled correctly.** Recognized that `db:migrate` targets `DATABASE_URL` (dev)
  only, and applied the migration to `420ai_test` as well (via a `DATABASE_URL` override that dotenv's
  non-override default respects) so the int layer had the table.

## Challenges Encountered

- **The shared workspace has no `test` script.** The plan's Task 1/3 VALIDATE used `npm test -w
  @420ai/shared`, which fails (`Missing script: "test"`); tests run only via root `vitest run`. Resolved
  by running `npx vitest run <path>` for focused runs. Minor, but the plan's per-workspace test command
  was inaccurate.
- **`xychart-beta` degenerate-axis edge.** An all-zero cost series would emit `y-axis ... 0 --> 0`
  (invalid Mermaid). Guarded with `upper = maxCost > 0 ? maxCost.toFixed(6) : "1"`, and the empty-series
  case renders a `_No time-series data._` note instead of a chart — keeping output valid Markdown while
  the data table remains the source of truth.
- **Surfacing the actual HTTP status in a verification probe.** vitest swallows `console.log`, so
  confirming the FK-violation status code required a deliberately-wrong assertion to print "expected 500
  to be 204". A small friction in the verify-it-is-real review step.

## Divergences from Plan

**Project-existence guard added to the project POST (the code-review fix)**

- **Planned:** D6/D7 specified `isUuid(:id) → 404` as the only guard; "only a genuinely missing project
  id (non-uuid) → 404 ... A project with no events yields a zeroed cost report."
- **Actual:** Added a second guard — `if (!(await getProjectName(app.db, id))) return 404` — before
  generating, in addition to `isUuid`.
- **Reason:** The plan's guard was correct for M6 *reads* (which return 200-zeros for an unknown uuid and
  never insert) but insufficient for an M7 *write*: `report_artifacts.project_id` FKs to `projects.id`,
  so a well-formed-but-nonexistent uuid passed `isUuid` and then raised an FK-violation **500** at insert
  (verified live against the test DB). `getProjectName` cleanly distinguishes non-existent (undefined →
  404) from existing-but-empty (returns name → D7 all-zero report still generates). Added a regression
  int test.
- **Type:** Plan assumption wrong (a read-era guard reused on a write path with a new FK).

**Focused-test commands run via root vitest, not per-workspace**

- **Planned:** `npm test -w @420ai/shared -- reports`, `npm test -w @420ai/db`.
- **Actual:** `npx vitest run <path>` from the repo root.
- **Reason:** No `test` script exists in the workspace `package.json`s; only the root defines
  `test: vitest run`. Same coverage, correct invocation.
- **Type:** Plan assumption wrong (incorrect command).

## Skipped Items

Everything in the plan's explicit "do NOT build in M7" list was honored (not skips — deliberate scope):

- The other five PRD §15 report types — deferred (Scope Decision 1).
- `report.generated` event emission — not emitted (Scope Decision 2).
- Report comparison / diff endpoint / comparison-Markdown — not built; the `metrics` JSON snapshot is
  stored as the future-compare seam (Scope Decision 3).
- AI interpretation / redacted bundles (M8), payload decryption, archive export (M10), dashboard,
  scheduled generation — all out of scope, none touched.
- **Optional `GET /v1/reports/:id/markdown` raw-download endpoint** — the plan marked it "nice-to-have,
  skip if it adds risk." Skipped to keep the surface minimal; the full row already returns `markdown`.

No required plan item was skipped.

## Recommendations

- **Plan command improvements:** When a milestone converts a read-only pattern (M6 projections) into a
  *write* path that adds an FK, the plan should call out the failure-mode shift explicitly — "a guard
  sufficient for the read is insufficient for the write; add an existence check before the FK insert."
  The plan reused the M6 `isUuid → 404` guidance verbatim and inherited its read-only assumption.
- **Execute command improvements:** The VALIDATE lines should derive test commands from the actual
  `package.json` scripts rather than assuming per-workspace `test` scripts exist. A quick `npm run` probe
  before trusting a plan's command would avoid the dead-end invocation.
- **CLAUDE.md additions:** Add a one-liner under "Testing": *workspaces have no per-workspace `test`
  script — run focused tests via `npx vitest run <path>` from the root; only the root defines `test`.*
  Also worth a "Drizzle / SQL gotchas" note: *a nullable FK column makes a well-formed-but-nonexistent
  id a 500 at insert — guard write paths with an existence check, not just `isUuid`, to preserve the
  "unknown id → 404, never a DB-constraint 500" invariant.*
