# Execution Report — M14 Slice 14.4: Per-event search granularity

## Meta Information

- Plan file: `.agents/plans/m14-slice4-per-event-search.md`
- Files added:
  - `packages/db/drizzle/0013_married_tarot.sql`
  - `packages/db/drizzle/down/0013_married_tarot.down.sql`
  - `packages/db/drizzle/meta/0013_snapshot.json` (drizzle-kit auto-generated)
  - `.agents/code-reviews/m14-slice4-per-event-search.md`
- Files modified:
  - `packages/shared/src/search.ts`
  - `packages/db/src/schema.ts`
  - `packages/db/drizzle/meta/_journal.json` (drizzle-kit auto-generated)
  - `packages/db/src/repositories/search.ts`
  - `apps/ingest/src/schemas.ts`
  - `apps/dashboard/src/components/search/search-view.tsx`
  - `packages/db/src/repositories/search.int.test.ts`
  - `apps/ingest/src/search.int.test.ts`
  - `packages/db/src/rollback.int.test.ts` (collateral, see Divergences)
  - `.agents/plans/m14-general-ai-chat-capture.md` (14.4 bullet settled)
- Lines changed: +2591 -72 (13 files; 2225 of the additions are the
  auto-generated drizzle snapshot JSON)

## Validation Results

- Syntax & Linting: ✓ `npm run lint` clean; `npx prettier --check` clean on all
  changed files
- Type Checking: ✓ root `tsc -b` (0 errors), `typecheck:dashboard` (0 errors),
  `build:dashboard` (`next build` succeeded)
- Unit Tests: ✓ 757/757 passed (`npm test`, full vitest suite)
- Integration Tests: ✓ 186 integration tests ran, 0 skipped
  (`npm run repo-health -- --require-db`, both dev and test DB migrated to `0013`)

## What Went Well

- The plan's context references were exact — every cited line range
  (`search.ts:58-65`, `transcript.ts:83-89`, `schema.ts:543-568`, etc.) matched
  the actual source, so no time was lost re-locating symbols.
- `db:generate` produced exactly the single-column-add + index SQL the plan
  predicted, non-interactively — no drizzle-kit rename prompt to second-guess.
- Reusing `indexOneSession`'s existing `projectId` attribution and folding
  `indexSessionEvents` into the same function meant the incremental (`indexSessions`)
  and full-rebuild (`rebuildSearchIndex`) paths got per-event indexing "for free"
  with zero duplicated logic, exactly as the plan intended.
- The redact-then-store gate held per-event on the first try — the `events ⋈
  raw_source_records` join mirrored from `transcript.ts` needed no debugging.
- Live manual verification (paired machine → ingested a session with a secret →
  logged into the dashboard → searched) worked end-to-end on the first pass:
  hybrid grouping, the synthesized session-id header under a `type=event` filter,
  and the zero-`ADMIN_TOKEN`-in-HTML check all passed without iteration.

## Challenges Encountered

- The full `npm test` run and the `repo-health -- --require-db` run each take
  ~2 minutes; ran both in the background and polled via the task-notification
  mechanism rather than blocking, which worked but added a few
  wait/check-in round trips to the session.
- `git commit` was blocked once by the pre-commit hook's dashboard-typecheck
  lane failing on a corrupted `.next/dev/types/routes.d.ts` — a Next.js
  auto-generated (gitignored) file that got truncated mid-write when the manual-
  verification `next dev` server was killed via `TaskStop`. Not a source-code
  issue; resolved by deleting `apps/dashboard/.next` and letting
  `typecheck:dashboard` regenerate it cleanly.

## Divergences from Plan

**Collateral test fixes for two pre-existing tests broken by the new hybrid rows**

- Planned: the plan's Task 6 listed specific NEW tests to add; it did not flag
  that adding event docs would break any EXISTING test.
