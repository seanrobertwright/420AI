# Execution Report — M13 Slice 13.1 (Truth & small fixes)

## Meta Information

- Plan file: `.agents/plans/m13-capability-gap-closure.md` (Slice 13.1 only — the plan's own execution
  rule requires one slice at a time, each independently committed, in order)
- Files added: none
- Files modified:
  - `docs/CONTEXT.md`
  - `apps/ingest/src/routes/exports.ts`
  - `apps/collector/src/sync/sync-worker.ts`
  - `apps/collector/src/sync/sync-worker.test.ts`
  - `apps/collector/src/capture-engine.ts`
  - `apps/collector/src/serve.ts`
  - `apps/collector/src/serve.test.ts`
  - `docs/guide/operations.md`
  - `apps/desktop/README.md`
- Lines changed: +152 -21

## Validation Results

- Syntax & Linting: ✓ (`npx prettier --check` clean on all touched Markdown; TS compiles clean)
- Type Checking: ✓ root `tsc -b` 0 errors, dashboard `tsc --noEmit` 0 errors, desktop `tsc --noEmit` 0 errors
- Unit Tests: ✓ 625/625 passed (3 new: 2 in `sync-worker.test.ts`, 1 in `serve.test.ts`)
- Integration Tests: ✓ 159 integration tests ran, 0 skipped (`repo-health -- --require-db`, DB brought
  up via `npm run db:up` + `npm run db:migrate` for this sign-off)

## What Went Well

- The plan's own guidance to "mirror `consecutiveSyncFailures`'s wiring" in `sync-worker.ts` was exactly
  right — the new `onSync` callback slots into the identical `if (outcome === "ok")` branch, threading
  through `capture-engine.ts` → `serve.ts` with no structural surprises. Three files, one callback,
  done in the shape the plan predicted.
- Docker/Postgres came up cleanly on the first `npm run db:up` + `npm run db:migrate`, so the stricter
  `--require-db` gate could be run for full confidence rather than settling for the DB-less `repo-health`.
- The code-review pass caught a real, concrete documentation bug (a working-directory mismatch in the
  new runbook) before commit — exactly the kind of thing that's easy to introduce when writing a
  multi-step shell runbook by hand and easy to miss without a dedicated review pass.

## Challenges Encountered

- **Global test setup couples ALL unit tests to Postgres reachability.** `vitest.global-setup.ts`
  unconditionally attempts `runMigrations(DATABASE_URL_TEST)` whenever that env var is configured in
  `.env` — regardless of which test files are targeted. Since `.env` has `DATABASE_URL_TEST` set but
  Docker Desktop was not yet running, even a narrowly-scoped `npx vitest run apps/collector/...` (three
  pure-unit-test files, no DB involvement) failed at global setup with `ECONNREFUSED`. Worked around by
  temporarily overriding `DATABASE_URL_TEST=` for that one invocation (dotenv doesn't override an
  already-set env var), then later started Docker Desktop + brought up the archive container to run the
  real full/`--require-db` gate.
- **A test I wrote first was itself flaky/wrong, not the code under test.** The initial "onSync must not
  fire on a retry outcome" test enqueued one item, expected the loop to only observe the single failing
  attempt, but didn't account for the queue's real (uninjected) backoff clock: after the first failure
  the item backs off for ~1s, so subsequent loop iterations before the test's 50ms abort saw an *empty*
  queue and returned early "ok" (no network call) — which correctly fires `onSync` per the plan's literal
  semantics ("ok" includes the empty-queue no-op). Fixed by making the test deterministic: a long
  `retryMs` so the loop is still asleep in its post-failure delay when the abort fires, guaranteeing
  exactly one `syncOnce` call and zero `onSync` calls. This was a genuinely useful catch — it forced
  clarifying that `onSync` intentionally fires on the idle/empty-queue path too, not just real network
  successes.

## Divergences from Plan

