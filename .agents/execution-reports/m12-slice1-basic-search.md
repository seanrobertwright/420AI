# Execution Report — M12 Slice 12.1 (Basic Search)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice1-basic-search.md`
- **Files added (source):**
  - `packages/shared/src/search.ts` (42 lines) — result/param types
  - `packages/db/src/repositories/search.ts` (273 lines) — `rebuildSearchIndex` + `searchDocuments`
  - `packages/db/src/repositories/search.int.test.ts` (143 lines) — 5 integration tests
  - `apps/ingest/src/routes/search.ts` (47 lines) — `GET /v1/search`, `POST /v1/search/reindex`
- **Files added (generated migration):**
  - `packages/db/drizzle/0008_violet_wraith.sql`
  - `packages/db/drizzle/meta/0008_snapshot.json`
- **Files added (process artifacts):**
  - `.agents/code-reviews/m12-slice1-basic-search.md`
  - `.agents/execution-reports/m12-slice1-basic-search.md`
- **Files modified:**
  - `packages/db/src/schema.ts` (+51) — `tsvector` customType + `searchDocuments` table
  - `packages/db/src/index.ts` (+4) — barrel re-export of the two repo fns
  - `packages/db/drizzle/meta/_journal.json` (+7) — migration journal entry
  - `packages/shared/src/index.ts` (+1) — re-export search types
  - `apps/ingest/src/schemas.ts` (+17) — `searchQuerySchema`
  - `apps/ingest/src/app.ts` (+2) — register `searchRoutes`
  - `docs/guide/usage.md` (+18) — search endpoint docs
  - `SUMMARY.md` (+~50) — §6 12.1 marked DONE with deferrals
  - `docs/PRD.md` (+~10) — §25 M12 12.1 marked DONE with deferrals
- **Lines changed:** tracked diff +218 / −8, plus ~505 lines across the new source/test/migration files.

## Validation Results

- **Syntax & Linting:** ✓ (NUL-byte scan + stray-artifact scan clean via `repo-health`)
- **Type Checking:** ✓ root `tsc -b` exit 0 (covers cross-project/test-only imports)
- **Unit Tests:** ✓ 441 passed / 0 failed (61 files)
- **Integration Tests:** ✓ 121 ran, 0 skipped, 0 failed (incl. the 5 new `search.int.test.ts`)
  under `repo-health -- --require-db`
- **Manual (HTTP layer):** ✓ reindex `{reports,projects,sessions}` counts; ranked session hit with
  `[REDACTED:anthropic_key]` snippet; type filter; 401/400/404 gates; 0 raw-secret rows;
  `EXPLAIN` shows `Bitmap Index Scan on search_documents_gin`.

## What Went Well

- **The plan's spikes paid off exactly as advertised.** `drizzle-kit generate` emitted the
  `tsvector` GENERATED column + GIN index verbatim (`0008_violet_wraith.sql`) with zero
  hand-editing, and the SQL applied cleanly to live PG17 — the two highest-risk unknowns were
  already retired, so Phase 1 was mechanical.
- **Mirroring existing repos kept everything consistent.** `transcript.ts` gave the decrypt loop,
  `exports.ts:304` the decrypt→redact ordering, `projections.ts` the read shape, and the int-test
  harness (`ingestBatch` encrypted seeding, `describe.skipIf`, TRUNCATE) transplanted directly.
- **The redaction gate held end-to-end.** The live HTTP test showed the embedded `sk-ant-…` secret
  masked in both the returned snippet and the stored `body`, with `REDACTION_VERSION` stamped.
- **The barrel name-collision (table vs query fn both `searchDocuments`)** was resolved cleanly by
  keeping the table out of the barrel and aliasing it `searchDocumentsTbl` inside the repo —
  exactly as the plan's residual-risk note predicted.

## Challenges Encountered

- **Empty local archive made the first manual curl pass return all-zeros.** The `420ai` dev DB had
  no sessions/reports/projects, so `reindex` legitimately returned `{0,0,0}`. I seeded a throwaway
  row via the real `ingestBatch` path (not raw SQL, to exercise encryption), demonstrated a real
  redacted ranked hit through the live server, then TRUNCATEd back to empty — so the evidence is
  real without polluting the dev archive.
- **Running an ad-hoc `.mts` seed under Windows/tsx:** `tsx -e "…await import"` failed (top-level
  await under the cjs eval shim); `npx tsx --env-file=.env <file>` worked.
- **Code review surfaced a genuine robustness gap** (see Divergences): the reindex was not atomic.

## Divergences from Plan

**Atomic reindex via a transaction**

- **Planned:** the plan's `rebuildSearchIndex` pseudocode did `await db.delete(searchDocuments)`
  then per-source inserts with no enclosing transaction.
- **Actual:** the whole delete + rebuild is wrapped in `db.transaction(async (tx) => …)`, with all
  inner queries routed through `tx`.
- **Reason:** without it, a decrypt/key error mid-loop (the session path throws by design) would
  commit the DELETE and leave a partial index — `GET /v1/search` would silently return incomplete
  results until a later reindex succeeded. Every other multi-write repo (`ingest`, `git`,
  `reports`, `pricing-catalogs`) already wraps its sequence in `db.transaction`; this restores
  consistency with that codebase standard.
- **Type:** Better approach found (robustness / standard adherence). Caught by `/lril:code-review`.

**Barrel export style for shared types**

- **Planned:** `export type { … } from "./search.js"` in `packages/shared/src/index.ts`.
- **Actual:** `export * from "./search.js"`.
- **Reason:** the existing shared barrel uses `export *` for every module; `search.ts` is
  types-only so `export *` re-exports them identically. Followed the codebase over the plan's
  literal snippet.
- **Type:** Plan assumption wrong (cosmetic — matched local convention).

## Skipped Items

None of the slice scope was skipped. Explicitly **deferred** (named in `SUMMARY.md`/PRD, not built):

- Incremental / at-ingest index maintenance (manual reindex only — keeps the hot ingest path
  untouched).
- Per-event / per-tool-call result granularity (session-grained docs only).
- Advanced semantic / vector search (**V2**, PRD §21).
- Search **UI** (M12 Slice 12.2 — dashboard surfaces).

## Recommendations

- **Plan command:** when a plan provides repository pseudocode that performs a multi-statement
  delete-then-rebuild (or any multi-write sequence), it should default to showing the
  `db.transaction(tx => …)` wrapper, the way it already mandates the aggregate-SQL normalization.
  This class of atomicity gap is easy to copy straight from the pseudocode.
- **Execute command:** the "seed an empty archive to produce real manual evidence" step was
  improvised; worth codifying a tiny reusable seed helper (or documenting the
  `npx tsx --env-file=.env <script>` invocation) so HTTP-layer evidence on an empty dev DB is a
  standard move rather than ad-hoc.
- **CLAUDE.md:** add a one-liner under the Drizzle/SQL gotchas — "**Any repo function that does a
  delete-then-rebuild or multi-row write MUST wrap it in `db.transaction`** (a `DbClient` supports
  it; nested = savepoint) so a mid-sequence throw can't leave a half-built projection." This
  generalizes the M12 finding alongside the existing FK/aggregate gotchas.
