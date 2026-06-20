# Execution Report — M12 Slice 12.2a (Dashboard Foundation + Read Surfaces)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice2a-dashboard-read-surfaces.md`
- **Branch:** `m12-slice2-dashboard-surfaces`
- **Files added (30):**
  - Foundation: `apps/dashboard/src/lib/proxy.ts` (+`proxy.test.ts`), `lib/types.ts`,
    `lib/format.ts` (+`format.test.ts`), `components/app-nav.tsx`, `components/page-shell.tsx`
  - Proxy routes (11): `app/api/projects/route.ts`,
    `app/api/projects/[id]/{summary,usage,usage/by-model,usage/over-time,git,sessions}/route.ts`,
    `app/api/reports/route.ts`, `app/api/reports/[id]/route.ts`, `app/api/search/route.ts`,
    `app/api/workspaces/route.ts`
  - Pages (5) + views (5): `app/projects/page.tsx` + `components/projects/projects-view.tsx`;
    `app/projects/[id]/page.tsx` + `components/projects/project-detail-view.tsx`;
    `app/reports/page.tsx` + `components/reports/reports-view.tsx`; `app/search/page.tsx` +
    `components/search/search-view.tsx`; `app/machines/page.tsx` +
    `components/machines/machines-view.tsx`
  - Process docs: `.agents/code-reviews/…`, this report
- **Files modified (7):** `apps/dashboard/src/app/layout.tsx`,
  `components/monitor/alerts-panel.tsx`, `components/monitor/monitor-view.tsx`,
  `vitest.config.ts`, `SUMMARY.md`, `docs/PRD.md`, `docs/guide/usage.md`
- **Lines changed (approx):** +1,361 new dashboard source/test + (+61/−28) across modified
  tracked files.

## Validation Results

- **Syntax & Linting:** ✓ (`next build` compiles clean; no lint errors surfaced)
- **Type Checking:** ✓ — `npm run typecheck:dashboard` (`tsc --noEmit`) 0 errors; root
  `npm run typecheck` (`tsc -b`) 0 errors (dashboard is out of that graph by design — D9)
- **Unit Tests:** ✓ — `proxy.test.ts` (5) + `format.test.ts` (10) pass; full suite **456 passed /
  63 files**, 0 failed
- **Integration Tests:** ✓ (n/a to this slice — zero backend change; no new `*.int.test.ts`. The
  full `vitest run` inside `repo-health` ran green; `--require-db` not required per the plan since
  neither `@420ai/db` nor `apps/ingest` was touched)
- **Build gate:** ✓ — `npm run build:dashboard` builds 22 routes
- **`npm run repo-health`:** ✓ PASS (NUL scan, artifact scan, root + dashboard + desktop
  typechecks, full vitest)
- **D8 token-leak:** ✓ — runtime grep of served HTML for a canary `ADMIN_TOKEN` == 0 on every page
  and the API proxy

## What Went Well

- **Spike-fidelity proxy.** `proxyJson`/`proxyStream` distilled verbatim from the three existing
  monitor proxies; the one intentional behavior change (forward upstream status vs collapse to 502)
  is unit-tested and lets pages distinguish 404/401/400 from an unreachable 502.
- **Per-surface build gate caught nothing late.** Building after each surface (Projects → all)
  meant the only iteration was an early test-typing fix; every surface compiled first try.
- **Type-package boundary held.** Importing projection types (ISO `string`) from `@420ai/shared`
  and mirroring only the db-origin `Date`→`string` rows locally (`lib/types.ts`) avoided pulling
  `@420ai/db` into the dashboard — exactly the "#1 risk" the plan flagged.
- **Zero backend blast radius.** No change to `apps/ingest`/`packages/db`/`packages/shared`/schema;
  root `tsc -b` stayed green throughout.

## Challenges Encountered

- **vitest could not resolve `@/` aliases.** The first `typecheck:dashboard` *passed* but the proxy
  test would not have *resolved* `@/lib/ingest` under vitest, because vitest uses Vite
  `resolve.alias`, not tsconfig `paths` (no `vite-tsconfig-paths` plugin). Required a one-line
  alias addition to the root `vitest.config.ts`. (See Divergence 1.)
