# Code review — M15 slice 15.6 (Sessions + revocation)

Reviewed in THREE passes — two pre-commit, one on the open PR. Date `2026-07-28`.

**Pass 1** — single reviewer over the whole diff (5 findings).
**Pass 2** — three INDEPENDENT reviewers, pre-commit, one lens each (correctness/races,
security/tenancy, tests/standards). Found the two most serious defects in the slice, both missed by
pass 1.
**Pass 3** — four more reviewers on the OPEN PR (comment accuracy, simplification, types/errors,
docs). Found 22 further issues, including one that invalidated a mutation check pass 2 had reported
as "verified".

The escalation is itself the finding. Pass 1 asked whether the code did what the plan said. Pass 2
asked what the code could not do that it CLAIMED to — and found two real holes. Pass 3 asked whether
the PROSE was true, and found that several of pass 2's own fixes had shipped with justifications
that did not survive checking. Each pass found a class the previous one could not see, and the
cheapest class to get wrong is the one written in English.

**Stats (final):**

- Files Modified: 19
- Files Added: 9
- Files Deleted: 0
- Findings: 36 across three passes — **35 fixed, 1 accepted with documentation**
  (pass 1: 5 · pass 2: 9 · pass 3: 22)

## Verification performed

| Check                                                | Result                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Root `tsc -b`, `typecheck:dashboard`, `lint`, `format:check` | exit 0                                                              |
| `repo-health -- --require-db`                        | PASS — integration layer ran, 0 skipped                                     |
| `build:dashboard`                                    | PASS                                                                        |
| Rollback drill (0018 down → up)                      | PASS                                                                        |
| Mutation check — revocation lookup removed           | 12/23 failed; **all positive assertions passed**                            |
| Mutation check — `{ lock: true }` removed from PRODUCTION `findAdminCredential` | the blocking assertion fails (pass 3 correction — see P3-1) |
| Mutation check — SSE re-check removed                | the stream test fails (`data:` frames continue after revoke)                |
| Mutation check — logout statements swapped           | both ordering tests fail                                                    |
| CASCADE claim (SPIKE 6)                              | verified empirically with a throwaway probe: `sessions` 1 → 0               |
| Live-server exploit reproduction (SSE)               | confirmed: 6 further frames delivered post-revoke, and post-member-removal  |

---

## HIGH

### 1. Revocation did not reach an open SSE stream — FIXED

```
severity: high
file: apps/ingest/src/routes/monitor.ts
line: 265
issue: `GET /v1/monitor/stream` gated the principal once at connect and never revalidated
detail: PROVEN against a live server. After `revoke-all` returned {revoked:1} and `/v1/auth/me`
        returned 401 on the same token, the open stream delivered 6 more `data:` frames and kept
        going — unbounded, trivially held by curl. Same after `DELETE /v1/members/:userId` returned
        204: the removed member's stream kept serving the org's live monitor payload (active
        sessions, alerts, cost), kept performing the org's reconcile WRITES each tick, and kept
        firing outbound alert delivery on behalf of a non-member. "Remove an employee, sign them
        out" is the canonical use case for this slice, and the one long-lived thing they have open
        was exactly what it missed.
        Worse than the gap: the slice CLAIMED there was none. `auth.ts` said "THIS IS THE ONE
        ENFORCEMENT POINT… no second place to check", and a test was titled "revocation reaches
        EVERY authenticated route". That test is built on `app.inject`, which cannot observe a
        hijacked socket — it was structurally incapable of catching this.
suggestion: Re-check the session inside the tick. The previous comment justified NOT doing so ("a
        DB round trip per SSE frame"), which measured the wrong thing: a full `resolvePrincipal` is
        two queries, this is ONE primary-key probe, added to a tick that already opens a transaction
        spanning eight reads plus a reconcile write.
status: FIXED — per-tick `findLiveSession` on the stashed `request.sessionId`; on miss, emit
        `event: error {"error":"session revoked"}`, clear the interval, end the socket. The false
        claims in `auth.ts` and in the sweep test's title are corrected to say what is actually
        true, including what `inject` cannot see. New regression test on a REAL `listen()`;
        verified to fail without the fix.
```

### 2. A login racing a password reset survived it — FIXED

