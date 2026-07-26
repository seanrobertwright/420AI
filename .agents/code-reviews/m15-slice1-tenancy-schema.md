# Code Review — M15 Slice 15.1: Tenancy Schema (`organizations` + `memberships` + `org_id`)

Reviewed: 2026-07-26 · Branch `m15-slice1-tenancy-schema` · Base `e659c5e`

**Stats:**

- Files Modified: 46
- Files Added: 8
- Files Deleted: 0
- New lines: 588 (tracked) + 4,616 (new files, of which 3,151 is the generated
  `0014_snapshot.json` and 945 the plan)
- Deleted lines: 143

Gates at review time: `typecheck` 0 · `lint` 0 · `format:check` 0 ·
`repo-health --require-db` PASS (840 tests, 199 integration, **0 skipped**).

---

## Summary

The migration itself is the strongest part of this change: the four-step
add-nullable → backfill → `SET NOT NULL` → FK/index sequence is correct, was executed
against a clone of the real 413,765-event archive, and its `down/` twin round-trips
cleanly. The `NOT NULL` column did its job as a compile-time and run-time checklist —
all 17 insert sites are covered, and no write path was missed.

Three issues are worth acting on. One is a genuine **cross-tenant content leak** in the
search-index builder that I reproduced against the test database; it also means the
slice's headline audit-B.1 fix is only half-delivered. The other two are an unintended
API shape change and a smaller efficiency regression.

---

## Findings

```
severity: high
file: packages/db/src/repositories/search.ts
line: 335
issue: indexSessions groups by session_id alone, so two orgs sharing a connector session id collapse into ONE search document containing BOTH orgs' decrypted content
detail:
  `indexSessions` selects `min(machines.org_id::text)` and does
  `.groupBy(rawSourceRecords.sessionId)` — one row per session id GLOBALLY, not per
  (org, session). `indexOneSession` (:258) and `indexSessionEvents` (:207) then read
  that session's raw records and events filtered ONLY by `sessionId`, with no org
  predicate, and concatenate everything they find into one body.

  `entity_id` for a session doc is a connector-supplied session id — a globally-scoped
  string, which is precisely the collision the slice's own problem statement calls out
  as audit B.1. Two tenants CAN hold the same one.

  Reproduced against DATABASE_URL_TEST (two orgs, two machines, both ingesting a
  session id "COLLIDING-SESSION" with distinct payloads):

      PROBE indexSessions() returned: {"sessions":1,"events":2}
      PROBE session docs: 1  orgs: [ 'A' ]
      PROBE doc org=A containsA=true containsB=true

  One document, owned by org A, whose indexed body contains org B's decrypted payload —
  and both orgs' per-event docs written under org A. Anything org A searches will match
  org B's content and return a `ts_headline` snippet of it.

  Two consequences:
    1. It is a cross-tenant content leak the moment a second org exists. Inert today
       (one org), but this slice exists specifically to make org a real boundary, and
       15.3's RLS policies will not catch it — the row is genuinely stamped org A.
    2. The acceptance criterion "two orgs can hold the same (entity_type, entity_id)
       search doc" is only true of the INDEX. The builder can never produce the second
       row, so `tenancy.int.test.ts`'s B.1 test — which inserts both rows by hand —
       passes while the real code path stays broken. The test proves the schema, not
       the behavior.
suggestion:
  Group by the org as well as the session, and scope the content reads by it:
    - select `machines.orgId` as a real GROUP BY column (drop the `min(...)` aggregate)
      and `.groupBy(machines.orgId, rawSourceRecords.sessionId)`
    - thread `s.orgId` into `indexOneSession`/`indexSessionEvents` and add
      `eq(rawSourceRecords.orgId, s.orgId)` / `eq(events.orgId, s.orgId)` to their
      queries, plus the attribution join
  These are index-BUILDER predicates (a write path), not user-facing read filters, so
  this does not violate "no read path gains an org filter" — 15.2 still owns scoping
  the `searchDocuments()` query itself. With one org the change is a no-op, so it is
  safe to land here. Add a regression test that drives the real builder rather than
  hand-inserting rows.
```

