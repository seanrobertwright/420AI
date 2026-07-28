# Execution report — M15 slice 15.4 (RBAC)

## Meta

- **Plan file:** [`.agents/plans/m15-slice4-rbac.md`](../plans/m15-slice4-rbac.md)
- **Code review:** [`.agents/code-reviews/m15-slice4-rbac.md`](../code-reviews/m15-slice4-rbac.md)
- **Lines changed:** +1269 / −305 across 77 files (11 added, 66 modified)

### Files added

| Path                                                    | What                                                     |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `packages/shared/src/roles.ts`                          | The ordered ladder, `hasRole`, `isRole`, `SERVICE_ROLE`  |
| `packages/shared/src/roles.test.ts`                     | Table-driven unit tests over all 4×4 pairs + failures    |
| `packages/db/drizzle/0016_strong_magus.sql`             | `project_grants` + 1 org policy + 39 RESTRICTIVE         |
| `packages/db/drizzle/down/0016_strong_magus.down.sql`   | Rollback (43 statements, policies before table drops)    |
| `packages/db/drizzle/meta/0016_snapshot.json`           | drizzle-kit snapshot                                     |
| `packages/db/src/repositories/project-grants.ts`        | Grant CRUD + `effectiveProjectRole`                      |
| `packages/db/src/repositories/project-grants.int.test.ts` | Two-role grant suite                                   |
| `apps/ingest/src/authorize.test.ts`                     | Unit tests for the route gate helper                     |
| `apps/ingest/src/rbac.int.test.ts`                      | **The slice's proof** — two roles, three users, one org  |
| `apps/dashboard/src/lib/mutation-error.ts`              | Shared 403 wording for the UI                            |

### Files modified (grouped)

- **Core:** `packages/db/src/org-context.ts` (+`role`, +`ROLE_SETTING`), `schema.ts`
  (`projectGrants`), `index.ts` (barrel), `packages/shared/src/index.ts`
- **Repositories (7):** `monitor.ts`, `projections.ts`, `projects.ts`, `workspaces.ts`, `git.ts`,
  `alert-firings.ts`, `reports.ts`, `attribution.ts`, `principal.ts`
- **Ingest (20):** `auth.ts` (+`authorized`), `app.ts` + `plugins/auth.ts` (throttle decorators),
  16 route files, `reports/generate-report*.ts`, `analysis/generate-interpretation.ts`
- **Tests (16):** 15 `buildApp` call sites gained `reconcileThrottleMs: 0`; `rls.int.test.ts`
  (re-keyed inventory), `rollback.int.test.ts` (0016 drill), `tenancy.int.test.ts`,
  `org-context.test.ts`, `org-scoping.test.ts`, 6 repository int suites
- **Dashboard (9):** 9 mutation components gained a 403 branch
- **Docs:** `CLAUDE.md`, `SUMMARY.md`, `docs/guide/operations.md`,
  `apps/collector/src/connectors/connector-approvals.ts` (D-15.4-5 header)

## Validation results

| Gate                                    | Result                                              |
| --------------------------------------- | --------------------------------------------------- |
| Root `tsc -b` (`npm run typecheck`)     | ✓ 0 errors                                          |
| `npm run typecheck:dashboard`           | ✓ 0 errors                                          |
| `npm run lint`                          | ✓ 0 errors (caught 4 dead `userId` locals mid-slice) |
| `npm run format:check`                  | ✓ clean                                             |
| `npm run build:dashboard`               | ✓ PASS                                              |
| Unit tests                              | ✓ 680 passed, 0 failed                              |
| Integration tests                       | ✓ **262 ran, 0 skipped**, 0 failed                  |
| `npm run repo-health -- --require-db`   | ✓ **PASS** (942 tests total)                        |
| Rollback drill (0016 down + re-up)      | ✓ 55 → 15 → 55 policies                             |
| Negative-test falsifiability            | ✓ backstop tests go RED under `WITH CHECK (true)`   |

Suite grew 916 → 942 (+26).

## What went well

- **The arity change did exactly what D-15.4-4 predicted.** Making `role` a required fourth
  parameter of `withOrg` produced 240 compiler errors across 20 files — one *per call site*, not
  one per file. `tsc` handed over the complete worklist before a single call was edited, which is
  the opposite of the 15.2 `adminAuthorized` experience. The plan's decision to reject an optional
  parameter was correct and saved the slice.
- **Mechanical width was genuinely mechanical.** 63 `withOrg` sites and 45 route gates were
  scripted (one pass each, driven by a per-file role matrix) rather than hand-edited, then verified
  by `tsc` + two independent greps. The gate insertion script asserted the expected count per file
  and threw on any shape it did not recognise, so a silently-skipped handler was not possible.
- **The plan's spike output was accurate.** Every behaviour Spike 1/1b predicted held against the
  real database: viewer INSERT/UPDATE loud, viewer DELETE silent, viewer SELECT unaffected, unset
  role permissive, role does not survive COMMIT. Nothing had to be re-measured.
