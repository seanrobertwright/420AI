# Code Review — M15 slice 15.3 (RLS Enforcement)

Branch: `m15-slice3-rls-enforcement` · Reviewed against `HEAD` (79e349b)

**Stats:**

- Files Modified: 49
- Files Added: 12 (2 of them docs/plan, not code)
- Files Deleted: 0
- New lines: 1140
- Deleted lines: 251

## Summary

The slice does what it says: the two-role suite is real, the policies are correct
(`USING`-only doubles as `WITH CHECK`, the `nullif(…,'')` guard makes an unset context
fail closed and quiet), the SSE teardown is untouched, and the `Promise.all` →
sequential conversion inside transactions is right for the reason stated.

One **critical** functional regression survived every gate, and it is the exact class
the slice was written to prevent — a tenant-table read left outside `withOrg`, invisible
to `tsc`, invisible to the owner-connected integration suites, and invisible to the new
source-level completeness test because that test is file-granular.

---

## Resolution

All five findings were fixed on the same branch before commit. Each fix was verified by
reintroducing the defect and confirming the new test fails:

| # | Severity | Fix | Verified by |
|---|----------|-----|-------------|
| 1 | critical | `deliverPendingFirings`/`deliverResolvedFirings` take `Db` + `orgId` and own short `withOrg` transactions internally, with `deliver()` between them | reverting the scoping fails `rls.int.test.ts` test 9 (`expected 0 to be greater than 0`) |
| 2 | medium | behavioural pin added (`rls.int.test.ts` test 9) + a named tripwire in `org-scoping.test.ts` + the file-granular limit documented in its header | new tests green; regex tripwire fails on the un-scoped call shape |
| 3 | medium | down-SQL header rewritten to match the body | n/a (comment) |
| 4 | medium | both `rollback.int.test.ts` comments corrected | n/a (comment) |
| 5 | low | `withOrg` throws on a blank `orgId` before opening a transaction | new `org-context.test.ts` case, `''` and `'   '` |

The lesson from #1/#2 is recorded in `CLAUDE.md` as a fourth corollary to the
`bypassed ≠ enforced` rule: a per-FILE grep exempts the file, not the call site, so pair it
with a behavioural test on the app role — and a best-effort/swallow path is the worst place
to lose a policy, because it is designed not to complain.

## Findings

