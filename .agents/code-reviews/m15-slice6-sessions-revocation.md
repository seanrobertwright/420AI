# Code review — M15 slice 15.6 (Sessions + revocation)

Reviewed pre-commit, in two passes. Date `2026-07-28`.

**Pass 1** — single reviewer over the whole diff (5 findings).
**Pass 2** — three INDEPENDENT reviewers, one lens each (correctness/races, security/tenancy,
tests/standards), each required to PROVE findings by running something rather than reasoning alone.
Pass 2 found the two most serious defects in the slice, both of which pass 1 missed. That is the
argument for the second pass, and it is worth recording: pass 1 checked whether the code did what
the plan said; pass 2 asked what the code could not do that it CLAIMED to.

**Stats (final):**

- Files Modified: 19
- Files Added: 9
- Files Deleted: 0
- Findings: 14 (2 high, 5 medium, 7 low) — **13 fixed, 1 accepted with documentation**

## Verification performed

| Check                                                | Result                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Root `tsc -b`, `typecheck:dashboard`, `lint`, `format:check` | exit 0                                                              |
| `repo-health -- --require-db`                        | PASS — integration layer ran, 0 skipped                                     |
| `build:dashboard`                                    | PASS                                                                        |
| Rollback drill (0018 down → up)                      | PASS                                                                        |
| Mutation check — revocation lookup removed           | 11/20 failed; **all positive assertions passed**                            |
| Mutation check — `FOR SHARE` removed from the race test | the blocking assertion fails (test discriminates)                        |
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
status: FIXED — per-tick `sessionIdFromRequest` + `findLiveSession`; on miss, emit
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