- Actual: two pre-existing integration tests failed on the first full-suite run
  after the hybrid rows started matching queries that previously only matched
  session docs, and were fixed:
  1. `apps/ingest/src/search.int.test.ts` — "paginates GET /v1/search with
     offset" ingested two sessions sharing one phrase and paginated with
     `limit=1`, asserting the two returned entity ids were the two session ids.
     Once that phrase also matched each session's new `message.user` event doc,
     `entityType` "event" sorts before "session" in the deterministic tiebreak
     (`asc(entityType)`), so offset 0/1 returned the two EVENT fingerprints
     instead. Fixed by adding `&type=session` to scope the test back to its
     original intent (event-type filtering already has its own dedicated test).
  2. `packages/db/src/rollback.int.test.ts` — "rolls back the latest migration
     (0012)" hardcoded 0012 as the latest tracked migration and asserted a
     tracked-migration count of 13. Migration `0013` (this slice) is now
     latest, so `rollbackLast()` rolled back 0013, not 0012, and the count
     was 14/13/14, not 13/12/13. Updated the test to target `0013` and assert
     against the `search_documents.session_id` column instead of the M13
     `alert_firings.resolve_delivered_at` column it previously used as its
     down-migration marker.
- Reason: both are inherent, mechanical consequences of adding a new migration
  and new hybrid-matching rows — not scope creep, not avoidable by planning
  more carefully (the plan can't predict which future migration number will be
  "latest" at execution time, and the pagination collision only manifests once
  the hybrid rows actually exist and are queried against the SAME seed data the
  pre-existing test happened to reuse).
- Type: Plan assumption wrong (implicit assumption that adding rows to a shared
  table doesn't reach into other tests' fixtures) — low-impact, mechanically
  detected by the very validation gates the plan already mandated.

## Skipped Items

- The plan's "Edge cases to cover" section (Testing Strategy) mentioned two
  edge cases as optional depth, not part of Task 6's required new-test list:
  - `MAX_EVENT_DOCS_PER_SESSION` cap honored for a session with >500 indexed
    events — not written; would require seeding 500+ events, expensive for
    marginal coverage of a one-line `.limit()` call.
  - `tool.call.completed` with a NULL raw-record join (defensive skip, not a
    crash) — not written; the `innerJoin` used in `indexSessionEvents` makes
    this structurally impossible to hit (an inner join simply excludes the row,
    it can't produce a NULL join partner), so the "edge case" was already
    unreachable by construction and a test for it would be testing SQL
    semantics, not application logic.
  - Reason for both: Task 6 explicitly enumerated the required new tests
    separately from this "edge cases to cover" list, and marked the UI-grouping
    unit extraction as "(optional)" — treated the required list as the gate and
    the rest as already covered by design/architecture.
- The optional `groupHitsBySession` pure-function unit-test extraction
  (Testing Strategy: "if a reviewer wants a unit, extract... and test it
  (optional)") was not split into a separate module — kept it as a local
  function in `search-view.tsx` since no reviewer requested the extraction and
  the function is already exercised end-to-end by the live manual verification.
  - Reason: explicitly marked optional in the plan; no signal it was needed.

## Recommendations

- Plan command improvements: for slices that add rows to a shared,
  already-covered table (like this hybrid-rows change), it would help to add a
  standing checklist item — "grep existing `*.int.test.ts` files for queries
  against the same seed phrases/fixtures this slice's new rows will also match"
  — to catch the pagination-test class of collateral breakage during planning
  rather than during execution.
- Plan command improvements: similarly, a migration-adding slice could note
  "this will become `rollbackLast`'s target — check `rollback.int.test.ts` for
  a hardcoded migration number/count" as a standing pre-flight check, since
  it's a predictable, mechanical consequence of any new migration.
- Execute command improvements: none — the validate-as-gate discipline
  (typecheck → unit → `--require-db` → lint → prettier → manual browser check)
  caught every regression before commit, exactly as designed.
- CLAUDE.md additions: consider noting that `next dev`/`next build` processes
  killed via a background-task stop (rather than a graceful SIGINT) can leave
  `.next/dev/types/routes.d.ts` truncated mid-write, which fails the
  `typecheck:dashboard` pre-commit lane with a confusing parser error at an
  unrelated line — the fix is always `rm -rf apps/dashboard/.next` (gitignored,
  safe to delete) followed by re-running `typecheck:dashboard` to regenerate it.