```
severity: high
file: apps/ingest/src/routes/auth.ts
line: 143
issue: a session minted from the OLD password outlived a concurrent password reset
detail: REPRODUCED at the HTTP layer with a small stagger. Login reads the hash, spends ~100 ms in
        scrypt, then INSERTS its session row. The reset updates the hash and runs
        `revokeAllSessions` — a blind UPDATE, which cannot see a row not yet inserted. Interleaved
        so the insert lands after the revoke, the old-password session stayed valid for its full 7
        days. That is precisely the account-takeover-recovery story D-15.6-6 cites as the reason a
        reset spares no session.
        The repository comment claiming "no lock needed" was true only for revoke-vs-revoke and was
        silent about revoke-vs-INSERT — CLAUDE.md's "name the mechanism" rule, violated by omission.
suggestion: Hold a `FOR SHARE` lock on the user row across the login's credential read and session
        insert. It conflicts with the `UPDATE users` both credential-change paths run, so either
        ordering is safe: login-first makes the reset wait and then revoke the new row; reset-first
        makes the login re-evaluate under EvalPlanQual, see the new hash, and refuse.
status: FIXED — `findAdminCredential(tx, email, { lock: true })` inside a login transaction; both
        orderings named in its doc comment. `revokeAllSessions`'s comment now states which race it
        excludes and which it does not.
```

---

## MEDIUM

### 3. The regression test for finding 2 was written at the wrong LAYER — FIXED

```
severity: medium
file: apps/ingest/src/sessions.int.test.ts
line: (deleted)
issue: the first race test passed identically with and without the fix
detail: MEASURED, not assumed — the exact CLAUDE.md 15.5 failure ("a concurrency test at the wrong
        LAYER cannot fail"). `hashPassword`/`verifyPassword` are blocking scryptSync, so two
        concurrent handlers serialise on the event loop and the interleaving cannot be driven from
        outside. A green test advertising an unverified guarantee is worse than no test.
suggestion: Move it to the repository layer with two hand-held transactions; the discriminating
        assertion is that the credential-change UPDATE is STILL UNSETTLED after a wait.
status: FIXED — HTTP version deleted (with the reason recorded where it lived), replaced by a
        repository-level test that fails when `FOR SHARE` is removed. Releases both connections in
        `finally`, per the 15.5 corollary about held transactions wearing five fake failures.
```

### 4. Password change wrote the hash and revoked in two autocommit statements — FIXED

```
severity: medium
file: apps/ingest/src/routes/auth.ts
line: 406
issue: `POST /v1/auth/password` was not atomic, unlike its sibling reset-confirm path
detail: The reset route puts both in one transaction and its own comment calls this half-state "the
        more dangerous half — the victim believes they have locked the attacker out". If the revoke
        failed here, the caller got a 500 with the password already rotated and every other device
        still signed in; a naive retry then 401s, because the current password is no longer current.
suggestion: Wrap both in `app.db.transaction`, matching the sibling.
status: FIXED.
```

### 5. A test title claimed an assertion the test did not make — FIXED

```
severity: medium
file: apps/ingest/src/sessions.int.test.ts
line: 538
issue: titled "revoke-all twice returns {revoked: 0}" while asserting 2 then 1
detail: `{revoked: 0}` is UNREACHABLE over HTTP — calling the route needs a live credential, so the
        caller's own session is always live and the floor is 1. A reader trusts the title and
        believes HTTP-level idempotency-to-zero is pinned when it cannot be.
suggestion: Retitle to what it proves and point at the repository test that does cover zero.
status: FIXED.
```

### 6. The suite's own mutation-check instructions were wrong — FIXED

```
severity: medium
file: apps/ingest/src/sessions.int.test.ts
line: 55
issue: header predicted tests 1, 2 and 4 would pass under the mutation; test 4 fails
detail: This is the file's instruction for the next person re-running the check. Following it they
        would see the isolation test fail and conclude the suite was broken — or "fix" a working
        test. The isolation test fails correctly, because it also asserts A's own session died; a
        B-only assertion would pass trivially.
suggestion: Record the MEASURED split and name the load-bearing gate (the positive assertion).
status: FIXED.
```

### 7. Rotating `ADMIN_PASSWORD` is a credential change that does not revoke — DOCUMENTED

```
severity: medium
file: apps/ingest/src/server.ts
line: 188
issue: the boot-time admin seed has no `revokeAllSessions`, and the ops doc omitted this trigger
detail: An operator rotating ADMIN_PASSWORD *because it leaked* leaves a stolen bootstrap-admin
        session valid for the rest of its 7 days — and the new ops section tells them SESSION_SECRET
        rotation "is no longer the revocation mechanism", so they will not reach for the one thing
        that would work.
suggestion: It CANNOT revoke here: scrypt re-salts every call, so the seed cannot distinguish a
        rotation from an ordinary restart, and an unconditional revoke would sign the admin out on
        every boot (including a crash-loop). Document the gap and the manual step instead.
status: DOCUMENTED — named at the seed site with the reason it cannot be fixed there, plus an
        operations.md subsection with the explicit revoke-all recipe.
```

