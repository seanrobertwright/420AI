# Execution report — M15 slice 15.6 (sessions + revocation)

## Meta

- **Plan**: `.agents/plans/m15-slice6-sessions-revocation.md` (14 tasks, 6 spikes run during planning)
- **Code review**: `.agents/code-reviews/m15-slice6-sessions-revocation.md` — TWO passes; the second
  used three independent reviewers (correctness/races, security/tenancy, tests/standards) and found
  the two most serious defects, both missed by the first. 14 findings, 13 fixed.
- **Branch**: `m15-slice6-sessions-revocation`, branched from `main` (which carries 15.5 via PR #65)
- **Decisions made**: D-15.6-1 … D-15.6-9 (recorded in `SUMMARY.md` §6 and in the code)

### Files added (9)

| Path                                                    | Purpose                                             |
| ------------------------------------------------------- | --------------------------------------------------- |
| `packages/db/drizzle/0018_warm_living_mummy.sql`        | the `sessions` table — and NO policy block           |
| `packages/db/drizzle/down/0018_warm_living_mummy.down.sql` | a bare `DROP TABLE`; no policy-ordering hazard    |
| `packages/db/drizzle/meta/0018_snapshot.json`           | drizzle-generated                                   |
| `packages/db/src/repositories/sessions.ts`              | mint / find-live / revoke-one / revoke-all / list    |
| `packages/db/src/repositories/sessions.int.test.ts`     | two-role repository suite (15 tests)                |
| `apps/ingest/src/sessions.int.test.ts`                  | two-role HTTP suite (23 tests) — **the centrepiece** |
| `apps/dashboard/src/app/api/auth/logout/route.test.ts`  | logout ORDERING unit test (added in review)         |
| `.agents/plans/…`, `.agents/code-reviews/…`             | plan + review record                                |

### Files modified (19)

`packages/db`: `schema.ts`, `index.ts`, `repositories/rls.int.test.ts`, `rollback.int.test.ts`,
`repositories/users.ts`, `drizzle/meta/_journal.json`.
`apps/ingest`: `auth.ts`, `session.ts`, `session.test.ts`, `server.ts`, `routes/auth.ts`,
`routes/members.ts`, `routes/monitor.ts`, `routes/org-scoping.test.ts`, `principal.int.test.ts`.
`apps/dashboard`: `app/api/auth/logout/route.ts`, `lib/session.test.ts`.
Root: `SUMMARY.md`, `docs/guide/operations.md`.

No collector, desktop or Rust file changed. **No npm dependency added or upgraded.**

## Validation results

| Level             | Command                                    | Result                                    |
| ----------------- | ------------------------------------------ | ----------------------------------------- |
| Type checking     | `npm run typecheck` (root `tsc -b`)        | ✓ exit 0                                  |
| Dashboard types   | `npm run typecheck:dashboard`              | ✓ exit 0                                  |
| Linting           | `npm run lint` (ESLint 9 flat)             | ✓ exit 0                                  |
| Formatting        | `npm run format:check` (incl. `.md`)       | ✓ exit 0                                  |
| Unit tests        | `vitest` non-infra                         | ✓ passed (15 in the two session files)    |
| Integration tests | `*.int.test.ts` against live PG            | ✓ **347 ran, 0 skipped**, 0 failed        |
| THE GATE          | `npm run repo-health -- --require-db`      | ✓ **PASS**, 1037 tests / 128 files        |
| Dashboard build   | `npm run build:dashboard`                  | ✓ Edge middleware import graph intact     |
| Rollback drill    | `rollback.int.test.ts` (0018 down + re-up) | ✓ in CI, not by hand                      |
| Mutation check    | revocation lookup removed                  | ✓ 11/20 failed, **all positives passed**  |
| Manual (L4)       | live server, real HTTP                     | ✓ 200 → revoke-all → 401; `ADMIN_TOKEN` unregressed |

Integration count rose 309 → 347 with the two new suites plus the review's regression tests.

## The mutation check — the finding, not just the fact that it ran

The plan required proving the discriminator assertion actually discriminates. Removing the
`findLiveSession` lookup from `resolvePrincipal` produced **11 failures / 9 passes**:

- **Passed (correctly):** role identity, all three positive assertions, malformed-id 400, the
  session list, both `ADMIN_TOKEN` tests.
- **Failed (correctly):** discriminator, all-routes, isolation, logout, revoke-one, password change,
  password reset, sid-less token, unknown/non-uuid sid, expired row, revoke-all idempotence.

The plan's stated gate — *"if the positive test fails too, the suite is over-coupled"* — held.

Two results diverged from the plan's prediction, and both are worth recording:

1. **The isolation test FAILED**, where the plan predicted it would pass. That is because it also
   asserts A's *own* session died, not merely that B's survived. A B-only assertion would pass
   trivially, so the stronger version was kept.
2. **"Removing a member signs them out" PASSED under the mutation** — the 401 came entirely from the
   missing membership (`findPrincipalByEmail` returns null). That is exactly the *accidental*
   fail-closed mechanism the plan's Problem Statement §3 describes, the one that evaporates when
   15.10 ships multi-org users. The extra `revoked_at IS NULL` count assertion also stayed green,
   because the mutation broke ENFORCEMENT, not the revoke itself. So that test proves the row is
   **stamped**, not that enforcement works — now recorded in the test's own comment so no future
   reader mistakes it for a discriminator.

## What the second review pass found (and why there was one)

The first review pass checked whether the code did what the plan said. It passed. The second pass —
three independent reviewers, each told to PROVE findings by running something — asked a different
question: what does this code CLAIM that it cannot actually do? That question found the two real
defects, and both were of the same shape as the slice's own subject matter.

1. **Revocation did not reach an open SSE stream.** `GET /v1/monitor/stream` hijacks the socket and
   serves the org's live snapshot on a timer; `resolvePrincipal` gated it once, at connect. Proven
   against a live server: after `revoke-all` had made every other route 401, the stream delivered
   six more frames and kept going — still performing the org's reconcile WRITES and still firing
   outbound alert delivery, on behalf of someone who had just been removed from the org. The
   canonical use case for this entire slice is "remove an employee, sign them out", and the one
   long-lived thing they had open was what it missed.

   The gap is the smaller half. The slice ASSERTED there was none: `auth.ts` said "THIS IS THE ONE
   ENFORCEMENT POINT… there is deliberately no second place to check", and a test was titled
   "revocation reaches EVERY authenticated route". That test is built on `app.inject`, which cannot
   observe a hijacked socket — it was structurally incapable of catching this, which is
   `bypassed ≠ enforced` one layer out from where CLAUDE.md already warns about it.

2. **A login racing a password reset survived it.** Reproduced at the HTTP layer with a stagger:
   login reads the hash, spends ~100 ms in scrypt, then INSERTS its session row, while the reset's
   `revokeAllSessions` — a blind UPDATE — cannot see a row that does not exist yet. A session minted
   from the OLD password stayed valid for 7 days, which is exactly the takeover-recovery failure
   D-15.6-6 exists to close. The repository comment saying "no lock needed" was true for
   revoke-vs-revoke and silent about revoke-vs-INSERT: CLAUDE.md's "name the mechanism" rule
   violated by omission rather than by error.

   Fixed with a `FOR SHARE` lock on the user row held across the login's scrypt. Both orderings are
   safe and both are named in the code: login-first makes the reset wait and then revoke the new
   row; reset-first makes the login re-evaluate under EvalPlanQual and refuse the old password.

**The fix for (2) then reproduced the slice's own lesson.** The first regression test for it was
written at the HTTP layer and passed identically with and without the lock — because
`hashPassword`/`verifyPassword` are blocking scryptSync, so two handlers serialise on the event loop
and the interleaving cannot be driven from outside. That is CLAUDE.md's 15.5 corollary verbatim, and
it was reached by walking into it rather than by remembering it. Deleted and rewritten at the
repository layer with two hand-held transactions; the discriminating assertion is that the
credential-change UPDATE is still unsettled after a wait, and it fails when `FOR SHARE` is removed.

**Every behaviour-changing fix carries a regression test verified to FAIL without it** — the SSE
re-check, the login lock, the logout ordering. Writing the logout ordering test also exposed a third
bug: the handler promised the cookie is cleared "even if the ingest hop fails" but had no `try`, so
anything raised outside `proxyJson`'s internal catch skipped the delete and stranded the user
signed-in — in precisely the case the comment said it would not.

## What went well

- **The plan's six spikes all held.** 0015's `ALTER DEFAULT PRIVILEGES` really did cover a table
  created three migrations later (`420ai_app` got DELETE/INSERT/SELECT/UPDATE with no `GRANT` —
  re-verified live), the extra `sid` claim really did survive the dashboard's Edge `atob` path
  untouched, `UPDATE … WHERE revoked_at IS NULL RETURNING id` really is idempotent, and SPIKE 6 was
  the highest-value one: `TRUNCATE … users … CASCADE` clears `sessions` **without naming it**, which
  removed ~20 fixture edits from the slice. Zero fixture files needed changing.
- **Keeping `verifySession` database-free was the load-bearing design choice.** It is what makes the
  discriminating assertion expressible at all: "the MAC still verifies and `exp` is in the future,
  yet the request 401s" excludes expiry, tampering and a wrong secret as explanations. Had the
  lookup been folded into `verifySession`, no test could have told revocation from rejection.
- **Making `sid` a REQUIRED 4th parameter on `signSession` while keeping it OPTIONAL on
  `SessionPayload`** did exactly what it was designed to do. The arity change reported **one error
  per call site** (3 production + 6 test), unlike the 15.2 lesson where a deleted import collapsed
  to one error per FILE — so `tsc` genuinely was a call-site checklist here. Paired with a `grep`
  anyway, per CLAUDE.md.
- **Consolidating three mint sites into one `mintSession` helper** was not in the plan (which showed
  the code inline at each site). It leaves exactly ONE production `signSession` call site, and it
  puts the "row `expires_at` and token `exp` derive from the same TTL" invariant in one place where
  it cannot drift.
- The slice shipped **no new typed error** and **no new dependency**, as planned.

## Challenges encountered

- **The rollback drill broke, and correctly so.** `rollbackLast` reverses *the latest* migration, so
  `rollback.int.test.ts` — pinned to 0017 by 15.5 — failed the moment 0018 landed
  (`expected 19 to be 18`). The plan's Task 3 validation assumed a clean pass. It has to be
  retargeted by every slice that adds a migration; that is inherent, not a defect.
- **Two `principal.int.test.ts` tests would have passed for the wrong reason.** The compiler forced
  both call sites to be touched, but the *mechanical* fix (pass any uuid) would have made both
  requests fail at the session lookup and never reach the assertions they exist for — the
  "no membership" test in particular would have stopped exercising the membership check entirely
  while staying green. This is the sharpest instance of the slice's own lesson: a required-parameter
  change makes the compiler point at every call site, but the compiler cannot tell you whether your
  fix preserved what the test was *for*.
- **One scenario turned out to be unconstructible.** "A live session whose `sub` has no user row"
  cannot exist once `sessions.user_id` has an FK to `users`. The test was re-scoped to the
  unknown-`sid` path it now actually exercises, rather than being deleted or left misleadingly named.

## Divergences from plan

| Divergence                                                         | Why                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rollback.int.test.ts` retargeted 0017 → 0018                      | Not anticipated; `rollbackLast` always reverses the latest. Its new load-bearing assertion is that the **policy count does not move** (59 → 59 → 59), which pins 0018's missing policy block as a decision rather than an omission. |
| Two `principal.int.test.ts` tests re-grounded, not just re-typed    | See above — the mechanical fix would have hollowed them out.                                                                                                              |
| `org-scoping.test.ts`'s `auth.ts` exemption reason extended         | The stated reason ("reads `users` to ESTABLISH identity") stopped covering the file once it also read and wrote `sessions`. The "no stale entries" test only catches an allow-listed file that no longer EXISTS, never one whose reason quietly stopped being true. |
| Three inline mint blocks → one `mintSession` helper                 | Plan showed the code inline at each of the three call sites; a helper removes the drift risk it warns about in the same breath.                                            |
| A `docs/guide/operations.md` note on session-row growth added       | Not in the plan. Found during review: rows are never purged. Documented (with a safe manual `DELETE`) rather than fixed — see below.                                       |
| Residual risk 1 did not materialise                                 | `findAdminCredential` already returned `id`; no widening needed.                                                                                                          |

The plan left ONE decision to the executor (residual risk 2): a non-uuid `sid`, guard vs catch.
**Chosen: guard.** `isUuid` runs before the query in `resolvePrincipal`, so a hand-forged non-uuid
`sid` costs a regex rather than a Postgres `22P02` round trip, and the repo-wide "malformed id → 401,
never a DB-cast 500" invariant holds. Pinned by a test asserting **401, not 500**.

## Skipped items

- **Level 5 (headless-Edge dashboard round-trip).** Level 4 already proves the revocation path
  end-to-end through real HTTP, and the D-15.6-4 residual means the browser's expected result is
  "shell renders, data 401s" — which is asserted at the layer that enforces it (ingest). Deliberate,
  not an omission.
- **A session-row purge job.** Rows are stamped, never deleted, so `sessions` grows by one row per
  login. Verified harmless rather than assumed: `findLiveSession` is a primary-key probe, so growth
  is free on the hot path, and `listSessions` filters to live rows. Not fixed here because retention
  interacts with 15.10's audit table, and deleting revocation history now would pre-empt that
  decision. Documented in `docs/guide/operations.md` with a safe manual `DELETE`.

## Recommendations

### Plan command improvements

- **A plan that adds a migration should carry "retarget `rollback.int.test.ts`" as an explicit
  task.** This is the second slice in a row where the drill's validation command was written as if
  it would simply pass. It never will — the test is pinned to whatever migration is latest.
- **When a plan changes a function's arity, it should say what to do at TEST call sites, not just
  production ones.** This plan predicted "exactly 3 errors" and named the three production sites;
  the compiler produced 9. The extra 6 were the dangerous ones, because the mechanical fix silently
  degrades what those tests prove.

### Execute command improvements

- **The mutation check should record which tests passed, not only which failed.** The most valuable
  output of this slice's check was a test that PASSED when it should not have been able to
  discriminate. A checklist that only asks "did the right things fail?" would have missed it.

### CLAUDE.md additions

Proposed, based on what this slice measured:

- **"A required-parameter change is a call-site checklist; it is not a semantics checklist."**
  Unlike a deleted import (15.2), an arity change on a successfully-imported function reports one
  error per call site — so `tsc` really does find them all. But at a TEST call site, the mechanical
  fix that satisfies the compiler can silently move the failure earlier and hollow out what the test
  proved. After changing a signature, re-read every test the compiler pointed at and ask what it was
  *for*, not just whether it compiles.
- **"When a new FK makes an old test's scenario unconstructible, re-scope the test — do not delete
  it and do not leave its name lying."** 15.6 made "a live session for a `sub` with no user row"
  impossible by construction. The honest move is to assert the path that IS now reachable and say
  in the test why the original one no longer exists.
