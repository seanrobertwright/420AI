# Execution Report — M12 Slice 12.7c (Connector-catalog-as-data, §10.4)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice7c-connector-catalog-as-data.md`
- **Branch:** `m12-slice7-connector-hardening`
- **Date:** 2026-06-21

### Files added (11 source + 2 process docs)

- `packages/shared/src/connector-catalog.ts` (296) — types, bundled key, baseline, `mergeConnectorCatalog`
- `packages/shared/src/connector-catalog.test.ts` (163)
- `packages/db/src/repositories/connector-catalogs.ts` (169)
- `packages/db/src/repositories/connector-catalogs.int.test.ts` (145)
- `packages/db/drizzle/0011_big_mysterio.sql` (12) + `down/0011_big_mysterio.down.sql` (3) + `meta/0011_snapshot.json`
- `apps/ingest/src/routes/connector-catalog.ts` (103)
- `apps/ingest/src/connector-catalog.int.test.ts` (216)
- `apps/collector/src/connectors/connector-catalog-cache.ts` (144)
- `apps/collector/src/connectors/connector-catalog-cache.test.ts` (150)
- `.agents/code-reviews/…` + `.agents/execution-reports/…` (process)

### Files modified (18)

`packages/shared/src/catalog-signing.ts`, `index.ts`; `packages/db/src/schema.ts`, `index.ts`,
`rollback.int.test.ts`, `drizzle/meta/_journal.json`; `apps/ingest/src/app.ts`, `plugins/auth.ts`,
`schemas.ts`; `apps/collector/src/connectors/registry.ts`, `registry.test.ts`, `cli.ts`, `serve.ts`;
`scripts/sign-catalog.ts`, `scripts/CATALOG-SIGNING.md`; `docs/guide/operations.md`,
`docs/guide/custom-connectors.md`, `docs/PRD.md`, `SUMMARY.md`.

### Lines changed

+470 −56 across modified tracked files; ~1,400 new source lines (excluding the 2,197-line generated
Drizzle snapshot).

## Validation Results

- **Syntax & Linting:** ✓ `npm run lint` exit 0; `npm run format:check` — all files Prettier-clean
- **Type Checking:** ✓ `npm run typecheck` (root `tsc -b`) exit 0
- **Unit Tests:** ✓ all units pass (new: connector-catalog ×11, cache ×11, registry overlay ×5)
- **Integration Tests:** ✓ `npm run repo-health -- --require-db` PASS — **588 tests, 158 integration
  tests ran, 0 skipped** (new: repo lifecycle ×6, endpoints ×5, both against the real test DB)

## What Went Well

- **The pricing-catalog mirror held.** 12.7c-1 (signer + table + repo + endpoints + int tests) was a
  near-mechanical structural copy of the shipped pricing subsystem, exactly as the plan predicted
  (~9.6 confidence). Every symbol was read from the live code, not recalled.
- **Generic signer = zero ripple.** Defaulting `CatalogContent<P = Record<string, ModelPricing>>` made
  the generalization type-only; no pricing call site or test changed, and `canon` bytes are untouched
  (existing signatures still verify).
- **The leaf-shape problem had a precedent.** `ConnectorInfo` (control-protocol.ts) already solved
  "leaf can't import collector," so `ConnectorLike` + an injected `compileCustom` callback dropped in
  cleanly. The generic `<C extends ConnectorLike>` + object-spread overlay preserved `parse`/
  `discoverRoots` on real connectors with no extra code.
- **12.7b coupling was automatic.** Because the overlay yields real `Connector` objects, 12.7b's
  `captureSurfaceFingerprint` fingerprints catalog-sourced scope for free — no wiring needed (the plan
  called this, and 12.7b having shipped first made it true).
- **serve.ts's existing seam design** (injected `connectorRegistry`, `loadCreds`, etc.) let the cache
  overlay + best-effort refresh slot in without touching the leak-window-sensitive executor logic, and
  without breaking a single serve test (they all inject `connectorRegistry`).

## Challenges Encountered

- **The active endpoint needed the signature, unlike pricing.** Pricing's `getActiveCatalog` returns
  `{version, rates}` because the server re-prices locally. The collector instead *pulls* the catalog and
  the plan requires it to re-verify the ed25519 signature (a tampered cache must be ignored) — so the
  signature has to travel with the active payload. This was the one deliberate divergence from the
  pricing twin (see Divergences).