---

## LOW (all fixed unless noted)

```
severity: low   file: apps/ingest/src/routes/monitor.ts (via dashboard logout)  — FIXED
issue: the logout handler's load-bearing ORDERING had zero test coverage
detail: `adminHeaders()` reads the cookie, so the ingest hop must precede `cookies().delete`.
        Swapping the two lines silently reverts logout to cookie-only — the exact bug 15.6 exists to
        fix — with no test failing.
status: FIXED — new `route.test.ts` asserting call ORDER; verified to fail when swapped.
        Writing it exposed a second bug (below).

severity: low   file: apps/dashboard/src/app/api/auth/logout/route.ts  — FIXED
issue: the handler promised the cookie is cleared "even if the ingest hop fails", but had no `try`
detail: `proxyJson` catches a failed FETCH and returns a 502 response — only that. Anything raised
        before or around it (`adminHeaders()` awaits `cookies()`) propagated and skipped the delete,
        stranding the user signed-in in exactly the case the comment said it would not. "The helper
        happens to catch the failure I thought of" is not the guarantee that was written.
status: FIXED — explicit try/catch; asserted by the second test in the new file.

severity: low   file: packages/db/src/repositories/sessions.ts:74  — FIXED
issue: the clock-skew comment was inverted
detail: It claimed comparing `expires_at` against Postgres `now()` avoided app↔DB skew. It was the
        one place INTRODUCING it: `expires_at` is written from `Date.now()` and the token's `exp` is
        checked against `Date.now()`. A DB running ahead expires the row before the token — the
        unexplainable 401 the single-TTL design exists to prevent.
status: FIXED — app clock on both sides, in `findLiveSession` and `listSessions`; comment corrected
        and says what was wrong.

severity: low   file: apps/ingest/src/routes/members.ts:326  — FIXED
issue: the comment presented a global revoke as the multi-org-correct answer; it inverts at 15.10
detail: Correct today (single-org users). Under 15.10 an admin of org A would sign a user out of
        org B — a cross-tenant action by someone with no standing in B.
status: FIXED — rewritten as "correct today, REVISIT AT 15.10" with both halves stated.

severity: low   file: apps/ingest/src/routes/org-scoping.test.ts:48  — FIXED
issue: the `auth.ts` withOrg-exemption reason stopped covering what the file does
detail: The "no stale entries" test only catches an allow-listed file that no longer EXISTS, never
        one whose reason quietly stopped being true.
status: FIXED — extended to name `sessions` and the `userId`-not-`orgId` scoping.

severity: low   file: apps/ingest/src/routes/auth.ts:88  — FIXED
issue: the file-level charter comment was orphaned onto the new `mintSession` helper
status: FIXED — explicit FILE CHARTER banner + a `module-private helpers` separator.

severity: low   file: apps/ingest/src/sessions.int.test.ts  — FIXED
issue: no unauthenticated-401 coverage for the four new routes; the `viewer` gate never exercised
detail: `routes/auth.ts` justifies gating at `viewer` with "a read-only account must still be able
        to sign out a stolen laptop" — a promise no test made. A typo to `"admin"` would break it
        with everything still green (`rbac.int.test.ts` does not enumerate these routes).
status: FIXED — a no-bearer sweep over all four, and a viewer test that first PROVES the fixture is
        really a viewer (403 on an admin route) before asserting 200/204 on the session routes.

severity: low   file: packages/db/src/repositories/sessions.ts  — ACCEPTED, documented
issue: session rows are never purged; the table grows by one row per login
detail: Verified harmless rather than assumed — `findLiveSession` is a primary-key probe, so growth
        is free on the hot path, and `listSessions` filters to live rows.
suggestion: Not fixed here: retention interacts with 15.10's audit table, and deleting revocation
        history now would pre-empt that decision.
status: ACCEPTED — documented in operations.md with a safe manual `DELETE`.
```

---

## Checked and found clean

Reported by the reviewers after actually looking, so these are evidence rather than silence:

- **Authorization floor and ceiling (the 15.5 lesson).** Both `PATCH` and `DELETE /v1/members/:userId`
  carry the `outranks` guard. The four new session routes act **only** on `principal.userId`; none
  accepts a target user id; every repository function takes `userId` as a mandatory second parameter.
  No caller can list or revoke another user's session.
