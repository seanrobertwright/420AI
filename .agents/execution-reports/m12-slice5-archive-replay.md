# Execution Report — M12 Slice 12.5a (Archive-Replay: Retroactive Re-Pricing)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice5-archive-replay.md`
- **Branch:** `m12-slice5-archive-replay`
- **Scope:** 12.5a (retroactive re-PRICE) only; 12.5b (re-PARSE) deliberately deferred per the plan's scope decision.

**Files added (5):**
- `packages/db/src/repositories/reprice.ts` (61 lines) — `repriceAll(db, catalog)` + `RepriceResult`
- `packages/db/src/reprice-cli.ts` (28 lines) — the `db:reprice` ops entrypoint
- `packages/db/src/repositories/reprice.int.test.ts` (157 lines) — repo integration test
- `apps/ingest/src/routes/replay.ts` (25 lines) — admin-gated `POST /v1/replay/reprice`
- `apps/ingest/src/replay.int.test.ts` (120 lines) — route integration test

**Files modified (6):**
- `packages/db/src/index.ts` (+2) — barrel export of `repriceAll` / `RepriceResult`
- `apps/ingest/src/app.ts` (+2) — import + register `replayRoutes` after `catalogRoutes`
- `package.json` (+1) — root `db:reprice` forwarder
- `packages/db/package.json` (+1) — `db:reprice` → `tsx src/reprice-cli.ts`
- `docs/guide/operations.md` (+44) — "12.5a — Retroactive re-pricing (archive replay)" runbook section
- `SUMMARY.md` (+11/−2) — §6 12.5 marked 12.5a DONE, 12.5b deferred

**Lines changed:** +391 new (5 source/test files) + 59 insertions / 2 deletions in tracked files.

## Validation Results

- **Syntax & Linting:** ✓ (no separate linter; covered by `tsc` + repo-health NUL/artifact scans)
- **Type Checking:** ✓ `npx tsc -b` exit 0 (root backend typecheck, 4 workspaces)
- **Unit Tests:** ✓ no new pure-unit tests required (`computeCost` already unit-tested); all existing units green
- **Integration Tests:** ✓
  - `reprice.int.test.ts` — 2 passed, 0 skipped
  - `replay.int.test.ts` — 3 passed, 0 skipped
- **Full sign-off gate:** ✓ `npm run repo-health -- --require-db` → PASS, 512 tests (75 files), **141 integration tests ran, 0 skipped**, exit 0
- **Functional smoke:** ✓ `npm run db:reprice` against the main DB throws the intended "no active catalog to re-price under" and closes the pool (expected — no active catalog present)
- **Code review:** ✓ passed, no critical/high/medium issues (`.agents/code-reviews/m12-slice5-archive-replay.md`)

## What Went Well

- **The plan was executable verbatim.** The Patterns snippets for `reprice.ts`, `replay.ts`, and
  `reprice-cli.ts` compiled and ran essentially as written — they had been spike-proven against the
  live test DB during planning, and that confidence held. The single genuinely-uncertain correctness
  point (NULL-`catalog_version` inclusion via `IS DISTINCT FROM` + batched-loop termination) worked
  first try and is locked in by the idempotency test.
- **Mirroring proven code paid off.** `repriceAll` is structurally `reencryptAll` over `events`;
  `reprice-cli.ts` is `rotate-key-cli.ts`; `replay.ts` is `metrics.ts` + `ingest.ts`'s catalog fetch.
  Every imported symbol was confirmed against source before writing, so there were no
  "function doesn't exist / wrong signature" surprises.
- **Re-price/ingest semantic parity.** Using the same `computeCost(model, tokens, catalog.rates)` call
  and the same `cost+tokens+model` predicate as `ingestBatch`'s D2 block means the retroactive and
  going-forward paths can't drift — and the int test proves the recomputed value (0.01) matches what
  going-forward ingest would have produced.
- **Clean blast radius.** Zero schema change, fingerprint untouched, no existing call site modified.
  The working tree is exactly 5 new + 6 modified files with no stray artifacts.

