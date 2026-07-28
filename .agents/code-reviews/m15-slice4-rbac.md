# Code review — M15 slice 15.4 (RBAC)

Reviewed against `CLAUDE.md`, `docs/guide/operations.md`, `.agents/plans/m15-slice4-rbac.md`, and
the 15.1–15.3 precedents in `packages/db/src/repositories/`.

**Stats:**

- Files Modified: 75
- Files Added: 11
- Files Deleted: 0
- New lines: 1254
- Deleted lines: 303

Gates at review time: `tsc -b` 0 errors · `lint` 0 errors · `format:check` clean ·
`repo-health --require-db` PASS (942 tests, 262 integration, 0 skipped) ·
`build:dashboard` PASS.

---

## Findings

```
severity: high
file: packages/shared/src/roles.ts
line: 36
issue: hasRole's "fails CLOSED" guard does not actually guard — RANK[proto-key] is not undefined
detail: `RANK` is an object LITERAL, so it inherits from Object.prototype. `RANK["toString"]`
        returns a function, `RANK["constructor"]` returns a function, and `RANK["__proto__"]`
        returns Object.prototype — none of them `undefined`. So `actual !== undefined` passes for
        all four, and the call returns false ONLY because `fn >= 0` coerces to `NaN >= 0`.
        That is exactly the accident the function's own comment says must not be relied on
        ("do not simplify it away, because `undefined >= 0` coerces to `NaN >= 0` → `false` by
        accident rather than by design"). The comment describes a guard the code does not have.
        Verified at runtime: `typeof RANK["toString"] === "function"`, `!== undefined` → true.
        `roles.test.ts`'s "does not treat prototype keys as roles" case passes for the wrong
        reason, so the test does not protect the invariant either.
        Not currently exploitable — every path still returns false — but this is an
        authorization primitive, and "correct by coincidence" is not a property to ship in one.
suggestion: Use an own-property check: `if (!Object.hasOwn(RANK, role)) return false;` before the
        rank comparison. Keep the prototype-key test and make its comment say what it now proves.
```

```
severity: medium
file: apps/ingest/src/routes/git.ts
line: 149
issue: gitCommitDetail was widened to org scope, but the git-link neighbourhood it feeds is still
       user-scoped — so linking a colleague's commit silently produces an UNATTRIBUTED link
detail: 15.4 dropped the `machines.user_id` predicate from `gitCommitDetail` along with the other
        visibility reads. Its ONLY caller is POST /v1/sessions/:sessionId/git-links, which then
        calls `resolveWorkspaceId(tx, orgId, userId, detail.commit.repoRootPath)` with the
        CALLER's userId — and `resolveWorkspaceId` deliberately kept its `user_id` predicate
        (its unique index is `(user_id, project_key)`).
        Consequence: a member linking a commit captured on a COLLEAGUE's machine now passes the
        404 existence check, then resolves no workspace, and `addManualLink` stores
        `project_id = NULL`. Before this slice the same request returned a clean 404. A 404
        turned into a silently degraded success — the failure shape CLAUDE.md warns about.
        The whole neighbourhood is per-user by INDEX design, not by oversight:
        `session_git_links` is unique on `(user_id, session_id, commit_id)`, and
        `listSessionLinks` / `computeSessionGitSuggestions` / the candidate-commit query in
        `attribution.ts:226` all filter `machines.user_id`. `gitCommitDetail` is the odd one out.
suggestion: Put `gitCommitDetail` in the same group as `listAlertFirings` / `createProject` /
        `resolveWorkspaceId` — keep `orgId` as the second parameter (the tenancy fix, which was
        the real defect) AND restore the `machines.userId` predicate, with a comment saying why
        it is NOT part of the org-widening. Org-wide manual git-linking is a feature decision for
        a later slice, and it needs `session_git_links`' index changed to match.
```

```
severity: low
file: apps/ingest/src/routes/monitor.ts
line: 218
issue: reconcileLastRunAt grows without bound — entries are added per (org,user) and never removed
detail: `shouldReconcile` writes `${orgId}:${userId}` into the map on every due tick and nothing
        ever deletes. Bounded by the number of distinct users who have ever loaded the monitor in
        this process, so it is negligible for a self-hosted install and resets on restart — but it
        is unbounded in principle, and M16 (hosted multi-tenancy) is the slice where it stops
        being negligible.
suggestion: Leave for now; note it in the M16 plan. If a cheap bound is wanted, drop entries older
        than a few multiples of `reconcileThrottleMs` on write.
```