- **Layered validation caught things in the right order.** `lint` found dead locals `tsc` cannot;
  the structural grep suite found nothing (it was already satisfied); the *behavioural* two-role
  suite found two real bugs; and `/lril:code-review` found two more that all three had missed. Each
  layer earned its place.

## Challenges encountered

- **The plan contained an internal contradiction on the central question of the slice** (see
  Divergence 1). Resolving it required weighing task 9's literal wording against the Problem
  Statement, D-15.4-2 and test 18.8 — three of which agreed against the fourth.
- **Evaluate-on-read makes a GET a WRITE, and nothing in the plan said so.** The plan carefully
  reasoned about `deliverFirings` needing `SERVICE_ROLE` but did not extend the same reasoning to
  the snapshot's own reconcile, which sits one call up the stack. The result was a 500 on
  `GET /v1/monitor` for every viewer — invisible to `tsc`, to the structural greps and to all 916
  pre-existing tests, because none of them had ever built a non-owner user.
- **Seeding a second-rung org member is not an INSERT.** `setUserPassword` calls
  `ensurePersonalOrg` internally, so every seeded user already holds a personal `owner` membership,
  and `findPrincipalByEmail` resolves the *first* by `(created_at, id)`. Adding a `viewer`
  membership was therefore shadowed, and the first run of `rbac.int.test.ts` had four role tests
  passing a viewer through admin-gated endpoints. The suite failed loudly, but only because it
  asserted 403 — a suite that asserted 200s would have been green and meaningless.
- **Two hand-written `hasRole` guards were correct by coincidence.** Found in code review, not by
  tests: `RANK` is an object literal, so `RANK["toString"]` is a function, not `undefined`, and the
  documented `!== undefined` guard never fires for inherited keys. Everything still returned
  `false`, via `NaN >= 0`. The unit test asserting this behaviour passed for the wrong reason.
- **Bash heredocs failed twice** on content mixing backticks and quotes; both times the fix was to
  write the file with the Write tool and `cat` it. Consistent with the CLAUDE.md Windows note, and
  worth generalising (see Recommendations).

## Divergences from plan

### 1. Nine of the twelve reads scope by org INSTEAD OF user, not alongside it

- **Planned:** Task 9 — "add `orgId` as the **second** parameter and an `eq(<table>.orgId, orgId)`
  predicate **alongside the existing `userId` predicate** (both, never one)."
- **Actual:** `machineStatuses`, `activeSessions`, `recentBacklogSamples`, `connectorHealth`,
  `connectorHealthWindowed`, `listProjects`, `listWorkspaces`, `remapWorkspace` and (after review)
  *not* `gitCommitDetail` — nine reads dropped `userId` entirely and scope by `org_id` alone.
  `listAlertFirings`, `createProject`, `resolveWorkspaceId` and `gitCommitDetail` keep both.
- **Reason:** Task 9 contradicts three other parts of the same plan. The Problem Statement names
  the defect as *"these reads start returning **partial** results for the org (a member cannot see
  their colleague's machines)"*; D-15.4-2 states *"Every org member sees every org project"*; and
  task 18.8 requires that a viewer's `GET /v1/monitor` lists a machine owned by another user.
  With both predicates that test cannot pass — and it did not, on the first run. Adding `orgId`
  alongside `userId` fixes only the *isolation* half of the defect and leaves the *partial results*
  half intact. The four exceptions each have a structural reason recorded at the call site:
  `alert_firings` is unique on `(user_id, alert_key)`, `session_git_links` on
  `(user_id, session_id, commit_id)`, `workspace_keys` on `(user_id, project_key)` — those rows
  genuinely are per-user, and org-widening a read over a per-user unique index returns an
  arbitrary row rather than a merged one.
- **Type:** Plan assumption wrong (task 9's wording was inherited from the 15.2 convention, where
  org and user were still 1:1 — the exact property this slice ends).

### 2. The monitor snapshot runs under `SERVICE_ROLE`, not `principal.role`

- **Planned:** Task 8 — principal-authed handlers pass `principal.role`; only alert *delivery* was
  singled out for `SERVICE_ROLE`.
- **Actual:** Both `withOrg` wrappers around `buildSnapshot` pass `SERVICE_ROLE`.
- **Reason:** `buildSnapshot` calls `reconcileAlertFirings`, which is an upsert plus a bulk update.
  Under a viewer's role the 0016 restrictive INSERT policy rejects it and `GET /v1/monitor` returns
  **500 to every read-only member of the org** — measured, not predicted. The plan's own argument
  for `deliverFirings` applies verbatim one call up the stack: the write is the org's bookkeeping,
  triggered by whoever opened the dashboard, not the caller's mutation. The route's `viewer` gate
  is what authorizes the read.
- **Type:** Plan assumption wrong (the plan treated the reconcile as part of a read path).