- **Mock typing vs `tsc`.** `vi.fn(async () => …)` infers a zero-arg signature, so
  `mock.calls[0]` typed as an empty tuple and `typecheck:dashboard` failed even though the test
  *ran* green. Fixed by typing the mocks as `vi.fn<typeof fetch>()` — a reminder that a passing
  vitest run does not imply a passing dashboard typecheck (the two lanes are independent — D9).
- **Existence vs malformed-id semantics.** A well-formed-but-unknown project uuid returns *zeroed*
  projections (200), not 404, so the detail page had to use the project list as the existence
  authority to render a real "not found" state (and to get the name, which no projection carries).

## Divergences from Plan

**1. Added a `@` alias to `vitest.config.ts` (test infra)**

- Planned: "entirely additive new files under `apps/dashboard/`"; only `layout.tsx`/`page.tsx`/
  `alerts-panel.tsx`/docs listed as edits.
- Actual: added `"@": apps/dashboard/src` to the root vitest `resolve.alias`.
- Reason: `proxy.ts` is the first `@/`-importing file pulled into the vitest graph; without the
  alias `proxy.test.ts` cannot resolve `@/lib/ingest`. Safe beside `@420ai/*` (plugin-alias
  requires a `/` after the key, so `@` matches only `@/...`).
- Type: Plan assumption wrong (the "additive only" scope didn't account for test-infra resolution).

**2. Pure-render surfaces kept as Server Components (no `"use client"`)**

- Planned: each page "hands to a `"use client"` component, mirroring `MonitorPage → LiveMonitor`."
- Actual: only the genuinely-interactive views are client (`reports-view` row-select,
  `search-view` query box). `projects-view`, `project-detail-view`, `machines-view` are Server
  Components.
- Reason: `LiveMonitor` needs the client only for SSE + `useState`; the read surfaces without
  interactivity ship zero client JS as Server Components. Same UX, less hydration.
- Type: Better approach found.

**3. Consolidated `formatAgo` in `monitor-view.tsx` too (code-review fix)**

- Planned: only `alerts-panel.tsx` listed for the `formatAgo` import swap.
- Actual: `monitor-view.tsx`'s byte-identical copy was also replaced with the `lib/format` import.
- Reason: leaving monitor-view's duplicate defeats the extraction's DRY purpose; caught in code
  review.
- Type: Better approach found.

**4. `app-nav.tsx` is a small client island, not a Server Component**

- Planned: "keep it a server component … isolate active-link highlight in a small client child if
  added."
- Actual: the whole nav is one `"use client"` file using `usePathname()` for active highlighting.
- Reason: a single tiny island is simpler than a server shell + client child for the same result;
  it carries no data/token, so the boundary is cheap.
- Type: Better approach found.

## Skipped Items

- **Headless-Edge screenshots against live data.** Substituted HTTP-layer evidence (served-HTML
  token-leak grep == 0; nav + heading markers present on every page; empty-fallback render
  confirmed). Reason: screenshots require a running ingest + Postgres with seeded data; not
  available in this automated run. CLAUDE.md explicitly pairs headless Edge *with* HTTP-layer
  assertions — the HTTP-layer half is captured and is the load-bearing evidence for D8.
- **Everything the plan marked deferred → 12.2b:** all mutations (report generate/compare, project
  create/rename, catalog approve/reject, workspace remap, reindex, pairing, export, settings), rich
  Markdown/Mermaid rendering, `ts_headline` bold-highlight, list pagination. Intentional scope.

## Recommendations

- **Plan command:** when a plan declares "additive only" for a workspace that has its own test
  lane, add a check for test-resolution config (alias/`paths` parity). The `@/` alias gap was a
  predictable foot-gun that two minutes of "will the new test resolve its imports?" would have
  surfaced at plan time.
- **Execute command:** keep treating `typecheck:dashboard` and `vitest run` as **independent**
  gates — a green vitest run masked a real `tsc` failure here. The execute flow's "run both" is
  correct; worth stating explicitly that one passing does not imply the other.
- **CLAUDE.md:** consider a one-line note under "Frontend workspace" that **vitest resolves via
  Vite aliases, not tsconfig `paths`**, so any new `@/`-importing tested helper needs the root
  vitest `@` alias (now present). This is the second time the dashboard's independent-lane reality
  has bitten (the first was the typecheck-vs-build split); documenting the alias closes the loop.
