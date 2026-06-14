# Code Review — Milestone 7: Reporting Foundation

**Reviewed:** 2026-06-14 · branch `m7` · against HEAD `54c060a`

**Stats:**

- Files Modified: 8 (README.md, apps/ingest/src/app.int.test.ts, apps/ingest/src/app.ts,
  apps/ingest/src/schemas.ts, packages/db/drizzle/meta/_journal.json, packages/db/src/index.ts,
  packages/db/src/schema.ts, packages/shared/src/index.ts)
- Files Added: 8 (packages/shared/src/reports.ts + .test.ts, packages/db/src/repositories/reports.ts +
  .int.test.ts, packages/db/drizzle/0002_certain_stark_industries.sql + meta/0002_snapshot.json,
  apps/ingest/src/reports/generate-report.ts, apps/ingest/src/routes/reports.ts)
- Files Deleted: 0
- New lines: ~234 modified insertions + ~797 new-file lines
- Deleted lines: 5

---

## Issues

```
severity: medium
file: apps/ingest/src/routes/reports.ts
line: 46-57 (POST /v1/projects/:id/reports handler)
issue: A well-formed but NON-EXISTENT project UUID returns 500 (FK violation), not a clean 404.
detail: The handler guards only `isUuid(:id)` → 404 for a MALFORMED id. A well-formed uuid that is not
  a real project passes the guard, then generateProjectCostReport → insertReportArtifact INSERTs a row
  whose project_id FK (report_artifacts_project_id_projects_id_fk → projects.id) is unsatisfied, so
  Postgres raises a foreign-key violation that bubbles to the generic 500 handler. Verified live against
  the test DB: POST /v1/projects/00000000-0000-4000-8000-000000000000/reports → 500. This breaks the
  codebase-wide invariant (auth.ts isUuid comment; M5/M6 int tests) that an unknown id is a guard
  404/200, NEVER a Postgres-cast/constraint 500. The M6 projection reads return 200-zeros for an unknown
  uuid precisely because they do not INSERT; M7's FK makes the same input a 500.
suggestion: After the isUuid guard, verify the project exists before generating — e.g. resolve the
  project name and 404 if absent: `const name = await getProjectName(app.db, request.params.id); if
  (!name) return reply.code(404).send({ error: "project not found" });`. This distinguishes a
  non-existent project (undefined → 404) from an existing-but-empty one (returns the name → D7 all-zero
  report still generates at version 1). Add a regression int test asserting the well-formed-nonexistent
  uuid → 404.
```

```
severity: low
file: packages/db/src/repositories/reports.ts
line: 35-52 (insertReportArtifact)
issue: Concurrent regeneration of the same (userId, reportType, scopeId) can 500 on a unique-index race.
detail: version is computed as max(version)+1 in the transaction, but under READ COMMITTED two
  simultaneous generations can read the same max and both attempt version N+1, violating
  report_artifacts_scope_version → one request 500s. This is by-design (the plan names the unique index
  as the backstop) and negligible for single-user M2, so it is informational, not a defect.
suggestion: Acceptable as-is for M2. If multi-user/concurrent generation ever lands, retry-on-conflict
  or an ON CONFLICT loop would make it robust. No change required now.
```

```
severity: low
file: packages/shared/src/reports.ts
line: 70-95, 150-205 (renderers interpolate user-controlled strings into Markdown)
issue: projectName / sessionId / projectPath / gitBranch are interpolated verbatim into Markdown.
detail: A name containing Markdown/Mermaid metacharacters could distort the rendered artifact. In the
  single-user, admin-only, plaintext-metrics context (values originate from the user's own repos/paths)
  this is benign — no XSS surface (no HTML/web render in M7), no injection into SQL (Drizzle params),
  no secret exposure. Noted for completeness; the M8 redaction path is where any escaping concern lands.
suggestion: No change for M7. Revisit if/when a web dashboard renders these artifacts as HTML.
```

---

## Verified-clean areas

- **Migration:** `0002_certain_stark_industries.sql` is purely additive — one `CREATE TABLE
  report_artifacts` + its own FK constraints + two indexes; no `ALTER`/`DROP` on events,
  raw_source_records, workspaces, workspace_keys, or projects. `db:generate` reports schema↔migrations
  in sync. Honors invariant D4.
- **Plaintext / no-decrypt (D3):** renderers + orchestrator read only the M6 plaintext projections;
  no `payload_*` columns on report_artifacts; `decryptField` never imported. PRD §18.1 honored.
- **Renderer purity:** `@420ai/shared/reports.ts` is dependency-free, clock-injected (no `new Date()`),
  type-only imports — matches the M1 renderSessionReport contract. `fmtUsd` is byte-identical (6 dp).
- **Auth:** all four endpoints reuse the shared constant-time `adminAuthorized` gate; no new auth path.
- **Scope decisions honored:** two report types only; no `report.generated` event; no diff/compare
  endpoint; the `metrics` JSON snapshot is stored (the future-compare seam) but not diffed.
- **Versioning (D5):** insert appends with version=max+1; retained history; verified by the db int test
  (version 1→2, distinct scope restarts at 1) and the ingest round-trip int test.
- **Library silence:** no stdout/stderr or process.exit in any library/orchestrator file.

## Test posture

- 11 pure unit tests (`reports.test.ts`), 5 db int tests (`reports.int.test.ts`), 4 ingest int tests
  (round-trip, autopsy, 401s, guards). `repo-health --require-db`: 56 int tests ran, 0 skipped.
- Gap closed by the medium finding's suggested regression test: the well-formed-nonexistent project uuid
  case was not previously asserted.
```
```
