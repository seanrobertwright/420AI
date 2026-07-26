# Execution Report — M15 Slice 15.2: Request Principal

## Meta Information

- **Plan file:** [`.agents/plans/m15-slice2-request-principal.md`](../plans/m15-slice2-request-principal.md)
- **Code review:** [`.agents/code-reviews/m15-slice2-request-principal.md`](../code-reviews/m15-slice2-request-principal.md)
- **Branch:** `m15-slice2-request-principal` (base `91a882b`)
- **Lines changed:** +906 −377 across 57 files (54 modified, 3 source files added)

**Files added**

- `packages/db/src/repositories/principal.ts` — `Principal` + `findPrincipalByEmail`
- `packages/db/src/repositories/principal.int.test.ts` — 10 repository-layer tests
- `apps/ingest/src/principal.int.test.ts` — 12 HTTP-layer tests

**Files modified (54)** — `apps/ingest/src/auth.ts` (`adminAuthorized` deleted, `resolvePrincipal`
added), `plugins/auth.ts` (`request.principal` augmentation + decorator), `server.ts` (bootstrap
admin identity seed), all **16** gated route files, the report/interpretation orchestrators
(`generate-report.ts`, `generate-report-m13.ts`, `generate-interpretation.ts`); `packages/db`
repositories `principal`, `projections`, `report-projections`, `workspaces`, `search`, `reports`,
`transcript`, `attribution`, `exports`, `git`, `projects`, `alert-firings`, `pairing`,
`organizations`, `reparse`, plus `index.ts`; 17 int-test suites; `CLAUDE.md`; `SUMMARY.md`.

**No migration, no schema change, no dashboard change, no `apps/collector` change** — as planned.

## Validation Results

| Gate                                | Result                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Type Checking (root `tsc -b`)       | ✓ exit 0                                                    |
| Syntax & Linting (`npm run lint`)   | ✓ exit 0                                                    |
| Formatting (`npm run format:check`) | ✓ exit 0                                                    |
| SUMMARY consistency                 | ✓ PASS                                                      |
| Unit + Integration (`vitest run`)   | ✓ **863 passed / 863**, 113 files                           |
| `repo-health -- --require-db`       | ✓ **PASS** — 222 integration tests ran, **0 skipped**       |
| `build:dashboard`                   | ✓ exit 0                                                    |

**Level 5 assertions:** `adminAuthorized` → 0 code references (4 surviving prose comments);
`app.adminEmail` in route files → 0 code references (1 prose comment); `superseded by the 15.2
request principal` markers → 0.

**Live verification against the real archive** (beyond the plan). Booted `server.ts` on the
production DB: `ADMIN_TOKEN` → 200 on `/v1/projects` and `/v1/auth/me`. Then compared old-vs-new
rollup counts across **all 59 projects / 413,765 events** — `differs = false` on every row, 0 null
`org_id`. The new org predicates are exactly behaviour-neutral on real single-org data, which is
the property that matters most: a predicate mismatch against 15.1's backfill would have silently
zeroed every rollup, and no seeded test could have caught it.

## Deviations From Plan

1. **Repository signatures changed BEFORE route conversion**, not after (plan ordered Phase 2 then
   Phase 3). Same end state, but each route file was touched exactly once with final signatures
   instead of twice.
2. **Nine more functions org-scoped than the plan enumerated** — see below.
3. **`createPairingCode` deliberately NOT converted** to `principal.orgId` (see below).
4. **`server.ts` changed** — the plan listed no `server.ts` edit; a regression forced one.

## Findings Beyond the Plan

**1. `tsc` is a FILE-level checklist, not a call-site one.** Deleting `adminAuthorized` was
predicted to raise ~45 errors, one per gate. It raised **16** — one per file, on the failed named
`import`. TypeScript binds a failed import as an error type and stops re-reporting at each usage.
D-15.2-1's claim that "`tsc -b` is the completeness proof for this slice" is therefore false at
call-site granularity; the Level 5 grep is what actually proves completeness. Recorded in CLAUDE.md.

**2. Nine functions had the same defect the plan did not enumerate.** The plan listed six
`project_path`-joined rollups. The identical join also appears in `report-projections.ts`
(`toolStatsByModel`, `failureSeries`, `failedToolBreakdown`, `contextPathSample` — two of which
decrypt payloads), `git.ts` (`gitCommitsByProject`), `attribution.ts` (`projectSessionIds`), and —
found in code review — `exports.ts` (`exportEvents`). `tsc` flagged none of them: their signatures
did not change, so they compiled while merging tenants. **The compiler enumerates callers of
changed signatures; it never enumerates peers with the same latent bug.**

**3. The plan's chosen fix did not deliver the property it claimed.** The plan states FIX A
(`eq(events.orgId, orgId)`) was chosen over FIX B because it "scopes to the principal's org rather
than a value derived from the row, so it also enforces 'you cannot read another org's project' —
one predicate, both properties." An assertion added while writing the tests disproved this: org B
querying org A's project id got back **3** (its own events, attributed to a project it does not
own), not 0. Both predicates are needed — `eq(events.orgId, orgId)` for ISOLATION and
`eq(workspaceKeys.orgId, orgId)` for OWNERSHIP. Applied to all eleven joined reads.