```
severity: low
file: apps/ingest/src/routes/monitor.ts
line: 221
issue: the throttle window is consumed even when the snapshot then THROWS
detail: the timestamp is stamped BEFORE the await (deliberately — GOTCHA 2 in the plan, so two
        overlapping requests do not both see a stale `last`). The trade-off is that a snapshot
        that throws has still burned its window, so alert state can be up to `reconcileThrottleMs`
        stale after a transient DB error rather than being retried on the next tick.
suggestion: Accept. Moving the stamp after the await re-opens the double-reconcile race the plan
        explicitly called out, and the cost here is bounded staleness, not a wrong result. Worth
        one sentence in the code comment so the asymmetry is a decision on the page.
```

```
severity: low
file: apps/ingest/src/routes/org-scoping.test.ts
line: 45
issue: the ALLOWED_WITHOUT_ROLE_GATE entry for health.ts is unreachable
detail: the loop `continue`s on `!src.includes("resolvePrincipal")` BEFORE consulting the
        allow-list, and health.ts has no principal at all — so the entry can never be hit. It
        reads as though health.ts is an exempted gate when it is simply not a gated route.
suggestion: Harmless, and the empty-allow-list alternative loses the "where would an exemption go"
        signpost. Keep it, but say in the comment that it is documentation rather than an active
        exemption.
```

---

## Checked and clean

- **No new long-lived resources.** The SSE teardown wiring (close listener armed before the first
  `await push()`, the `closed` guard, `inFlight`, `clearInterval`) is byte-identical; the only
  addition inside `push()` is a synchronous map read/write. No new `setInterval`, stream, listener
  or proxied `fetch`.
- **The 15.3 tenancy layer is untouched.** `0016` adds only RESTRICTIVE policies plus one new org
  policy for `project_grants`; it modifies none of the 15 existing policies. Pinned by
  `rollback.int.test.ts` (rolling 0016 back leaves exactly 15 policies, RLS still enabled+forced)
  and by the re-keyed `rls.int.test.ts` inventory.
- **`SERVICE_ROLE` placement.** All three org-action paths (collector writes, per-org maintenance
  loops, monitor snapshot + alert delivery) pass the sentinel; `authorize.test.ts` proves it
  satisfies no rung at the route layer, `rbac.int.test.ts` test 10 proves it satisfies the DB.
- **No secrets on the wire.** No `NEXT_PUBLIC_*` introduced (the one grep hit is the comment
  forbidding it). `project-grants.ts` uses an explicit `projectGrantRowColumns` list mirroring
  `ProjectGrantRow`, so `org_id` cannot leak the way it did in 15.1.
- **No SQL injection.** `app.current_role` is a bound parameter via `set_config(...)`, identical
  to `app.current_org`; `org-context.test.ts` asserts the literal never appears in the SQL text.
- **`effectiveProjectRole` cannot demote**, including for an unrecognised org role (which fails
  closed through `hasRole` and degrades to itself). Covered by two integration tests.
- **Gate matrix** matches the plan for all 45 sites. One addition the plan's matrix omits:
  `POST /v1/projects/:id/git/suggest` is gated at `member` (it writes `session_git_links`).
```

## Verdict

Two issues worth fixing before commit: the `hasRole` own-property guard (high — it is the
authorization primitive and its stated invariant is not the one it implements) and the
`gitCommitDetail` scope mismatch (medium — a 404 became a silent null attribution). The three low
findings are notes, not blockers.

---

## Fixes applied

**HIGH — `hasRole` guard** (`packages/shared/src/roles.ts`). Replaced `actual !== undefined` with
`Object.hasOwn(RANK, role)`, and rewrote the comment to describe the guard the code now has rather
than the one it claimed. `roles.test.ts`'s prototype-key case was renamed and extended (it now also
asserts `isRole` rejects the same keys) with a comment stating that the assertion is meaningful
because the guard rejects them, not because `NaN >= 0` happens to be false.

**MEDIUM — `gitCommitDetail` scope** (`packages/db/src/repositories/git.ts`). Restored the
`machines.userId` predicate alongside both org predicates, moving this read into the same group as
`listAlertFirings` / `createProject` / `resolveWorkspaceId`: `orgId` second (the tenancy fix, which
was the actual defect) **and** `userId` kept, because the git-link neighbourhood is per-user by
index design. Signature is `(db, orgId, userId, commitSha)`; the route and `git.int.test.ts` were
updated, and the negative test now proves cross-org **and** cross-user isolation. The comment
records the regression this prevents so a future reader does not "simplify" it back.

**LOW ×3 — accepted as notes.** `reconcileLastRunAt` pruning deferred to M16; the throttle's
stamp-before-await stays (moving it re-opens the double-reconcile race the plan called out); the
`health.ts` allow-list entry stays as a signpost.

Post-fix gates: `tsc -b` 0 errors · `lint` 0 errors · `format:check` clean ·
`repo-health --require-db` PASS (262 integration tests, 0 skipped).