**Updater-key runbook: consolidated instead of duplicated**

- Planned: "add a '13.1 Updater signing key (one-time ceremony)' section" to `docs/guide/operations.md`
  and `apps/desktop/README.md`.
- Actual: Added the new dedicated section as specified, but also discovered the file already had an
  older, slightly different "One-time setup — generate the updater signing key" blurb under 12.8c
  (using `~/.tauri/420ai.key`, unverified path convention). Replaced that older blurb with a pointer to
  the new canonical section rather than leaving two contradictory sets of instructions for the same
  ceremony.
- Reason: The plan's own NOTES/spike section is explicit that `cargo tauri signer generate --ci` was
  the *verified* invocation on this machine; the pre-existing 12.8c text used a different, unverified
  `npm run tauri signer generate --` form and a `~/.tauri/` key path inconsistent with this repo's
  established `.secrets/` convention for every other signing key. Leaving both would have shipped two
  authoritative-looking, disagreeing runbooks.
- Type: Plan assumption wrong (the plan didn't know about the pre-existing, slightly-divergent 12.8c
  text, since it wasn't called out in the plan's CONTEXT REFERENCES for 13.1) — fixed by reconciling.

**`apps/desktop/README.md`: fixed a second stale claim beyond the one requested**

- Planned: add a pointer/runbook reference in `apps/desktop/README.md`.
- Actual: also corrected the adjacent, incorrect claim that "auto-update remain[s] deferred" — 12.8c had
  already shipped auto-update via the Tauri updater key; only MSI/CA code signing are still parked.
- Reason: This is the exact class of stale-doc-claim problem 13.1 exists to fix, discovered incidentally
  while editing the same paragraph. Fixing it in place cost one sentence and prevented shipping a slice
  literally named "Truth & small fixes" next to a doc claim it should have caught.
- Type: Better approach found (in-scope opportunistic fix, not scope creep — same file, same paragraph,
  same category of defect the slice targets).

## Skipped Items

None. All four 13.1 tasks (CONTEXT.md, exports.ts, lastSyncAt, updater-key runbook) were implemented.
The plan's own GOTCHA for the updater-key task — "the ceremony itself is the maintainer's manual
action... the slice ships the runbook + verifies the config wiring, not the real key" — was honored: no
real key was generated; `git check-ignore .secrets/tauri-updater.key` was used to verify the wiring
instead, as the plan's VALIDATE step specifies.

## Recommendations

- **Plan command improvement:** when a plan's CONTEXT REFERENCES section names a target file for an
  edit (e.g. "add the runbook here" for `docs/guide/operations.md`), it would help to note whether that
  file already has *related* content nearby that might conflict — a quick grep for the feature's own
  keywords (here, "updater signing key") in the target file during planning would have surfaced the
  pre-existing 12.8c blurb and let the plan explicitly say "consolidate with 12.8c" rather than leaving
  the executor to discover and resolve the conflict mid-implementation.
- **Execute command improvement:** for any task that writes a multi-step shell runbook into a doc,
  explicitly prompt for a "does step N's working directory match what step N-1 assumed" pass — this is
  exactly the bug the code-review step caught here, and it's a class of error that's cheap to check
  mechanically (trace the assumed CWD across the whole runbook) but easy to miss when writing steps
  sequentially.
- **CLAUDE.md addition (possible):** the "Tooling gotchas (Windows)" section could note that
  `vitest.global-setup.ts` migrates `DATABASE_URL_TEST` unconditionally whenever it's configured in
  `.env`, so *any* vitest invocation — not just `*.int.test.ts` — requires Docker to be reachable, or an
  explicit `DATABASE_URL_TEST=` override for a scoped unit-test-only run. This is implied by existing
  memory (`test-db-not-migrated-by-db-migrate`) but the "even unit-only file selections need Docker up"
  corollary isn't spelled out anywhere and cost a debugging detour this session.