```
severity: medium
file: packages/db/src/repositories/projects.ts
line: 88
issue: org_id now serializes into six API responses, contradicting the slice's "no route/API shape changed" acceptance criterion
detail:
  `listProjects`, `listWorkspaces`, `listReportArtifacts`, `getReportArtifact`,
  `renameProject`, `upsertWorkspace` and `remapWorkspace` all use `db.select()` /
  `.returning()` with no column list, so adding `org_id` to the table added it to the
  returned object. None of the ingest routes declare a Fastify `response` schema, so
  nothing strips it — the rows are passed straight to `reply.send()`.

  Verified against DATABASE_URL_TEST:

      PROJECT keys  : ["id","orgId","userId","name","gitRemote","createdAt","archivedAt"]
      WORKSPACE keys: ["id","orgId","userId","projectId","machineId",...]
      REPORT keys   : ["id","orgId","userId","projectId","reportType",...]
      JSON.stringify(project) = {"id":"8e4b...","orgId":"9ee4...","userId":"63b5...",...}

  Affected: GET /v1/projects, PATCH /v1/projects/:id, GET /v1/workspaces,
  PATCH /v1/workspaces/:id, GET /v1/reports, GET /v1/reports/:id.

  This is not a security hole — the endpoints are admin-gated and the value is the
  caller's own org id — and an additive JSON field breaks no client. But it is an
  unintended contract change in a slice that claims neutrality, it exposes an internal
  identifier before 15.2 has decided how orgs should surface, and it makes the declared
  `ProjectRow` / `WorkspaceRow` / `ReportArtifactRow` interfaces LIE about their runtime
  shape (they do not declare `orgId`; the values carry it).
suggestion:
  Give these reads explicit column lists matching their declared Row interfaces. That
  restores neutrality and removes the type lie in one move. `search.ts` keeps its own
  org-bearing selects — those are internal and already explicit.
```

```
severity: medium
file: apps/ingest/src/routes/workspaces.ts
line: 47
issue: POST /v1/discover gained an N+1 — up to 3 extra getOrgIdForUser SELECTs per workspace in the loop, for a value constant across the whole request
detail:
  The discover handler loops over `request.body.workspaces`. Each iteration now calls
  `upsertWorkspace` (1 lookup), `addWorkspaceKey` (1 lookup) and, when unmapped,
  `findOrCreateProjectByRemote` or `createProject` (1 more) — every one of which
  independently resolves the SAME user's org. A collector reporting 50 workspaces issues
  ~150 redundant single-row SELECTs inside one transaction.
suggestion:
  Two options. (a) Resolve once in the route and pass `orgId` down — but that changes
  three public repository signatures, which the plan explicitly avoided (Conflict 2).
  (b) Accept it: the queries are indexed single-row lookups inside an existing
  transaction, the loop is small in practice, and 15.2's request principal deletes the
  `getOrgIdForUser` seam entirely. Recommend (b) WITH the cost written down, so 15.2
  removes it deliberately rather than rediscovering it.
```

```
severity: low
file: packages/db/src/repositories/machines.ts
line: 63
issue: recordHeartbeat issues a SELECT for the org that the UPDATE it already runs could return for free
detail:
  `recordHeartbeat` now does `getMachineOrgId` (SELECT) and then
  `UPDATE machines ... WHERE id = ?`. The update already targets exactly that row, so
  `.returning({ orgId: machines.orgId })` yields the org with no extra round trip. This
  runs on every collector heartbeat (~30 s cadence per machine), so it is the one added
  query on a genuinely repeating path.
suggestion:
  Drop the separate SELECT and take `orgId` from the UPDATE's `returning()`. An empty
  result also gives the unknown-machine guard for free, before any heartbeat row is
  inserted. Behaviour is identical; one fewer query per heartbeat.
```

```
severity: low
file: packages/db/src/repositories/search.ts
line: 417
issue: rebuildSearchIndex deletes every search_documents row globally — an admin reindex in one org wipes every other org's index
detail:
  `tx.delete(searchDocumentsTbl)` has no predicate. This is PRE-EXISTING behaviour and
  correct under one tenant, but `org_id` now makes it a cross-tenant destructive
  operation: org A's admin triggering a rebuild deletes org B's documents, and the
  rebuild only re-materialises what the (unscoped) source queries happen to find.
  Not introduced by this slice and not a leak — flagging so it is not forgotten.
suggestion:
  Leave as-is here; this is genuinely 15.2/15.3 scope (it needs the request principal to
  know WHICH org to rebuild). Record it in the 15.2 plan so the delete gains an org
  predicate at the same time the read paths do.
```

```
severity: low
file: apps/ingest/src/routes/pairing-codes.ts
line: 24
issue: an explicit userId for a user with no membership produces a 500 rather than a clean error
detail:
  When `request.body.userId` is supplied, the handler skips `ensurePersonalOrg` and goes
  straight to `createPairingCode`, which calls `getOrgIdForUser` and throws
  "user <id> has no organization" → an unhandled 500.

  Unreachable through the application today: all three `users` insert sites
  (`ensureUserByEmail`, `setUserPassword`, this route's inline upsert) create an org,
  and the 0014 backfill covered history. Only a hand-inserted row could trigger it.
suggestion:
  Acceptable as-is — the throw is the plan's intended "clear error rather than a null
  insert", and D-M15-8 deletes this endpoint in 15.5. No change; noted for completeness.
```