- **Bypass sweep.** All 72 route registrations under `apps/ingest/src/routes` enumerated: each is
  gated by `resolvePrincipal` + `authorized`, or by `app.authenticate` (machine credential, separate
  revocation). The only chokepoint escape was the hijacked SSE stream — finding 1.
- **`sub`↔`sid` binding** enforced; `sid` is `gen_random_uuid`, MAC-bound, correctly treated as a
  lookup key rather than a secret (D-15.6-2).
- **Downgrade.** No path accepts a `sid`-less token at ingest; no grandfathering exists.
- **Enumeration.** Unknown / already-revoked / not-yours all collapse to one 404; `isUuid` guards
  both the path param and `payload.sid`, so no uuid-cast 500.
- **`newUserId!`** is sound at both call sites — drizzle's `transaction()` rethrows any callback
  rejection, so the `!` is only reachable after a committed callback.
- **Ordering.** No session row is minted for a transaction that later rolls back; no token is ever
  signed naming a `sid` that does not exist.
- **Tenancy.** `sessions` genuinely carries no policy and 0018 never enables RLS, so `withOrg`
  neither filters nor errors around it; both two-role suites pass on the non-owner handle, which is
  what proves 0015's default privileges really do cover the new table.
- **Secrets.** Explicit column list matching `SessionRow`; only `id/createdAt/expiresAt/userAgent`
  reach the wire; no token echoed; `ADMIN_TOKEN` never leaves the server. The session cookie is
  `SameSite=Lax` and ingest authenticates by bearer only, so the new routes are not CSRF-reachable.
- **Conventions.** ESM with `.js` specifiers, `import type`, kebab-case, no stdout/stderr in library
  code, `userId` consistently second, `NO_RLS_TABLES` and the rollback counts updated with the policy
  count deliberately pinned at 59 across the rollback.

## Note on suite flakiness (pre-existing, not this slice)

Both reviewers independently observed a full `npx vitest run` failing with cross-file `TRUNCATE` FK
races and Postgres `40P01` deadlocks, despite `fileParallelism: false`. It reproduces **with this
slice's files excluded**, so the root cause is pre-existing infra, and it matches the known
Docker-Postgres checkpoint-stall pattern: running `CHECKPOINT` first makes it go away. `repo-health
-- --require-db` passes. Worth a separate look; not a defect of 15.6, but the slice does add two more
suites that TRUNCATE the same shared tables.

## Verdict

**Passed after fixes.** 14 findings; 13 fixed, 1 accepted with documentation. Every fix that changes
behaviour carries a regression test that was verified to FAIL without it.

---

# Pass 3 — four aspect reviewers on the open PR (#66)

Dispatched after CI went green: comment accuracy, simplification, types/errors, docs. 22 findings.
**The headline is that one of them invalidated a mutation check pass 2 had reported as verified.**

## HIGH

### P3-1. The login-race regression test did not pin the production code — FIXED

```
severity: high
file: packages/db/src/repositories/sessions.int.test.ts
issue: the test hand-rolled `SELECT … FOR SHARE` instead of calling the repository function
detail: Pass 2 fixed a real race (a login racing a password reset kept a session minted from the
        OLD password) with a `FOR SHARE` lock in `findAdminCredential`, and reported the test as
        mutation-verified. It was not. The mutation removed `FOR SHARE` from the TEST'S OWN SQL,
        not from the production code — so what was proven is that Postgres implements row locks,
        which was never in doubt. Deleting `{ lock: true }` from `findAdminCredential` left the
        test GREEN. "The mechanism works" is not "the code uses the mechanism", and the gap between
        those two is exactly where the bug lived.
        This is the same failure the test's own comment quotes CLAUDE.md about, one level up: pass 2
        moved the test to the right LAYER and still left the fix unpinned.
suggestion: Drive the real `findAdminCredential(tx, email, { lock: true })` on a held drizzle
        transaction, so removing the option fails the test.
status: FIXED — re-verified by mutating the PRODUCTION code this time: removing `.for("share")`
        fails the blocking assertion; restoring it passes. Rewriting it also exposed a deadlock in
        the test itself (racy start ordering, plus a `finally` that awaited the login transaction
        BEFORE rolling back the transaction blocking it) — it hung 5 s and leaked its connections
        into the next four tests, the exact "one real failure wearing five fake ones" shape. Fixed
        with a lock-acquired latch and a corrected teardown order; a failing run is now clean.
```

