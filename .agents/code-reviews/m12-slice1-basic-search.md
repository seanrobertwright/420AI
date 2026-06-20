# Code Review — M12 Slice 12.1 (Basic Search)

Reviewed: the slice diff (search projection table, repository, routes, types, migration, docs).
Scope: correctness, security, performance, codebase-standard adherence.

**Stats:**

- Files Modified: 9
- Files Added: 8 (3 source: `search.ts` shared, `search.ts` db repo, `search.ts` route; 1 test; 2 migration artifacts; 2 pre-existing docs swept in)
- Files Deleted: 0
- New lines: ~218 (tracked-file diff) + new files
- Deleted lines: ~8

---

## Issues

```
severity: medium
file: packages/db/src/repositories/search.ts
line: 99 (rebuildSearchIndex — `await db.delete(searchDocumentsTbl)` then per-row inserts)
issue: Full reindex is NOT atomic — a mid-rebuild failure leaves the index deleted/partial.
detail: rebuildSearchIndex deletes every row, then re-inserts reports/projects/sessions in
  separate statements with no enclosing transaction. The session loop decrypts content, and
  decryptField throws on a key/tag error (by design — silent library). If ANY session fails to
  decrypt (or any insert errors) partway through, the prior good index is already gone (the
  DELETE committed) and only a partial set of rows exists. GET /v1/search then silently returns
  incomplete results until a later reindex happens to succeed. Every other multi-write repo in
  the codebase (ingest.ts, git.ts, reports.ts, pricing-catalogs.ts) wraps its delete/insert
  sequence in db.transaction so a failure rolls back cleanly — this repo is the outlier.
suggestion: Wrap the whole rebuild body in `return db.transaction(async (tx) => { ... })` and
  route all inner queries (delete, selects, upsertDoc) through `tx`. DbClient supports
  `.transaction` (reports.ts uses the identical pattern with a DbClient param), so the signature
  is unchanged. A failed reindex then leaves the previous index fully intact.
```

```
severity: low
file: packages/db/src/repositories/search.ts
line: 137-181 (per-project workspace query; per-session attribution + raw-record queries)
issue: N+1 query shape in rebuildSearchIndex.
detail: One extra query per project (workspace roots) and two per session (attribution + raw
  records). For a large archive this is O(projects + 2·sessions) round-trips.
suggestion: ACCEPT AS-IS. This is the manual-first, admin-triggered reindex (the M10 catalog
  precedent) at single-user GA scale — it runs infrequently and off the hot path. Batching is a
  deferred refinement, not a slice blocker. Noted so it is a conscious choice, not an oversight.
```

```
severity: low
file: packages/db/src/repositories/search.ts
line: 163 (min(${machines.userId}::text) as the session's representative userId)
issue: A session whose raw records span machines owned by different users picks one user arbitrarily.
detail: groupBy(sessionId) collapses to one doc (required by the (entity_type, entity_id) unique
  index); min() over the cast uuid selects a deterministic-but-arbitrary owner if owners differ.
suggestion: ACCEPT AS-IS for single-user GA (one user owns all machines, so the set is a
  singleton). Revisit when multi-user (V2) makes cross-user session ids possible.
```

## Verified NOT issues

- **SQL injection:** `q` is a BOUND param in `websearch_to_tsquery('english', ${opts.q})` and
  `ts_headline(...)` — drizzle parameterizes it; `'english'` is a constant literal, never a param.
  Confirmed via live HTTP test (FTS operators/quotes handled by websearch_to_tsquery).
- **Secret leakage:** every stored string passes `redact()` first; live test confirmed
  `[REDACTED:anthropic_key]` in both the snippet and the stored body, 0 raw-secret rows.
- **GENERATED column writes:** `searchVector` is never in any insert/upsert set — Postgres would
  reject it. Confirmed (insert path omits it; reindex succeeded).
- **projectId 500 risk:** the route guards `isUuid(projectId)` → 404 before the repo runs, so a
  malformed filter never reaches the uuid-typed `eq`. Confirmed (404 in live test).
- **Multi-embed `tsq` fragment** (reused in select snippet, where `@@`, rank, orderBy): each embed
  re-renders with its own bound param — valid. Confirmed (ranked hit returned, EXPLAIN uses GIN).
- **Resource teardown:** routes are pure request/response — no SSE/timer/listener added, so the
  M9 leak class does not apply.

## Action

- **[medium] atomic reindex — FIXED.** `rebuildSearchIndex` now wraps the entire delete + rebuild
  in `db.transaction(async (tx) => …)` (all inner queries routed through `tx`). A mid-rebuild
  failure rolls back, leaving the previous index intact. Re-verified: root `tsc -b` exit 0;
  `search.int.test.ts` 5/5 pass (incl. idempotency); `repo-health --require-db` PASS (121 int
  tests, 0 skipped).
- **[low] N+1 reindex** and **[low] arbitrary session owner** — accepted-as-designed (manual-first
  scale / single-user GA) and named here so the trade-off is explicit, not an oversight.