- **serve.ts's leak-window rule vs. an async pull.** `runServe` arms its listeners/timer synchronously
  before any await, so an `await fetch` there would be unsafe (and would have broken the serve tests'
  timing). Resolved by reading the *cached* catalog synchronously and firing the *refresh* pull as a
  guarded one-shot after teardown is armed — capture uses the cache now, a fresh pull applies next start.
- **A stale migration-count tripwire.** `rollback.int.test.ts` hardcoded `0010` as the latest migration
  and asserted exact tracked counts; adding `0011` broke it. Retargeted it to roll back `0011` (real
  coverage for the new down-SQL) rather than weakening the assertion.
- **Test-DB migration is genuinely separate** (per the project memory). `db:migrate` only touched the
  dev DB; the test DB needed an explicit `DATABASE_URL=…_test` migrate pass, else the int tests would
  have failed against a missing table.

## Divergences from Plan

**Active endpoint returns the signature (repo shape)**

- Planned: `getActiveConnectorCatalog` returns `{ version, payload }` (literal pricing mirror).
- Actual: returns `{ version, payload, signature }`; the route ships all three.
- Reason: the collector must re-verify the signature (defense-in-depth — the plan's own edge case
  "tampered cache ⇒ ignored"), which is impossible without the signature on the wire.
- Type: **Plan assumption wrong** (the pricing twin doesn't ship its payload anywhere, so it never
  needed this; the connector catalog does).

**`mergeConnectorCatalog(registry, catalog, compileCustom)` signature**

- Planned: `mergeConnectorCatalog(builtins, customDefs, catalog?)`.
- Actual: overlays an already-assembled registry (built-ins + local customs) and takes an injected
  `compileCustom` callback for data-only entries.
- Reason: keeps collector-specific logic (collision rules, custom-def validation) in the collector and
  the merge pure in the leaf — honoring the plan's own purity GOTCHA. `loadRegistry` composes the two.
- Type: **Better approach found** (composable + keeps the leaf pure; same observable behavior).

**Added a startup-pull timeout (found in code review)**

- Planned: best-effort fetch, "never block capture."
- Actual: `fetchActiveConnectorCatalog` bounds the request with `AbortSignal.timeout(5000)`.
- Reason: `runWatch` awaits the pull; the bare global `fetch` has no timeout, so a *hung* connection
  (not just a refused one) would block capture startup — breaking offline-first. Fixed in the review pass.
- Type: **Security/robustness concern** (caught by review, not the plan).

**`displayName` carried but not applied to the connector**

- Planned: overlay incl. `displayName`; manual-validation bullet implied it surfaces via `connectors.list`.
- Actual: `displayName` is carried as signed catalog metadata (validated, in the type) but NOT written
  onto the `Connector`/`ConnectorInfo` — those have no `displayName` field today.
- Reason: surfacing it would require a cross-cutting change to `ConnectorInfo`/`mapConnectorInfo`/the
  desktop panel — out of 12.7c's scope (a dashboard catalog UI was explicitly deferred). The observable,
  security-relevant overlays (`watchGlobs`/fidelity/permissions/active) are all wired.
- Type: **Scope boundary** (documented; no acceptance criterion depends on displayName).

## Skipped Items

- **Dashboard approve/reject UI** — explicitly deferred by the plan (Level 5 optional; pricing-catalog
  upload also stayed CLI-only). Admin endpoints + offline signer cover the workflow.
- Nothing else from the task list was skipped — all 13 tasks landed.

## Recommendations

- **Plan command:** when a slice copies a "twin" subsystem, call out the *deltas* up front. The plan
  said "mirror pricing 1:1," but the connector catalog has a real consumer (the collector pull) that
  forced two divergences (signature on the wire; the active-endpoint shape). A one-line "where this is
  NOT a mirror" section would have pre-empted both.
- **Execute command:** the offline-first requirement should explicitly include a *timeout*, not just
  error-handling. "Never block capture" is satisfiable by a refused connection but not a hung one — a
  test for the hang case (injected fetch that only settles on abort) is worth making a default pattern.
- **CLAUDE.md addition:** add a note that **int tests asserting an exact migration index/count are
  tripwires** — when adding a migration, expect to retarget `rollback.int.test.ts` (and any count
  assertion) to the new latest, rather than treat the failure as a regression. This recurs every slice
  that adds a migration.
- **CLAUDE.md addition:** the "leaf can't import a downstream app" pattern (mirror the literal-union
  shape + inject the factory callback) is now used by both `ConnectorInfo` and `mergeConnectorCatalog`
  — worth promoting to a named convention so future leaf-side overlays reuse it directly.