### P3-2. Every curl example in the new runbook used the wrong port — FIXED

```
severity: high
file: docs/guide/operations.md
issue: six commands used `localhost:3001`; ingest listens on 8420
detail: `3001` appears nowhere in the codebase as an ingest port — `.env.example` sets 8420, and the
        rest of the same document uses 8420. Every command an operator copies out of the revocation
        runbook connection-refuses, including the emergency "the password leaked" recipe. Copied
        from the plan's Level 4 section without checking, and not caught earlier because the manual
        validation actually run used 8420.
status: FIXED — all six corrected.
```

### P3-3. `.env.example` still advertised both things this slice made false — FIXED

```
severity: high
file: .env.example
issue: "issues a stateless HMAC session token" and "Rotating it invalidates all live sessions
       ('revoke all')"
detail: The highest-value docs finding: a file that quietly became wrong. `.env.example` is what an
        operator actually edits, and it told them sessions are stateless and that rotating
        SESSION_SECRET is how you revoke — while the new operations section says in bold that it is
        no longer the mechanism. An operator following it nukes every user's session instead of
        calling the endpoint.
status: FIXED — both corrected, plus a pointer to the per-session endpoints and a note that
        rotating ADMIN_PASSWORD does not revoke.
```

### P3-4. The logout `try` was justified by a mechanism that cannot occur — FIXED

```
severity: high (as a claim; the code is correct)
file: apps/dashboard/src/app/api/auth/logout/route.ts
issue: the comment named `adminHeaders()`'s `await cookies()` as the throw that would escape
detail: `proxyJson` evaluates `adminHeaders()` INSIDE its own try and collapses every failure into a
        502 response. The named example is the one case that provably cannot escape — the claim was
        imported from the sibling `proxyStream`, which does call it outside the try. Found by two
        reviewers independently. The `try` is still worth keeping; the reason given for it was
        checkable and false, which is the failure mode that makes a reader delete it.
status: FIXED — reworded to say what is true: nothing can throw today, and the `try` is defence
        against `proxyJson`'s contract changing. The test comment repeating the premise was
        corrected too.
```

## MEDIUM

```
severity: medium   file: apps/ingest/src/sessions.int.test.ts + SUMMARY.md + execution report — FIXED
issue: the mutation-check numbers were stale (11/9 over 20 tests; the file now has 23)
detail: The comment exists so the next person has a correct expectation to compare against, which is
        exactly what a stale number defeats. SUMMARY contradicted itself within one paragraph
        ("11 of 20" vs "23 HTTP + 15 repository" three sentences later).
status: FIXED — RE-MEASURED rather than adjusted: 12 failures / 11 passes over 23. Recorded in all
        three places, with the three passes that would otherwise look like holes explained (the SSE
        test passes because it exercises monitor.ts's re-check, which has its own mutation proof).

severity: medium   file: apps/ingest/src/auth.ts + 4 call sites — FIXED
issue: the bearer was parsed and HMAC-verified TWICE per request on four paths
detail: `sessionIdFromRequest` re-derived a `sid` that `resolvePrincipal` already had in hand, and
        its own doc comment worried about being "a second place the Bearer parsing could drift".
status: FIXED — `resolvePrincipal` now stashes `request.sessionId`; the helper is deleted. Removes
        four redundant HMAC computations and the drift risk (a stashed value cannot drift), and
        extends the `isUuid` validation to every consumer instead of only the resolver.

severity: medium   file: docs/guide/operations.md — FIXED
issue: the rollback paragraph contradicted itself and overstated the cost
detail: It said rolling back 0018 "discards every live session — same one-time cost", then said
        tokens are byte-compatible with the old verifier. Both cannot be true: with the code rolled
        back nobody is signed out, and the real consequence is that revocation history is destroyed
        and previously-revoked tokens become live again. With the code NOT rolled back, every
        request 500s against the dropped table.
status: FIXED — both outcomes stated.

severity: medium   file: docs/guide/operations.md — FIXED
issue: the SSE teardown — the headline pass-2 fix — was undocumented
detail: The one operator-visible behaviour change outside the four endpoints. Someone watching a
        Live Monitor tab close itself had nothing to look up.
status: FIXED — documented with the error frame's shape and the ADMIN_TOKEN exemption.

severity: medium   file: docs/guide/operations.md — FIXED
issue: `SESSION_TTL_SECONDS` offered as an operator lever, but it is a hard-coded constant
status: FIXED — says where it actually lives and that it is deliberately not an env var yet.

severity: medium   file: packages/db/src/schema.ts — FIXED
issue: the `last_used_at` rationale described the SSE stream as "one request per client per tick"
detail: It is ONE long-held request with a timer inside. The decision to omit the column is right;
        the repetition it named was wrong.
status: FIXED — restated in terms of the per-tick re-check.
```

