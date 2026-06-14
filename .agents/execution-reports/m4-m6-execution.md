# Execution Report — Milestones 4–6

> **Scope & provenance note.** M6 was executed first-hand in the session that produced this report, so
> its analysis is direct observation. **M4 and M5 were executed in prior sessions** (commits `4207de4`,
> `8c9d74d`, `54d5753`); their analysis here is **reconstructed from artifacts** — the plan files, the
> commit history, the M5 review-fix commit, and the resulting code — not from first-hand recall. Where a
> claim about M4/M5 is inference, it is marked *(inferred from artifacts)*.

---

## Meta Information

| Milestone | Plan file | Commit(s) | Files | Lines |
|---|---|---|---|---|
| M4 — Connectors to full fidelity | `.agents/plans/m4-connectors-full-fidelity.md` | `4207de4` | 20 | +1945 / −22 |
| M5 — Project / workspace mapping | `.agents/plans/m5-project-workspace-mapping.md` | `8c9d74d` (feat) + `54d5753` (review fix) | 39 + 6 | +4258 / −31, then +24 / −18 |
| M6 — Event projections | `.agents/plans/m6-event-projections.md` | *(working tree, uncommitted)* | 10 modified + 4 added | +258 / −25 tracked, ~744 new |

### M6 — files added (first-hand)
- `packages/shared/src/projections.ts` (76) — 7 projection result interfaces + `SessionDetail`
- `packages/db/src/repositories/projections.ts` (305) — 7 read-only aggregate functions
- `packages/db/src/repositories/projections.int.test.ts` (266) — 8 Postgres-gated tests
- `apps/ingest/src/routes/projections.ts` (97) — 7 admin-gated GET endpoints

### M6 — files modified (first-hand)
- `packages/shared/src/cost.ts` (+`CONFIDENCE_ORDER`/`lowestConfidence`), `packages/shared/src/index.ts`
- `apps/collector/src/report/session-report.ts` (consume promoted helper; delete local copy)
- `packages/db/src/index.ts` (barrel export)
- `packages/db/src/repositories/workspaces.ts` + `workspaces.int.test.ts` (pre-existing M5 bug fix)
- `apps/ingest/src/{app.ts,schemas.ts,app.int.test.ts}`, `README.md`

---

## Validation Results

### M6 (observed this session)
- Syntax & Linting / NUL-byte + stray-artifact scans: ✓ (via `npm run repo-health`)
- Type Checking: ✓ root `tsc -b`, 0 errors
- Unit Tests: ✓ all pass
- Integration Tests: ✓ Postgres-gated suite passes (`DATABASE_URL_TEST` in `.env`)
- **Aggregate gate:** `npm run repo-health` → PASS, **183/183 tests across 33 files**
- `npm run db:generate` → "No schema changes" (M6 D1 invariant: zero migration)

### M4 / M5 *(inferred from artifacts)*
- Both shipped as `feat` commits; the repo-health gate and full suite are green at HEAD today (the M6
  run compiles and tests the entire monorepo, including all M4/M5 code, at 0 type errors / 183 passing).
- M5 required a **follow-up review-fix commit** (`54d5753`, 6 files) — evidence its first pass shipped
  with issues caught in review (see Divergences).

---

## What Went Well

**M6 (observed):**
- **Reuse-over-reinvention paid off exactly as planned.** Every M6 projection is `projectEventSummary`'s
  join plus more aggregate columns; the admin routes are `routes/projects.ts` cloned; the int harness is
  `app.int.test.ts` extended. The "minimum new code" thesis held — the novel surface was one SQL idiom.
- **The mandated spike retired the real risk before any production SQL was written.** Running the
  jsonb-sum + `filter` + `array_agg` expressions against the live test DB first confirmed the
  text→number cast and the `string[]` shape, and pinned the exact spelling.
- **Int tests that hand-compute expected aggregates caught a logic-shaped bug** (the phantom null-model
  row) that the type system could not — found by querying the real DB during review, not by reading code.
- **Zero schema drift, verified.** `db:generate` reported no changes, proving the D1 "no migration"
  invariant rather than asserting it.

**M4 / M5 *(inferred):***
- The PRE-FLIGHT "[VERIFIED] against real on-disk files" discipline (Codex/Gemini rollout fixtures in
  M4; the Gemini `.project_root` reverse-map in M5) is visible in both plans and is the same grounding
  approach that made M6's spike cheap. The pattern is clearly working across the milestone series.
- M4's "client-only event-type additions, server stores `event_type` as free text → no migration" and
  M5's "attribution is a JOIN, never a column on events" decisions set M6 up to be purely additive.

---

## Challenges Encountered

**M6 (observed):**
- **Postgres rejected a parameter-bound `date_trunc` unit.** `date_trunc($1, ts)` in SELECT and
  `date_trunc($7, ts)` in GROUP BY are not recognized as the same expression (binding happens after
  expression matching), producing `column "events.ts" must appear in the GROUP BY clause`. Resolved by
  inlining the validated `"day"|"week"` unit as a raw literal so all three clauses share one expression.
- **A latent M5 type bug surfaced only once the gate ran with the DB up.** `projectEventSummary`
  declared `lastActivity: Date` but `events.ts` is `mode:"string"`, so `max(ts)` is a string at runtime;
  `.toISOString()` in the M5 db test threw. It had shipped because M5's gate runs evidently happened with
  the DB down (int tests self-skip). This is the exact failure mode the M1–M3 system review warned about.
