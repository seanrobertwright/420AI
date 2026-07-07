# Execution Report — M13 Slice 13.4: Incremental search + dashboard polish

## Meta Information

- **Plan file:** `.agents/plans/m13-capability-gap-closure.md` (Slice 13.4)
- **Branch:** `m13-slice4-incremental-search`
- **Files added:**
  - `apps/dashboard/src/components/reports/report-markdown.tsx` — react-markdown + remark-gfm + lazy-mermaid client island
  - `apps/dashboard/src/lib/snippet.ts` — `splitSnippet` (`<b>`-pair segmentation, no innerHTML)
  - `apps/dashboard/src/lib/snippet.test.ts` — 10 unit cases incl. marker-chars-in-values
  - `apps/ingest/src/search.int.test.ts` — 7 HTTP-e2e cases (incremental indexing + pagination)
  - `.agents/code-reviews/m13-slice4-incremental-search.md` — pre-commit review
- **Files modified:**
  - `packages/db/src/repositories/search.ts` — extracted `indexSessions` (chunked) + `indexProjectDoc`/`indexReportDoc`; `searchDocuments` offset + deterministic tiebreaker; rebuild reuses the incremental builds
  - `packages/db/src/repositories/projects.ts`, `reports.ts` — optional `{limit, offset}` (applied only when provided)
  - `packages/db/src/index.ts` — barrel exports for the three indexers
  - `apps/ingest/src/routes/ingest.ts`, `projects.ts`, `reports.ts`, `interpretations.ts` — best-effort doc refresh at every mutation site; list pagination pass-through
  - `apps/ingest/src/routes/search.ts`, `apps/ingest/src/schemas.ts` — `offset` on search; list querystring schemas
  - `apps/dashboard/src/components/search/search-view.tsx` — `<strong>` highlight rendering + offset pager
  - `apps/dashboard/src/components/reports/reports-view.tsx` — `ReportMarkdown` swap + pager
  - `apps/dashboard/src/components/projects/projects-view.tsx` — client component + pager
  - `apps/dashboard/src/app/projects/page.tsx`, `reports/page.tsx` — explicit first-page `limit=50`
  - `apps/dashboard/src/app/api/projects/route.ts` — GET forwards the querystring
  - `apps/dashboard/package.json` + `package-lock.json` — `react-markdown@^10`, `remark-gfm@^4`, `mermaid@^11`
- **Lines changed:** +5,245 −2,280 (≈4,700 of the additions are `package-lock.json` for the three new deps)

## Validation Results

- Syntax & Linting: ✓ (prettier clean on all touched files; eslint 0 errors on backend files; dashboard files are outside the flat-config on purpose — they typecheck/build via their own lane)
- Type Checking: ✓ root `tsc -b` 0 errors; ✓ `typecheck:dashboard` clean
- Unit Tests: ✓ (full `vitest run` green)
- Integration Tests: ✓ `repo-health -- --require-db` PASS — **179 integration tests ran, 0 skipped** (re-run after the code-review fixes)
- Build: ✓ `next build` green (validates the three new deps bundle)
- **Level 4 (live, not skipped):** started ingest + the rebuilt dashboard, logged in with the real admin credentials, drove headless Edge over the DevTools protocol with the session cookie injected:
  - `/reports` renders **1 mermaid SVG** (screenshot-verified pie chart + GFM tables)
  - `ADMIN_TOKEN` occurrences in the fully rendered HTML = **0** (D.18)
  - Incremental search live: a just-created project + generated report hit `q=m134` with `<b>` highlights, no reindex call ever issued
  - Residue: fixture project `m134-verify` + one `project.cost_over_time` artifact left in the dev archive (additive; archive if unwanted)

## What Went Well

- The plan's file:line anchors were all accurate — `upsertDoc` privacy, the `:169-222` session-doc block, the `plainSnippet` location, and the missing-offset schema state matched source exactly, so the refactor was mechanical.
- The extracted `indexSessions`/doc-builder split let `rebuildSearchIndex` reuse the incremental code path verbatim — one implementation of the decrypt→cap→redact discipline, no drift risk.
- CDP-driven headless Edge (cookie injected via `Network.setCookie`) turned the "manual" Level-4 items into scripted, assertable checks — mermaid SVG count and token-leak grep both automated.
- `websearch_to_tsquery`'s default `<b>` markers meant zero server-side changes for highlighting, exactly as the plan predicted.

