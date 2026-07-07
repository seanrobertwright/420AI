# Code Review — M13 Slice 13.4 (Incremental search + dashboard polish)

Branch: `m13-slice4-incremental-search` · Reviewed: 2026-07-07 · Reviewer: automated pre-commit review

**Stats:**

- Files Modified: 16
- Files Added: 4
- Files Deleted: 0
- New lines: 5217 (≈4,700 of which are `package-lock.json` for the three new dashboard deps)
- Deleted lines: 2276

## Issues

```
severity: high
file: packages/db/src/repositories/projects.ts (+ reports.ts, routes, dashboard pages)
line: 70
issue: New DEFAULT limit 50 on listProjects/listReportArtifacts silently truncates three existing full-list consumers
detail: GET /v1/projects previously returned ALL projects. Three consumers depend on that:
  (1) apps/dashboard/src/app/projects/[id]/page.tsx:59 — the projects list is the EXISTENCE
      AUTHORITY for the detail page (`projects.find(p => p.id === id)`). With >50 projects, any
      project outside the newest-50 window renders as "not found" — a hard functional break.
  (2) apps/dashboard/src/app/machines/page.tsx:20 — the workspace-remap picker would silently
      omit projects beyond 50 (mis-mapping surface).
  (3) apps/collector/src/ingest-client.ts:199 getProjects — collector mapping flows would
      silently miss projects. Slice 13.6's planned generate-reports script (GET /v1/projects →
      report per project) would also silently skip projects.
  A capped default with max 200 also leaves >200-project archives with NO way to enumerate.
suggestion: Make the limit apply ONLY when the caller passes one (omitted → full list, the
  pre-13.4 behavior, zero regression for every existing consumer). The paged dashboard lists
  pass an explicit limit=50 so the UI still gets bounded first pages + "Load more". The plan's
  "default 50" intent (bounded UI pages) is preserved where it matters — at the UI call sites.
```

```
severity: medium
file: packages/db/src/repositories/search.ts
line: 214 (indexSessions)
issue: Unbounded inArray over ALL distinct session ids in the rebuild path
detail: rebuildSearchIndex now enumerates every distinct sessionId and passes the whole list
  through one `inArray(...)`. node-postgres binds each id as a parameter; Postgres's wire
  protocol caps a statement at 65,535 bind params, so a large archive (>65k sessions) makes the
  full rebuild throw a protocol error. Also produces a pathologically large SQL text well
  before that.
suggestion: Chunk the id list inside indexSessions (500 ids per meta query). Behavior
  identical; bounded SQL for every caller.
```

```
severity: low
file: apps/ingest/src/routes/projects.ts
line: 37
issue: GET /v1/projects now 400s on UNKNOWN query params (additionalProperties:false)
detail: Previously the route had no querystring schema, so stray params were ignored; now they
  are rejected. This matches the repo's existing querystring schemas (search, reports), and no
  known consumer sends extra params.
suggestion: No change — consistent with repo convention; noted as an intentional behavior change.
```

```
severity: low
file: apps/ingest/src/routes/ingest.ts
line: 30
issue: Events-only batches (records: []) do not refresh session docs
detail: touched sessions derive from request.body.records per the plan ("sessionIds from
  request.body.records"). A hypothetical events-only batch would skip the refresh — harmless,
  because the session doc body is built exclusively from raw records, which such a batch does
  not change.
suggestion: No change — matches the plan and the doc-content model.
```

## Verification performed

- Enumerated every caller of `listProjects`, `listReportArtifacts`, and `GET /v1/projects`
  (grep, all workspaces) to confirm the truncation blast radius above.
- Full gate: root `tsc -b` 0 errors; `repo-health -- --require-db` PASS (677 tests, 179
  integration ran, 0 skipped) — re-run after the fixes below.
- Level-4 (live stack, CDP-driven headless Edge with real login): mermaid SVG renders on
  /reports; ADMIN_TOKEN occurrences in fully rendered HTML = 0; incremental search hit a
  just-created project/report with `<b>` highlights and no reindex call.

## Resolution

Issues 1 (high) and 2 (medium) fixed in this slice before commit:

- `listProjects`/`listReportArtifacts` apply `limit`/`offset` only when provided; omitted →
  full list (pre-13.4 behavior). Route schemas unchanged (limit 1..200 when present).
- Dashboard projects/reports pages fetch their FIRST page with an explicit `limit=50`;
  "Load more" pagers unchanged.
- `indexSessions` chunks its id list (500/query).
- Int test extended: omitted-limit returns the full list.

Issues 3 and 4 documented, intentionally unchanged.
