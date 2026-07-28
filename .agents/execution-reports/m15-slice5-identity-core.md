# Execution report — M15 slice 15.5 (identity core)

## Meta

- **Plan**: `.agents/plans/m15-slice5-identity-core.md` (21 tasks, confidence 9.5/10)
- **Code review**: `.agents/code-reviews/m15-slice5-identity-core.md` (6 findings, all fixed)
- **Branch**: `m15-slice5-identity-core`, branched from `m15-slice4-rbac`
- **Commits**: `c3dbbd1` (implementation) + `4c593b5` (review fixes)
- **Lines changed**: +8226 / −82 across 35 files

### Files added (15)

| Path | Purpose |
| --- | --- |
| `packages/db/drizzle/0017_aromatic_maximus.sql` | two tables + 4 policies + email lowercasing |
| `packages/db/drizzle/down/0017_aromatic_maximus.down.sql` | the reversal, policies first |
| `packages/db/drizzle/meta/0017_snapshot.json` | drizzle-generated |
| `packages/db/src/repositories/invites.ts` | mint/preview/redeem/list/revoke + `InviteError` |
| `packages/db/src/repositories/password-resets.ts` | mint/consume + `PasswordResetError` |
| `packages/db/src/repositories/members.ts` | list/find/re-role/remove + `MemberError` |
| `packages/db/src/repositories/members.int.test.ts` | two-role repository suite (12 tests) |
| `apps/ingest/src/delivery/mailer.ts` | `Mailer` over the shared `MailTransport` |
| `apps/ingest/src/delivery/mailer.test.ts` | 5 unit tests, injected fake transport |
| `apps/ingest/src/routes/members.ts` | 6 principal-authed member/invite handlers |
| `apps/ingest/src/identity.int.test.ts` | two-role, multi-user HTTP suite (30 tests) |
| `.agents/plans/…`, `.agents/code-reviews/…`, `.agents/qa/m15-signoff/…` (×2) | plan, review, UAT script + transcript |

### Files modified (20)

`packages/db`: `schema.ts`, `index.ts`, `repositories/{users,principal,organizations}.ts`,
`repositories/{rls,tenancy,project-grants}.int.test.ts`, `rollback.int.test.ts`,
`drizzle/meta/_journal.json`.
`apps/ingest`: `app.ts`, `plugins/auth.ts`, `schemas.ts`, `server.ts`,
`routes/{auth,pairing-codes}.ts`, `routes/org-scoping.test.ts`, `rbac.int.test.ts`.
Root: `.env.example`, `SUMMARY.md`.

No dashboard, collector or Rust file changed (15.10 owns the team UI), and no new npm dependency.

## Validation results

| Level | Command | Result |
| --- | --- | --- |
| Syntax & linting | `npm run lint` (ESLint 9 flat) | ✓ exit 0 |
| Formatting | `npm run format:check` (incl. `.md`) | ✓ exit 0 |
| Type checking | `npm run typecheck` (root `tsc -b`) | ✓ exit 0 |
| Unit tests | `vitest` non-infra | ✓ 685 passed, 0 failed |
| Integration tests | `*.int.test.ts` against live PG | ✓ **304 ran, 0 skipped**, 0 failed |
| THE GATE | `npm run repo-health -- --require-db` | ✓ **PASS**, 989 tests total |
| Rollback drill | `rollback.int.test.ts` (0017 down + re-up) | ✓ in CI, not by hand |
| Manual (L5) | real server, no SMTP, signup unset | ✓ transcript under `.agents/qa/m15-signoff/` |

Integration count rose 297 → 304 with the review's regression tests. The pre-commit hook also
exercises **three** typecheck lanes (root, dashboard, desktop) — the plan named only the first two;
all three are clean.

## What went well

- **The plan's four spikes paid for themselves.** Every one held: 0015's `ALTER DEFAULT PRIVILEGES`
  really did cover a table created by a later migration (no `GRANT` needed in 0017), nodemailer
  resolved without a new dependency, `users.email` really was a case-sensitive plain btree, and the
  two-role harness was genuinely healthy. Nothing had to be re-derived mid-implementation.
- **`orgId` as the mandatory second parameter caught nothing — because it prevented everything.** No
  transposed-argument bug occurred in ~15 new call sites. Cheap conventions that make a class of
  error *visible* beat conventions that make it *detectable*.
- **The GOTCHA-1 regression test failed on demand.** Swapping `createUserWithPassword` →
  `setUserPassword` produced exactly one failure with a legible message (`length of 1 but got 2`).
  The plan's instruction to verify the failure before leaving it green was the single most valuable
  line in the plan.
- **Explicit `*RowColumns` constants stopped a real leak by construction.** `memberRowColumns` is a
  `users ⨝ memberships` join; a bare `select()` would have put `password_hash` on the wire, and no
  route declares a response schema to strip it. The test asserting the exact key set is now the pin.