```
severity: critical
file: apps/ingest/src/routes/monitor.ts
line: 118
issue: alert delivery reads `alert_firings` on `app.db` with NO org context — under the app role it sees zero rows, so M12 12.6 / M13 13.5 webhook + SMTP delivery is silently dead.
detail:
  `deliverFirings()` calls `deliverPendingFirings(app.db, …)` and
  `deliverResolvedFirings(app.db, …)` OUTSIDE any `withOrg`. Both SELECT from
  `alert_firings`, which migration 0015 gives a STRICT policy
  (`org_id = nullif(current_setting('app.current_org', true), '')::uuid`) plus
  ENABLE + FORCE. With no context set, `current_setting` returns `''` → `nullif` → NULL
  → the predicate is NULL → every row is filtered.

  Since 15.3 the ingest server boots on `DATABASE_URL_APP` (a non-superuser,
  `rolbypassrls=false`), so this is production behaviour, not a hypothetical.
  Measured against the live test DB:

      app role, NO  org context -> 0
      app role, WITH org context -> 1

  The follow-up `UPDATE … SET delivery_attempted_at` is scoped by the same policy, so
  nothing is stamped either — the code is a complete no-op, not a partial one.

  Why nothing caught it: `delivery.int.test.ts` and `alert-firings.int.test.ts` build on
  `dbh.db` (the OWNER handle), which bypasses RLS — the "bypassed ≠ enforced" trap this
  very slice added to CLAUDE.md. And `org-scoping.test.ts` skips any file containing
  `withOrg(` anywhere, so `monitor.ts` is waved through on the strength of the two
  `buildSnapshot` wraps a few lines above.

  The alert is still persisted and still appears in the snapshot, so the UI looks
  correct — only the outbound notification vanishes. That is the failure mode most
  likely to go unnoticed in production.
suggestion:
  Do NOT simply wrap the existing `deliverFirings` body in `withOrg` — the file's own
  comment is right that holding a transaction across a webhook/SMTP round-trip is how
  connection pools die. Instead push the scoping into the repository: change both
  functions to `(db: Db, orgId: string, userId: string, …)` and internally use
  `withOrg` for the SELECT and for each per-row stamp, leaving `deliverer.deliver()`
  between them with no transaction open. Add `eq(alertFirings.orgId, orgId)` to every
  statement as well (D-M15-3 keep-both-layers). Update the two call sites in
  `monitor.ts` to pass `principal.orgId`.
```

```
severity: medium
file: apps/ingest/src/routes/org-scoping.test.ts
line: 65
issue: the completeness test is FILE-granular (`if (src.includes("withOrg(")) continue`), so a file with one wrapped call and one unwrapped call passes.
detail:
  This test exists to be the grep half of CLAUDE.md's "tsc is a file-level checklist,
  not a call-site one" rule — and it reproduces the same defect it is pinning. A single
  `withOrg(` anywhere in the file exempts the whole file. `monitor.ts` is the live proof:
  it contains the critical finding above and this test is green.
suggestion:
  A source-level regex cannot reliably decide "is this identifier a Tx or a Db", so do
  not try to make the grep exact. Add the higher-signal pin instead: an explicit
  assertion that the known tenant-table repository calls in `monitor.ts` receive a
  transaction handle, plus a BEHAVIOURAL regression test at the app-role HTTP level
  (`apps/ingest/src/rls.int.test.ts`) that a seeded open firing is actually delivered
  through `GET /v1/monitor`. The behavioural test is what would have caught this.
```

```
severity: medium
file: packages/db/drizzle/down/0015_shiny_iron_man.down.sql
line: 3
issue: the header comment states the migration "drops the role LAST", which is the opposite of what the file does (and of the long justification at line 62 explaining why it must NOT).
detail:
  Lines 3–5 read "…and drops the role LAST (a role cannot be dropped while it still holds
  privileges — REVOKE must come first or `DROP ROLE` fails…)". Lines 62–70 then explain at
  length that the role is DELIBERATELY NOT dropped, because a role is cluster-wide while a
  migration is per-database. Both cannot be true. A reader who stops at the header will
  believe the rollback is complete when it leaves a privilege-less role behind — a real
  operational surprise on a shared cluster, in the one file where being wrong about
  privileges matters.
suggestion:
  Rewrite the header to match the body: drop policies, disable + un-force RLS,
  `DROP OWNED BY` to clear grants and the default-ACL entry, and leave the role in place.
```

```
severity: medium
file: packages/db/src/rollback.int.test.ts
line: 561
issue: two comments assert the down migration drops the app role; the assertions immediately below prove the opposite.
detail:
  The `afterAll` comment says "0015's down SQL DROPs the `420ai_app` role, and re-migrating
  recreates it NOLOGIN", and the in-test comment says "Every policy dropped, RLS disabled
  AND un-forced, and the role gone." The test then calls `appRoleHasPrivileges()` — a
  helper whose own doc-comment correctly explains the role is left privilege-less, not
  absent. Same contradiction as the finding above, in the file that is supposed to be the
  executable record of the rollback drill.
suggestion:
  Correct both comments. The `restoreAppRole()` call is still required and its real reason
  is worth stating: `DROP OWNED BY` revokes the grants, and the re-migrate restores them
  but never the password, so LOGIN must be re-provisioned.
```

```
severity: low
file: packages/db/src/org-context.ts
line: 36
issue: `withOrg` accepts any string as `orgId`; an empty or blank one silently turns the three BOOTSTRAP-PERMISSIVE policies fully permissive.
detail:
  The bootstrap policies on `machines` / `ingest_tokens` / `pairing_codes` are
  `nullif(current_setting(…), '') IS NULL OR org_id = …`. Passing `""` (or whitespace)
  sets the context to a value that `nullif` maps back to NULL, so those three tables
  become unrestricted for the whole transaction while the twelve strict tables fail
  closed — a confusing half-open state.

  Every current call site derives `orgId` from the database (a resolved principal,
  `getMachineOrgId`, `listOrganizations`), so this is not reachable today. It is cheap to
  make it unreachable permanently, in the one function whose entire job is isolation.
suggestion:
  Throw on a blank `orgId` at the top of `withOrg`. One line, no runtime cost, removes
  the class rather than the instance.
```

## Verified clean

- **SSE teardown** (`monitor.ts`): close listener still armed before the first
  `await push()`; `closed` guard and `clearInterval` unchanged. `git diff` on the file
  shows only added comment lines in the teardown region.
- **No transaction spans an external round-trip**: the report/interpretation orchestrators
  close their read transaction before the provider call; `exports.ts` closes before the
  Parquet encode. Both are commented with the reason.
- **No secret reaches a log or a view**: `provision-app-role.ts` scrubs the pg error that
  would otherwise carry the `ALTER ROLE … PASSWORD` text; the CLI prints only a
  confirmation; `to_view` exposes `has_database_url_app` and the Rust test asserts the
  password never appears in `Debug` output.
- **No SQL injection in the new DDL path**: `format('… %I … %L', $1, $2)` does the quoting
  server-side; the only interpolated value elsewhere is the `APP_ROLE_NAME` module
  constant.
- **`withOrg` binds the org id as a parameter**, never string-interpolates it — pinned by
  `org-context.test.ts`.
- **Every other `app.db` call outside `withOrg`** is on a table with no policy
  (`pricing_catalogs`, `connector_catalogs`, `users`, `organizations`, `memberships`) or a
  bootstrap-permissive one (`machines`, `pairing_codes`, `ingest_tokens`), or is a
  D-15.3-6 orchestrator that wraps internally. Enumerated exhaustively; `monitor.ts` was
  the only miss.