## LOW (all fixed)

```
- packages/db/src/repositories/sessions.int.test.ts — a test comment asserted expiry is compared "in
  the DATABASE (now())", the exact opposite of the implementation, and one file over from the
  comment explaining why an earlier draft had it backwards. The repo asserted both directions at
  once. Found by two reviewers independently. FIXED.
- packages/db/src/repositories/sessions.int.test.ts — cited D-15.6-3 (an RLS decision) for the
  no-lock reasoning. No D-15.6-N covers it. FIXED — points at the function's own header.
- apps/ingest/src/auth.ts — "Pinned by `sessions.int.test.ts`" is ambiguous; two files share that
  basename and only one covers the case. FIXED.
- apps/ingest/src/routes/auth.ts — `let newUserId: string` + `newUserId!` in two handlers. Sound
  today, but an added early `return` would put `undefined` into `createSession` AFTER the user row
  committed, with `tsc` silent — the `!` is exactly the suppression that hides it. FIXED — the
  transaction returns the id, so that becomes a type error.
- apps/ingest/src/routes/auth.ts — the file charter had been orphaned onto `mintSession` by this
  slice, with a five-line marker comment whose only job was to explain the misplacement. FIXED —
  helpers moved above the charter; the marker deleted itself. The charter's own "issues a stateless
  HMAC session token" was stale after 15.6 and is now corrected.
- apps/ingest/src/routes/auth.ts — `mintSession` ended in three adjacent `string` parameters, the
  transposition hazard the repo's "orgId is always second" rule exists to prevent. FIXED — options
  object for `{ userId, email }`.
- apps/ingest/src/routes/auth.ts — the "same TTL, one place" comment implied the row and the token
  agree on the exact instant; they read the clock a round trip apart. FIXED — says they agree on the
  TTL, sub-second on a 7-day lifetime.
- packages/db/src/repositories/sessions.ts — `return row!` is a no-op assertion (drizzle already
  types it non-optional) that reads as a suppressed check. FIXED.
- apps/ingest/src/sessions.int.test.ts — three hand-rolled token signers. FIXED — one `signClaims`.
- docs/guide/operations.md — a truncated sentence mid-code-block; a `--data-binary @login.json`
  referencing a file never shown; the `GET /v1/auth/sessions` response shape described but not
  shown. FIXED.
- SUMMARY.md — D-15.6-8 and D-15.6-9 were cited in shipped source but defined only in the plan.
  (Pre-existing repo practice — 15.5 does the same — but cheap to close.) FIXED: all nine defined.
```

## Judged correct, no change

- The four-route `resolvePrincipal` + `authorized` ladder is duplicated **deliberately**: 29
  pre-existing call sites share the shape, and `routes/org-scoping.test.ts` greps for it. Extracting
  it would blind the structural check.
- `sessionRowColumns`/`SessionRow` used once each — mandated by CLAUDE.md 15.1.
- All five `sessions.ts` exports have real call sites; nothing dead; no unused parameters.
- `findAdminCredential`'s `{ lock: true }` cannot be _enforced_ to run inside a transaction —
  `DbClient` cannot distinguish `Db` from `Tx`, and `FOR SHARE` outside a transaction is legal but
  useless. Recorded so nobody mistakes the typing for enforcement; the mitigation is the doc comment
  plus the now-correctly-pinned repository test.
- Post-`hijack()` throw safety: `findLiveSession` sits inside the existing `try`, so a probe failure
  emits `snapshot failed` and keeps the stream alive — and `buildSnapshot` never runs on that tick,
  so a probe failure cannot leak a frame to a revoked session. It fails closed on data.
- Silent-library rule: zero `console.*`/`process.exit` added anywhere under `packages/*/src`.
- `SessionRow` matches the runtime shape exactly, including nullability; nothing undeclared reaches
  `reply.send()`.

## Verdict after pass 3

**Passed.** 36 findings across three passes; 35 fixed, 1 accepted with documentation (session rows
are never purged). Every behaviour-changing fix carries a regression test verified to fail without
it — and the one case where that verification was itself wrong is now corrected and re-verified
against the production code.