- **The three-way 409 (D-15.5-9) was the right call.** Rejecting an invite to an existing user
  loudly, rather than inserting a membership that `findPrincipalByEmail` would shadow forever, meant
  no silent path shipped. The plan reasoned this out in advance; discovering it during
  implementation would have cost a day.

## Challenges encountered

- **Three pre-existing suites encoded schema facts as literal counts.** Adding two tables broke
  `rls.int.test.ts` (16→17 org policies), `tenancy.int.test.ts` (tenant-table list) and
  `rollback.int.test.ts` (which asserted 0016 was the *latest* migration and could no longer roll
  back). The plan anticipated only the first. This is the healthy failure mode — the tests exist to
  notice exactly this — but it means "add a table" is never a two-file change here.
- **Deciding `withOrg` per-route required inverting the answer twice within one slice.**
  `routes/members.ts` must wrap (the `invites` policy is permissive *without* a context, so wrapping
  is what makes it enforce); `routes/auth.ts`'s accept path must *not* (the read is what establishes
  the context). Same table, opposite correct answers, adjacent files.
- **The UAT script's own bug read exactly like a product failure.** Each helper called its endpoint
  twice — once to print, once to parse — so step 2's capture hit the invite-dedup 409 and an empty
  token cascaded through nine subsequent steps. Ten "failures", zero real. Rewritten to call once.
- **A concurrency regression test that could not fail.** Finding 6's first version was an HTTP-level
  race test that passed identically with and without the fix, because two requests serialise on
  their own at that granularity. Only a repository-level test with two hand-held transactions —
  asserting tx2 is still unsettled after 500 ms — discriminated.
- **…and that test then failed five innocent tests.** A failing assertion skipped `releaseTx1()`, so
  the held transaction kept its pooled connection and every later test in the file timed out at 10 s.
  One real failure wearing five fake ones. Fixed with a `finally`.

## Divergences from plan

**1. An `admin` could act on an `owner` — the plan's escalation decision was incomplete**

- **Planned**: D-15.5-11, "you may never grant or assign a role above your own", implemented as
  `hasRole(principal.role, requestedRole)` at the invite and PATCH routes.
- **Actual**: added an `outranks()` guard; both `PATCH` and `DELETE /v1/members/:userId` resolve the
  target inside the same `withOrg` transaction and 403 unless the actor's rank ≥ the target's.
- **Reason**: D-15.5-11 is worded entirely about *granting* and is silent about acting on someone
  above you. The implementation matched the decision as written, and the decision was wrong: an
  admin could PATCH an owner to `viewer` (200) and `DELETE` an owner outright (204), since the
  DELETE path compared no roles at all. The last-owner guard bounded that to "never zero owners",
  which is a different and much weaker promise — it evaporates as soon as a second owner exists.
- **Type**: Security concern (plan assumption incomplete).

**2. `hashPassword` ran before token validation on an unauthenticated route**

- **Planned**: reset-confirm → `consumePasswordReset` + `updatePasswordHash` in one transaction.
- **Actual**: same, but with `hashPassword` moved *inside* the transaction after the token validates,
  plus the login rate limit added to reset-confirm and accept-invite.
- **Reason**: scrypt blocks the single-threaded event loop for ~100 ms. Hashing first handed an
  unauthenticated caller a free CPU-exhaustion primitive. The plan listed only signup and
  reset-request as "the two new unauthenticated write endpoints"; there are four.
- **Type**: Security concern.

**3. Env fallbacks needed `||`, not `??`**