**4. Unscoped project WRITES.** `renameProject` and `archiveProject` were keyed on project uuid
alone — one tenant could rename or archive another's project. `getProjectName` was the existence
check on the report-generation path, so another org's project **name** rendered into your report
Markdown. All three now org-scoped.

**5. A deployment-breaking regression, surfaced by the existing int suites (73 failures).**
`resolvePrincipal` requires `adminEmail`'s user to exist, but `server.ts` created it only via
`setUserPassword`, **gated on `ADMIN_PASSWORD`**. Token-only deployments (desktop app,
`scripts/generate-reports.mjs`, no dashboard login) would have 401'd on every admin route — a direct
violation of D-15.2-3's promise that the service token "preserves today's behaviour exactly". The
plan anticipated this only as a startup-ordering curiosity ("fresh boot before the seed"); it is the
steady state for that configuration. Fixed by seeding the bootstrap identity unconditionally.

## Bugs Written And Caught During Execution

**`createPairingCode` — a cross-org write, self-caught.** Converting it to take `principal.orgId`
seemed to follow the plan's rule. It is wrong: a pairing code is minted **for a target user** whom
`POST /v1/pairing-codes` may name via `body.email`, so the caller's org would be stamped on a row
whose `user_id` belongs to a different org — exactly the cross-org row 15.1's schema exists to
prevent. Reverted, with the reasoning captured in `organizations.ts`. Both values are `string`; the
compiler cannot distinguish them. The generalised rule now in CLAUDE.md: **a row's `org_id` must
match the org of whoever the row BELONGS to, which is the principal only when the principal is also
the owner.** The same reasoning is why the four `getOrgIdForUser` seams on the machine-authed
discover path legitimately survive rather than being force-retired.

## Code Review Outcome

Four findings, all fixed in-branch (detail in the review file):

- **critical** — `exportEvents` project branch had no org predicate. Worst instance of the class:
  it returns whole event ROWS (not aggregates) as json/jsonl/csv/parquet, and `redactJson` strips
  PII patterns, not other tenants' records. Pinned by two new regression tests, **both verified to
  fail with the fix reverted** and pass with it restored.
- **medium** — dead conditional + `userId ?? ""` + false comment left in `routes/exports.ts`.
- **medium** — `ackAlertFiring` lacked the org predicate its siblings (`setLinkStatus`,
  `listReportArtifacts`) got in the same slice.
- **low** — `reparse.ts`'s session-keyed query is correctly deployment-wide but undocumented, so it
  read as a missed site.

## What Went Well

- **Deletion over deprecation (D-15.2-1) was right**, even though the error count was a fifth of
  the estimate. It made all 16 affected files impossible to miss and forced every one open.
- **Writing tests that assert the CLAIM, not the code.** The `usageTotals` ownership assertion and
  the two export regression tests each found something the implementation had got wrong. Reverting
  a fix to confirm its test actually fails is cheap and turned "probably covered" into "covered".
- **The existing int suites earned their keep.** 73 failures were not noise — they were the suites
  faithfully modelling a token-only deployment and reporting that it would break.
- **Checking the real archive.** Behaviour-neutrality on 413,765 backfilled events is the one
  property seeded tests structurally cannot verify.

## What Was Difficult / Friction

- **The plan's call-site inventories were floors, not ceilings.** Every enumerated list (45 gates,
  20 resolutions, 6 rollups, 9 markers) was accurate for what it counted, but three of them were
  incomplete as a statement of the work. Deriving sites from the RULE — "a read keyed by a
  connector-supplied string" — found nine more than the lists did.
- **Argument-position bugs are invisible to the compiler.** `(db, orgId, userId, …)` vs
  `(db, userId, orgId, …)` typechecks either way. D-15.2-4's fixed second position helps in review
  but is not enforcement; the org/ownership mismatch in `createPairingCode` was caught by reasoning,
  not tooling.
- **Scripted bulk edits need a syntax gate immediately.** A regex that injected an import member
  ate a separating comma in 9 files; `tsc` did not run between the edit and the test run, so it
  surfaced as 9 vitest parse errors instead of one immediate failure.

## Recommendations for Future Slices

1. **Pair every "delete the old helper, let `tsc` enumerate" plan with a grep assertion**, and state
   the expected error count as file-count, not call-site-count.
2. **When a plan justifies choosing fix A over fix B on a claimed property, write the test for that
   property first.** The FIX A/FIX B rationale had been spike-verified for isolation and simply
   assumed for ownership.
3. **After scoping reads, sweep the WRITE paths keyed by the same id.** `renameProject` /
   `archiveProject` were more serious than several of the reads the plan did enumerate.
4. **When a slice adds a precondition (here: "the admin user must exist"), grep the boot path for
   where that precondition is established** — and check it is not gated on an unrelated env var.
5. **15.3 must land next.** Application scoping is currently the only isolation (milestone Risk #1).
   The nine functions this slice found beyond its own plan are the argument for the RLS backstop:
   the class is wider than any hand-built inventory.

## Non-Goals (named per plan requirement)

Role **enforcement** is 15.4 (`Principal.role` is resolved and carried, but no route branches on
it). Stateful/revocable sessions are 15.6. `ADMIN_TOKEN` retirement is 15.9. Pairing-code user
creation is 15.5. RLS is 15.3.