## Challenges Encountered

- **Test-DB migration friction (environment, not code).** The first `db:migrate` against the test DB
  failed because `$DATABASE_URL_TEST` is only in `.env`, not exported to the Git-Bash shell, so it
  expanded empty — and dotenv won't override an already-set (empty) env var. Resolved by reading the
  real value out of `.env` and passing it inline. This is exactly the gotcha the memory note
  "Test DB not migrated by db:migrate" warns about; it cost two extra commands, no code change.
- **Working-directory persistence.** A `cd packages/db` in one Bash call persisted into the next,
  breaking a relative `cd`. Switched to absolute paths + subshells. Minor.

## Divergences from Plan

**Integration-test row cast required `as unknown as`**

- **Planned:** Task 3 mirrored `pricing-catalogs.int.test.ts`, which casts `db.execute(...).rows`
  directly to an inline object-literal type (`.rows as { … }[]`).
- **Actual:** My version routed the result through a typed helper (`readCosts(db)`) returning a named
  `CostRow` interface, and the direct cast `.rows as CostRow[]` failed `tsc -b` (TS2352 — the driver's
  `Record<string, unknown>[]` doesn't "sufficiently overlap" a named interface reached via a typed
  param). Fixed with the compiler-suggested `.rows as unknown as CostRow[]`.
- **Reason:** TS's cast-overlap rule treats a direct cast to a named interface more strictly than to
  an inline literal in the sibling test's exact position. `as unknown as` is the standard, safe escape
  hatch for raw-SQL row shapes.
- **Type:** Other (minor type-system mechanics; no behavioral change).

**SUMMARY §6 bullet rewritten, not just check-marked**

- **Planned:** Task 10 — "mark 12.5 done (mirror the 12.4 done-bullet style)".
- **Actual:** Rewrote the 12.5 roadmap bullet to split it explicitly into "✅ 12.5a re-PRICE DONE"
  (with the route/CLI/repo surface named) and "Deferred → 12.5b re-PARSE" (with the parser-relocation
  constraint named).
- **Reason:** The original bullet described the *whole* §23 engine (incl. re-parse); marking it
  wholesale "done" would have overclaimed. The split keeps the record honest about what shipped.
- **Type:** Better approach found (accuracy of the sign-off record).

## Skipped Items

- **12.5b re-PARSE engine** — intentionally out of scope per the plan's explicit scope decision
  (large, fingerprint-touching, requires relocating parsers `apps/collector` → `packages/shared`).
  The plan's NOTES already carry the 12.5b design sketch; nothing was lost.
- **The optional "model absent from catalog → usd 0" extra int case** — the plan marked it
  "optional; not required for the gate." The behavior is covered by parity with `computeCost`'s
  unit tests and documented in the runbook; not separately re-tested.
- **No code committed** — the execute flow ends "ready for `/lril:commit`"; per CLAUDE.md, commits
  happen only when the user asks. Working tree is staged-clean and ready.

## Recommendations

- **Plan command:** This plan is a model for the format — folding spike assertions directly into the
  Patterns snippet (the `IS DISTINCT FROM` trap) and pre-verifying every symbol against source is what
  made one-pass execution possible. Keep doing that for any plan with a subtle SQL/predicate core.
- **Execute command:** When a plan touches `@420ai/db` or `apps/ingest` int tests, run the test-DB
  migration check *first* (it's the most common stumbling block here, per the standing memory note),
  rather than discovering the skip/failure mid-run.
- **CLAUDE.md / memory:** No new addition needed — the existing "Test DB not migrated by db:migrate"
  memory and the "`IS DISTINCT FROM` for NULL-safe inequality" / "Drizzle aggregate gotchas" sections
  already cover everything encountered. One small reinforcement worth noting for future int tests:
  prefer casting raw `db.execute().rows` to an **inline object literal** at the call site (the proven
  sibling-test pattern) rather than to a named interface via a helper, to sidestep the TS2352
  cast-overlap strictness.

---

**Status:** All 10 tasks complete; all validation levels green; code review clean. Ready for
`/lril:commit`.