---

## Verified as correct (no action)

- **The 0014 up/down SQL.** Statement order is right: `DROP INDEX` precedes the
  re-`CREATE`; `machines` is backfilled before every machine-keyed table that reads from
  it; `git_commit_files` after `git_commits`; `SET NOT NULL` after the 3b fallback. The
  down file drops `memberships` before `organizations` (FK order) and relies correctly on
  `DROP COLUMN` cascading each FK and `*_by_org` index. Round-tripped on a real-size
  clone: up ≈22.1 s, down ≈8.8 s, re-up ≈22.7 s, 0 nulls, data intact.
- **`org_id` omitted from `ingest.ts`'s `onConflictDoUpdate.set`** (D-M15-2). Pinned by a
  real converging-re-ingest test that asserts `machine_id` moves but `org_id` does not.
- **`events` PK is still `fingerprint` alone**; `packages/shared/src/fingerprint.ts` has a
  zero diff. Both asserted in `tenancy.int.test.ts`.
- **`upsertDoc`'s ON CONFLICT target matches the new unique index exactly** — the failure
  mode called out as highest-risk in the plan does not occur (`search.int.test.ts` and
  the full rebuild both pass).
- **Derive-vs-pass for machine-keyed writes.** `getMachineOrgId` inside the transaction
  is the right call: it left `ingestBatch`'s 25 call sites untouched and makes a wrong org
  unrepresentable. The `if (!orgId) throw` guards are present on all four derive sites.
- **`ensurePersonalOrg` idempotency**, which `setUserPassword` depends on every boot.
  Tested directly, including that a different `name` does not re-create or rename.
- **No secrets, no injection.** Every new predicate is a bound parameter; the one raw
  interpolation (`sql.raw`) pattern is not used in this diff. No new logging in library
  files. No new long-lived resources (no timers, streams, listeners, or proxied fetches),
  so the M9 teardown-leak class does not apply.
- **The tenant/global split** is exactly 15/4 and is asserted from `information_schema`
  rather than trusted.

---

## Recommendation

Fix finding 1 (cross-tenant leak in the index builder, with a regression test that drives
the real builder), finding 2 (narrow the selects), and finding 4 (free the heartbeat
query). Accept 3, 5 and 6 with the reasons recorded above and carried into the 15.2 plan.

---

## Outcomes (applied 2026-07-26, same branch)

| # | Severity | Finding                                        | Outcome |
| - | -------- | ---------------------------------------------- | ------- |
| 1 | high     | `indexSessions` cross-org collapse + leak      | **fixed** |
| 2 | medium   | `org_id` on the wire in 6 endpoints            | **fixed** |
| 3 | medium   | `POST /v1/discover` N+1                        | accepted (documented) |
| 4 | low      | redundant `recordHeartbeat` SELECT             | **fixed** |
| 5 | low      | `rebuildSearchIndex` global delete             | accepted (deferred to 15.2) |
| 6 | low      | explicit-`userId` pairing-code 500             | accepted (unreachable; 15.5 deletes the route) |

**Finding 1** — `indexSessions` now selects `raw_source_records.org_id` as a real GROUP BY
column (not `min(...)`) and groups by `(org_id, session_id)`. `indexOneSession`,
`indexSessionEvents` and the attribution join are scoped by `s.orgId`. These are
index-BUILDER predicates on a write path, so the "no read path gains an org filter"
criterion still holds — `searchDocuments()` itself is untouched and stays 15.2's job.
Pinned by a new test that drives the real builder end-to-end (`tenancy.int.test.ts` §2b):
two orgs ingesting the same session id now produce **2** documents, each containing only
its own org's content, with per-event docs stamped to the org that produced them. Verified
failing before the fix (1 doc, `containsA=true containsB=true`) and passing after.

**Finding 2** — `projects.ts`, `workspaces.ts` and `reports.ts` gained explicit
`*RowColumns` constants used by every `select()` and `returning()`. Re-probed: `orgId` is
gone from all three shapes, and the runtime objects now match their declared `ProjectRow` /
`WorkspaceRow` / `ReportArtifactRow` interfaces — the type lie is closed too. The comment on
each constant states WHY it is explicit, so the next column addition does not silently
re-widen the API.

**Finding 4** — `recordHeartbeat` takes `orgId` from `.returning()` on the `UPDATE machines`
it already ran; the separate SELECT is gone. An empty result is now the unknown-machine
guard, and it fires before any heartbeat row is written.

Gates after fixes: `typecheck` 0 · `lint` 0 · `format:check` 0 · `build:dashboard` 0 ·
`repo-health --require-db` **PASS** (841 tests, **200** integration, **0 skipped**).
