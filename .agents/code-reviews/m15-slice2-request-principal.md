# Code Review — M15 Slice 15.2: Request Principal

**Reviewed:** 2026-07-26 · branch `m15-slice2-request-principal`
**Scope:** `git diff HEAD` + all untracked source files, each read in full.

**Stats:**

- Files Modified: 55
- Files Added: 3 source (+1 plan doc)
- Files Deleted: 0
- New lines: 856
- Deleted lines: 352

---

## Summary

The conversion itself is sound: all 45 gates use `resolvePrincipal`, all 20 env-admin
re-resolutions are gone, the guard-ladder shape and the `"admin authorization required"` 401
body are preserved verbatim, the SSE teardown is untouched, and the version-race retry
correctly wraps the whole transaction.

The findings below are all instances of ONE class the slice exists to eliminate — a read keyed
by a connector-supplied string with no `org_id` predicate — that survived because the plan
enumerated call sites rather than deriving them from the rule. **Finding 1 is a live
cross-tenant data leak on the bulk-export endpoint and must be fixed before merge.**

---

## Findings

```
severity: critical
file: packages/db/src/repositories/exports.ts
line: 96
issue: exportEvents' project-scoped branch joins events.project_path = workspace_keys.project_key with NO org predicate — the exact Spike 4 defect, on the bulk data-export endpoint.
detail: GET /v1/exports/events?projectId=… reaches this branch. Two orgs whose machines used the
  same path (C:\dev\app) share `project_key` rows, so the join returns BOTH tenants' event rows,
  and the route serialises them straight out as json/jsonl/csv/parquet. This is strictly worse
  than the `usageTotals` leak the slice already fixed: that one merged aggregate COUNTS, this one
  exfiltrates whole event rows (sessionId, projectPath, gitBranch, model, tokens, cost). Redaction
  does not help — `redactJson` strips PII patterns, not other tenants' records. The sibling
  `.where(and(eq(machines.userId, userId), ...))` branch on line 99 IS tenant-correct (same shape
  as connectorHealth), which is exactly why this went unnoticed: the function looks scoped.
  The route gate was converted, so `tsc` was satisfied and every test passed.
suggestion: Add `orgId` as the SECOND parameter (D-15.2-4) and apply BOTH predicates to the
  project branch — `eq(events.orgId, orgId)` for isolation and `eq(workspaceKeys.orgId, orgId)`
  for ownership, matching what usageTotals now does. Add `eq(events.orgId, orgId)` to the
  machines branch too as defence in depth. Pin it with a cross-tenant int test.
```

```
severity: medium
file: apps/ingest/src/routes/exports.ts
line: 170
issue: Dead conditional and a now-false comment left behind by the principal conversion.
detail: `userId` is `principal.userId`, which is always a non-empty string once the gate returns
  a principal. So `if (projectId !== undefined || userId)` is always true, `userId ?? ""` can
  never yield `""`, and the comment "With neither, the export is empty (no owner exists yet)
  rather than a 500" describes a state that is now unreachable. Harmless at runtime, but it is
  precisely the kind of stale guard that a later reader trusts — it implies `userId` is
  nullable, which would invite a wrong nullability assumption in future edits.
suggestion: Drop the conditional and the `?? ""`, call exportEvents unconditionally, and replace
  the comment with one that states the post-15.2 invariant (a principal always has a user).
```

```
severity: medium
file: packages/db/src/repositories/alert-firings.ts
line: 199
issue: ackAlertFiring scopes by (id, userId) but not org, inconsistent with the org+user pattern applied to setLinkStatus and listReportArtifacts in this same slice.
detail: Not a live cross-tenant leak today — `alert_firings.user_id` still gates it, and every
  user has exactly one org — but it is the one user-keyed WRITE in the diff that did not get the
  defence-in-depth org predicate its siblings got. `setLinkStatus` (attribution.ts) and
  `listReportArtifacts` (reports.ts) both now take `(db, orgId, userId, …)`. Leaving one member
  of the set inconsistent is how the next reader concludes the org predicate is optional. It also
  matters for 15.10, where org membership stops being 1:1 with a user.
suggestion: Take `orgId` as the second parameter and add `eq(alertFirings.orgId, orgId)` to the
  update's where, mirroring setLinkStatus. The route already has the principal.
```