- **An unrelated dependency (`headroom-ai`) had crept into `package.json`** mid-session and had to be
  reverted to keep the milestone diff clean.

**M5 *(inferred from the review-fix commit `54d5753`):*** the 6-file fix touching types, scoping,
validation, and ordering indicates the first pass had type/scoping/validation gaps that review caught —
consistent with M5 being the highest-complexity milestone (3 tables + migration + a novel reverse-map +
a new write surface).

---

## Divergences from Plan

**M6 — `date_trunc` unit inlined as a raw literal**
- Planned: `date_trunc(${bucket}, ${events.ts}::timestamptz)` as the group key.
- Actual: derive `const unit = bucket === "week" ? "week" : "day"` and inline via `sql.raw('${unit}')`.
- Reason: a bound parameter breaks Postgres GROUP-BY/SELECT expression matching.
- Type: **Plan assumption wrong** (SQL-dialect detail the plan flagged as the only residual risk).

**M6 — `connectorHealth` scoped via the `machines` join, not `workspace_keys`**
- Planned: Task 4 suggested joining `events→workspace_keys→workspaces` filtered by `workspaces.userId`.
- Actual: joined `events→machines` on `events.machine_id` filtered by `machines.userId`.
- Reason: the `workspace_keys` inner join drops **unattributed** events (Gemini hash sessions), but the
  plan's own edge-case contract requires those to still appear in connector health. The plan offered
  "scope by userId" latitude; the machines join satisfies both constraints.
- Type: **Better approach found** (reconciles two conflicting plan statements correctly).

**M6 — fixed a pre-existing M5 bug outside the stated file set**
- Planned: M6 touches only the projection surface.
- Actual: also corrected `projectEventSummary`'s `lastActivity` type + one stale test assertion.
- Reason: the bug blocked the green-gate requirement once the DB was up; it is the same `ts`-is-a-string
  reality M6 handles correctly.
- Type: **Plan assumption wrong** (latent defect, not an M6 design choice).

**M6 — `usageByModel` phantom-row fix (added during code review)**
- Planned: "group by `events.model`."
- Actual: restricted the GROUP set to `usage.reported`/`cost.estimated` events.
- Reason: grouping over all events produced a misleading `{model: null, tokens: 0, costUsd: 0}` row from
  message/tool/file events (verified against the DB).
- Type: **Better approach found** (output-quality correctness).

**M5 — required a post-merge review-fix pass** *(inferred from `54d5753`)*
- Planned: deliver the mapping layer correct on first pass.
- Actual: a second commit adjusted types, scoping, validation, and ordering across 6 files.
- Reason: not directly observable; the commit message ("address M5 review feedback") indicates a review
  gate (likely this same code-review step) caught them.
- Type: **Other** (process — review-after-execution working as intended).

---

## Skipped Items

**M6 (deliberate, per plan):** no git-history capture, no materialized rollup tables, no
`connector.health` collector emission, no Markdown report artifacts, no AI interpretation, no dashboard —
all explicitly deferred to M7+. None skipped beyond the documented deferrals.

**M6 — three LOW code-review findings accepted, not fixed** (documented with rationale in
`.agents/code-reviews/m6-event-projections.md`): `::int` token cast (deliberate plan choice matching
`projectEventSummary`), project/session reads not userId-scoped (matches shipped M5 `/summary`,
single-user M2), timezone-dependent bucketing (UTC deployment). Fixing them would diverge from the
explicitly-mandated "mirror routes/projects.ts exactly" and is real multi-user hardening for later.

**M4 / M5:** deferrals are documented in their own plans (M5: no dashboard/UI; M4: full taxonomy beyond
the four added event types). Not re-audited first-hand here.

---

## Recommendations

**Plan command**
- The M6 plan was excellent: it pre-identified the one residual risk (jsonb-aggregation SQL spelling)
  and prescribed a spike. **Keep mandating a spike for any "one novel primitive" milestone.** Carry this
  into M7's report-rendering risk.
- When a plan gives two instructions that can conflict (M6 said both "mirror routes/projects.ts exactly"
  *and* "resolve and assert userId for defense"), state which wins. Add a one-line precedence rule.

**Execute command**
- **Run the gate with the integration DB up at least once before declaring done.** The M5 `lastActivity`
  bug proves a green gate with `DATABASE_URL_TEST` unset gives false confidence — the int tests
  self-skip. This is already in the M1–M3 system review; it recurred, so it needs enforcement, not just
  documentation (see CLAUDE.md below).
- **Verify aggregate/projection outputs against the live DB, not just types.** The phantom null-model row
  was invisible to `tsc` and slipped past a Map-based test; a raw query exposed it instantly.

**CLAUDE.md additions**
- Add to the "Validation is a GATE" section: *"Integration tests self-skip without `DATABASE_URL_TEST`.
  Before declaring a DB-touching milestone done, run `repo-health` once WITH the test DB up — a green
  gate with int tests skipped is not green."* This would have caught the M5 bug at M5 time.
- Note the Drizzle gotcha: *"In a raw `sql` template, a column's `mode:\"string\"` parser does NOT apply
  — `max(ts)`/`min(ts)` return strings; type the `sql<...>` result accordingly. And inline closed-set
  units (e.g. `date_trunc` granularity) as raw literals, never bound parameters, or GROUP BY won't match
  SELECT."*
```