### 3. `POST /v1/projects/:id/git/suggest` gated at `member`

- **Planned:** absent from the task-14 role matrix entirely.
- **Actual:** gated at `member`.
- **Reason:** it is a POST that persists `session_git_links` rows. Leaving it ungated would have
  been the one unguarded write in the slice; `viewer` would let a read-only account write.
- **Type:** Other (plan omission).

### 4. `insertReportArtifact` takes `role` as its second positional parameter

- **Planned:** task 8 said repository-internal functions "take an explicit `role` parameter threaded
  from their caller" without specifying position.
- **Actual:** `insertReportArtifact(db, role, a)` — role before the row object, not inside it.
- **Reason:** `a` is spread into `.values({ ...a, version })`, so a `role` field on it would try to
  insert a non-existent column. The org id already lives on `a`, so the usual "orgId second" rule
  had no position to occupy.
- **Type:** Other (mechanical).

### 5. Two issues found by code review, fixed before commit

- **`hasRole` guard** — `!== undefined` replaced with `Object.hasOwn(RANK, role)`. The documented
  invariant ("fails closed") was being satisfied by `NaN >= 0` coercion rather than by the guard,
  for every key inherited from `Object.prototype`. Not exploitable, but this is the authorization
  primitive.
- **`gitCommitDetail`** — restored its `machines.userId` predicate (keeping both org predicates).
  Org-widening it while its entire neighbourhood stayed per-user turned a clean 404 into a silently
  unattributed manual git link. Moved into the "keeps `userId`" group with the other three.
- **Type:** Security concern / Other.

## Skipped items

- **Level 4.2 — live 403 in a browser.** The 403 path is proven at the HTTP layer
  (`rbac.int.test.ts` asserts both the status and the `{"error":"insufficient role"}` body), the
  dashboard forwards it unchanged (`proxy.ts` already forwarded `res.status` verbatim — confirmed,
  no proxy change needed), 9 mutation components now render a distinct message, and
  `build:dashboard` passes. What was **not** done is driving a real browser as a seeded viewer.
  Reason: it needs a running stack plus a hand-seeded second user, and every layer beneath it is
  covered. Worth doing at milestone sign-off.
- **`.agents/qa/m15-signoff/` evidence directory.** Level 4 evidence is recorded in this report and
  the code review rather than as separate artefacts.
- **Fixing `projectEventSummary.lastActivity`** — explicitly out of scope per the plan's NOTES;
  still open as the next truth-slice item.

## Known follow-ups

- `app.reconcileLastRunAt` is never pruned (bounded by distinct `(org, user)` pairs per process;
  negligible self-hosted, relevant at M16).
- The throttle stamps its timestamp before the await, so a *failed* snapshot consumes its window.
  Accepted: moving the stamp re-opens the double-reconcile race the plan called out.
- Org-wide manual git-linking would need `session_git_links`' unique index changed from
  `(user_id, session_id, commit_id)`; deferred with the reasoning recorded in `git.ts`.

## Recommendations

### Plan command

- **Cross-check the task table against the acceptance criteria and the test list before shipping a
  plan.** Divergence 1 was findable at plan time: task 9 and task 18.8 cannot both be satisfied.
  A plan that states a defect in prose ("a member cannot see their colleague's machines") and then
  prescribes a fix that does not address it is the most expensive kind of plan error, because the
  executor discovers it only after the wide mechanical edit is done.
- **When a plan identifies a call that needs a special role/context, walk the whole call stack.**
  The plan reasoned correctly about `deliverFirings` and missed `buildSnapshot` directly above it.
  "Which other callers are in this same position?" belongs in the task, not in the executor's head.

### Execute command

- **Write the failing test first when the plan says a test should fail before the change.** Task
  18's GOTCHA 3 said exactly this and it paid off twice — test 18.8 exposed Divergence 1, and the
  seeding bug surfaced only because the assertions were 403s rather than 200s.
- **Run `lint` before declaring a wide refactor done**, not only at the end. It found four dead
  locals that `tsc` cannot see, and each was a signal that a predicate had been dropped.

### CLAUDE.md additions

Added in this slice:

- A backstop that cannot be LOUD is not a substitute for a complete gate (RESTRICTIVE RLS blocks
  INSERT/UPDATE loudly but filters DELETE silently — no mechanism exists to change that).
- A `pg_policies` assertion keyed on `tablename` alone silently collapses multiple policies per
  table; re-key on `(tablename, policyname)` rather than bumping the expected number.
- Evaluate-on-read means a GET performs a WRITE — ask "whose action is this?", not "who triggered
  it?".
- `setUserPassword` auto-creates a personal `owner` membership, so seed a second-rung user by
  **moving** their membership, not by adding one.

Worth adding next:

- **Generalise the Windows heredoc note.** It currently covers `\\` and PowerShell here-strings;
  it should also say that content mixing backticks with quotes is unreliable in the Bash tool and
  that the Write tool is the default for any multi-line file content.