```
severity: low
file: packages/db/src/repositories/reparse.ts
line: 228
issue: A session-keyed events query with no org predicate, in a deployment-wide maintenance path — correct, but undocumented, so it reads as a missed site.
detail: `reparseAll` is a deployment-wide operation like `rebuildSearchIndex` and the /v1/replay/*
  ops (D-15.2-7), and it is bounded by `inArray(events.rawRecordId, idChunk)` where the chunk
  derives from already-org-stamped raw records, so it does not cross tenants in practice. But it
  now looks identical to the defect pattern the slice just spent 40 files eliminating. The next
  person to grep `eq(events.sessionId` will land here and either "fix" it (breaking reparse's
  global semantics) or waste time re-deriving that it is fine.
suggestion: Add a short comment naming it as deliberately deployment-wide, exactly as was done
  for POST /v1/search/reindex in routes/search.ts.
```

---

## Resolution — all four findings fixed in this branch

| # | Severity | Fix |
| --- | --- | --- |
| 1 | critical | `exportEvents(db, orgId, userId, filters)` — `eq(events.orgId, orgId)` now seeds the shared `conditions` array (applies to BOTH branches) and `eq(workspaceKeys.orgId, orgId)` was added to the project branch. Route passes `principal.orgId`. |
| 2 | medium | `routes/exports.ts` — dead conditional and `userId ?? ""` removed; the call is now unconditional and the comment states the post-15.2 invariant. |
| 3 | medium | `ackAlertFiring(db, orgId, userId, id, now)` — `eq(alertFirings.orgId, orgId)` added, matching `setLinkStatus`. |
| 4 | low | `reparse.ts` — comment added naming it deliberately deployment-wide (D-15.2-7), mirroring `/v1/search/reindex`. |

**Finding 1 is pinned by two new regression tests** — one repository-level
(`packages/db/.../principal.int.test.ts`, "exportEvents does not export another org's event ROWS")
and one HTTP-level (`apps/ingest/src/principal.int.test.ts`, "GET /v1/exports/events never
serialises another org's event rows"). Both were **verified to FAIL with the fix reverted** and pass
with it restored — they genuinely catch the regression rather than merely asserting current
behaviour.

Post-fix gate: `tsc -b` 0 · `lint` 0 · `format:check` 0 · `repo-health --require-db` **PASS,
222 integration tests ran, 0 skipped** · `build:dashboard` 0.

---

## Verified NOT issues (checked, no action)

- `connectorHealth` / `connectorHealthWindowed` — join `machines` and filter `machines.user_id`;
  tenant-correct, and the plan explicitly exempts them.
- `gitCommitDetail` — same `machines.userId` join shape; correct despite being keyed by a git SHA.
- `indexSessions` / `indexOneSession` — org-correct since 15.1 (`eq(events.orgId, s.orgId)` and
  `eq(rawSourceRecords.orgId, s.orgId)`); grouping includes `org_id`.
- `sessionTranscript`, `sessionModifiedPaths`, `sessionEndTs`, `sessionProjectPath`, `sessionDetail`
  — all carry `eq(events.orgId, orgId)` (grep false positives; the predicate is on the next line).
- `createPairingCode` keeping `getOrgIdForUser` — correct and deliberate: the code is minted for a
  target user who may not be the caller, so the caller's org would be the wrong org.
- `upsertWorkspace` / `addWorkspaceKey` / `findOrCreateProjectByRemote` keeping `getOrgIdForUser`
  — reached only from the machine-authed discover route, where no principal exists.
- SSE stream (`routes/monitor.ts`) — `close` listener still armed before the first `await push()`,
  `closed` guard intact, `clearInterval` intact, interval still only armed if still connected. The
  new `await resolvePrincipal` sits where an `await findUserIdByEmail` already sat, so no new
  pre-`writeHead` leak window.
- No secrets, no string-interpolated SQL (the one `sql.raw` is a guarded closed-set literal), no
  N+1 introduced (the principal resolve is a net −1 query on the 20 routes that previously did
  gate-then-`findUserIdByEmail`).