- **Planned**: `process.env.SMTP_URL ?? process.env.ALERT_SMTP_URL` (plan Task 15, verbatim).
- **Actual**: `||` at all three sites.
- **Reason**: `??` does not fall through on an empty string, and `.env.example` ships `SMTP_URL=`
  empty — so the documented fallback silently failed for precisely the upgrading operator it exists
  for. The repo already knew this (`server.ts` carries the comment "`||` (not `??`) so an
  empty-string env falls back"); the plan's snippet contradicted the file it was extending.
- **Type**: Plan assumption wrong.

**4. Invite mail failure was unhandled**

- **Planned**: `await app.mailer.send(...)` then 200 (Task 12).
- **Actual**: wrapped in try/catch; on failure returns 200 with `mailed:false`, `mailError:true` and
  the token.
- **Reason**: the row commits before the send and only its sha256 is stored, so an unhandled throw
  meant a 500 with the token gone forever and every retry answering 409 "already pending" — a
  transient SMTP blip permanently blocking one colleague's onboarding. D-15.5-10 already sanctions
  returning the token on this admin-gated route.
- **Type**: Better approach found (plan silent on the failure path).

**5. Reset tokens accumulated**

- **Planned**: `createPasswordReset` mints a token (Task 6). Nothing about prior tokens.
- **Actual**: stamps every outstanding unconsumed token consumed before inserting.
- **Reason**: OWASP requires one active token; two requests left two usable for the full hour.
- **Type**: Security concern.

**6. The last-owner guard's isolation claim was false**

- **Planned**: "the owner count and the mutation must be in the **same transaction**, or two
  concurrent demotions each see two owners and both succeed" (Task 7 GOTCHA).
- **Actual**: `countOwners` selects the owner rows `FOR UPDATE` (rows-then-length, since `FOR UPDATE`
  cannot apply to an aggregate); the header now says the LOCK, not the transaction, serialises it.
- **Reason**: a shared transaction gives atomicity, not isolation. `SELECT count(*)` takes no locks,
  so under READ COMMITTED the plan's stated mechanism does not prevent the race it describes. Not
  reproducible at two-request concurrency, so the **false comment was the real defect** — the next
  reader would have trusted it instead of re-deriving it.
- **Type**: Plan assumption wrong.

**7. `rollback.int.test.ts` retargeted from 0016 to 0017**

- **Planned**: not mentioned. Task 3 said to validate the rollback by hand
  (`npm run db:rollback` against a scratch DB).
- **Actual**: rewrote the existing CI rollback drill for 0017 and added an assertion that the email
  lowercasing is **not** reversed.
- **Reason**: the test rolls back *the latest* migration, which 0017 became — it could not pass
  unchanged. Retargeting was mandatory, and it upgrades the plan's manual step into a CI gate.
- **Type**: Better approach found.

**8. Three small additions the plan did not enumerate**

- `getOrgName` in `organizations.ts` — the invite preview must name the org before any identity
  exists (the plan specified `orgName` in the response but no way to fetch it).
- `findPendingInviteByEmail` in `invites.ts` — so a double-click 409s instead of minting two tokens.
- `findMemberByUserId` in `members.ts` — the plan flagged this as conditional ("if a member-by-id
  lookup does not exist yet"); it did not, so it was added, and the outrank fix later needed it too.
- **Type**: Other (mechanical completions).

## Skipped items

- **`(PR #NN)`** in the `SUMMARY.md` entry is still a literal placeholder pending the PR number.
- **Nothing else.** All 21 tasks were completed, including every `VALIDATE` step, the Level 5 manual
  run and the deliberate-break verification of the GOTCHA-1 test.

## Recommendations

### Plan command improvements

- **A plan that adds a DB table should enumerate every test that encodes the table inventory.** Three
  suites broke; the plan named one. A grep for the new table's siblings (`project_grants`, say)
  across `*.int.test.ts` would have found all three mechanically, plus the four `TRUNCATE` lists.
- **When a plan states a concurrency mechanism, it must name the isolation level.** Task 7's "same
  transaction, or two concurrent demotions both succeed" is false under READ COMMITTED. Any plan
  sentence of the form "X prevents this race" should say *what in X* does the preventing — a lock, a
  unique index, or an isolation level — because "a transaction" alone almost never does.
- **Enumerate unauthenticated write endpoints exhaustively rather than by example.** The plan said
  "the two new unauthenticated write endpoints" and there were four; the two it missed are the two
  that take a token, which is exactly where the reasoning "a token is unguessable, so it needs no
  limit" quietly substitutes for "it needs no rate limit".
- **Copy env-var idioms from the file being edited, not from memory.** The plan's `??` snippet
  contradicted a comment 40 lines above the insertion point.

### Execute command improvements

- **Verify a UAT script's control flow before trusting its output.** A script whose helpers call each
  endpoint twice produces failures indistinguishable from product bugs. One call, capture once,
  parse the captured body.
- **For any regression test of a concurrency fix, remove the fix and confirm the test fails —
  at the layer where it can.** An HTTP-level race test passed both ways; only the repository-level
  one discriminated. This is the plan's own "a test that never failed proves nothing" rule applied
  to a case where the *layer*, not the assertion, was wrong.
- **Any test that holds a transaction open must release it in a `finally`.** Otherwise one failed
  assertion exhausts the pool and reports as N failures, burying the real one.

### CLAUDE.md additions

Two lessons are general enough to earn a place beside the existing 15.1–15.4 entries:

1. **"A shared transaction is atomicity, not isolation."** A read-then-write guard inside one
   transaction is still racy under READ COMMITTED, because `SELECT count(*)` takes no locks. Lock the
   rows the decision depends on (`FOR UPDATE`) and let EvalPlanQual re-check the predicate after the
   lock releases — and say in the comment which mechanism does the work, because a comment claiming
   a guarantee the code does not provide is worse than no comment at all.
2. **"An authorization ladder needs a ceiling AND a floor."** Gating on the *requested* rung answers
   "may I grant this?" and leaves "may I act on this person?" unasked — which let an admin demote and
   evict an owner while every gate reported success. Any route that mutates another principal's
   standing needs both checks, and the DELETE variant needs it most because it has no "requested
   role" to accidentally constrain it.

A third, narrower note worth recording near the existing `??`/`||` guidance: **`.env.example` ships
keys with EMPTY values, so any documented env fallback must use `||`** — `??` makes the promise false
for the operator who pastes the block.