## Challenges Encountered

- **Fire-and-forget indexing deadlocked Postgres in the int suite** (`40P01`): detached promises from report-generation requests raced the next test's `TRUNCATE` (index upsert's FK check vs. the truncate's AccessExclusiveLock). Surfaced in the *existing* 13.2 suite, not the new one.
- **Port 3000 was already occupied** by a running dashboard instance during Level 4 — verification ran on 3100 against the freshly built bundle (and an initial verify accidentally hit the stale server; killed by PID and re-verified).
- react-markdown v10 removed the `inline` prop, so mermaid fences are intercepted at the `pre` level (`CodeFence`) rather than in the `code` renderer.

## Divergences from Plan

**1. Fire-and-forget → awaited-with-swallow index maintenance**

- Planned: "fire-and-forget `indexSessions(app.db, touchedSessionIds)` with `.catch(log)`"
- Actual: `await` inside try/catch at all four mutation sites; failures log and never fail the response
- Reason: detached promises deadlock against concurrent DDL (proven by the int-suite `40P01`), and the plan's own named model — `deliverFirings` (monitor.ts:102-108) — is awaited-with-swallow, not detached. The load-bearing intent (hot ingest transaction untouched; response never fails on index errors) is fully preserved; the decrypt work (capped at 48k chars/session) now adds bounded latency to the mutation response instead of racing it.
- Type: Plan assumption wrong

**2. Omitted `limit` returns the full list (not default 50)**

- Planned: "`limit` (default 50, max 200)"
- Actual: `limit`/`offset` apply only when the client sends them; the dashboard list pages pass an explicit `limit=50` for their first page
- Reason: the code review found three existing consumers that require the complete list — the project-detail page uses `GET /v1/projects` as its **existence authority** (>50 projects would render older projects as "not found"), the workspace-remap picker, and the collector's `getProjects`. Slice 13.6's planned generate-reports script also needs completeness. A server default of 50 with a hard max of 200 would leave larger archives unable to enumerate at all. The plan's intent (bounded UI pages + Load more) is delivered at the UI call sites.
- Type: Plan assumption wrong (blast radius of the default was not enumerated)

**3. `indexSessions` chunks its id list (500/query)**

- Planned: not specified
- Actual: the meta lookup runs in 500-id chunks
- Reason: the rebuild path funnels *every* distinct session id through one `inArray`; PG's wire protocol caps bind params at 65,535
- Type: Performance/robustness issue found in review

**4. `skipHtml` on react-markdown + deterministic search tiebreaker (additions)**

- `skipHtml`: visual verification showed the renderers' `<!-- -->` source-of-truth comments as literal page text; `skipHtml` drops raw-HTML nodes (still never parses them — no rehype-raw).
- `searchDocuments` orders by `(rank desc, entityType, entityId)` so equal-rank offset pages never duplicate/drop hits.
- Type: Better approach found

## Skipped Items

- None from the slice's task list. (Milestone-level items — SUMMARY.md/PRD §25 update, remaining slices 13.5–13.7 — are later tasks per the plan's completion checklist.)

## Recommendations

- **Plan command improvements:** when a plan changes a list endpoint's *default* behavior (default limit, ordering), require the plan to enumerate existing consumers of that endpoint (grep evidence), the same way it already enumerates symbols. Both real bugs this slice came from unenumerated blast radius.
- **Execute command improvements:** "fire-and-forget DB work" should be treated as a red flag during execution — if the referenced precedent is awaited (deliverFirings), match the precedent, not the phrase.
- **CLAUDE.md additions:** consider a line under the Drizzle/SQL gotchas: "Detached (un-awaited) DB promises in route handlers deadlock against TRUNCATE-based int suites — best-effort side writes are awaited-with-swallow (`deliverFirings` pattern). Bound every `inArray` id list (PG caps bind params at 65,535)."
- **Env hygiene (for the user):** `.env` contains `AURI_SIGNING_PRIVATE_KEY` — almost certainly a typo of `TAURI_SIGNING_PRIVATE_KEY`; the 13.1 runbook's release-build env var will not resolve until renamed.
