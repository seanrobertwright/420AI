# Feature: M12 Slice 12.1 — Basic Search (PRD §21)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files.

> **Conventions are NOT re-pasted here.** The repo conventions (module/TS rules, the validation GATE,
> the DB/Drizzle gotchas, the "raw sacred / events disposable" invariant) live in
> [`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — they are the source of truth.
> This plan links to them; read the **"Drizzle / SQL gotchas"** and **"Validation is a GATE"** sections
> of `CLAUDE.md` before starting.

## Feature Description

The first slice of **M12 (Production Readiness / GA)** and the last V1 *functional* hole (PRD §21):
admin full-text **search** across the archive. Per PRD §18.1/§21, search runs over a **redacted
plaintext projection — never the encrypted originals**. We materialize a `search_documents` table whose
rows are redacted text + a Postgres `GENERATED` `tsvector` (GIN-indexed), populated by an admin-triggered
**reindex** that pulls from reports, projects, and sessions — decrypting session content for render and
running it through the M8 `redact()` engine **before** it is stored. An admin-gated `GET /v1/search`
serves ranked hits.

Advanced semantic/vector search stays **V2** (PRD §21). Real-time/incremental index maintenance is a
**deferred refinement** — this slice is manual-first (mirrors the M10 pricing-catalog "manual trigger
first" precedent), which keeps the hot ingest path **untouched** (a repo-wide invariant).

## User Story

As the **self-hosted single user (admin)** of 420AI
I want to **full-text search my sessions, reports, and projects from one endpoint**
So that **I can find a past AI session, report, or project by what was said/written in it — without
the secrets in that content ever being exposed** (search hits come from a redacted projection).

## Problem Statement

The archive can store, attribute, project, report on, and monitor events, but it **cannot answer "where
did I…?"** There is no search endpoint and no search index anywhere in the repo (confirmed: no
`to_tsvector`/`tsvector`/`websearch_to_tsquery` in `apps/ingest/src/routes` or `packages/db`). Session
message/tool content is **encrypted at rest** (`raw_source_records.payload_ciphertext`), so it cannot be
searched directly — and must never be indexed in the clear (PRD §18.1).

## Solution Statement

A **materialized redacted search projection**:

1. A new additive `search_documents` table: scalar text columns (`title`, `body`) + a Postgres
   `GENERATED ALWAYS AS (...) STORED` `tsvector` column (`search_vector`) with a **GIN** index. Postgres
   recomputes the vector from `title`+`body` on every write — the app never maintains it.
2. A repository with two functions: `rebuildSearchIndex(db)` (full rebuild: redact-then-store from
   reports + projects + sessions, decrypting session content via the M8 decrypt-for-render path) and
   `searchDocuments(db, opts)` (the `websearch_to_tsquery` + `ts_rank` read).
3. Admin-gated routes: `POST /v1/search/reindex` (rebuild) and `GET /v1/search` (query), mirroring the
   existing projections route + auth pattern.

**Uniform invariant:** every string written to `search_documents` passes through `redact()` first, and the
row is stamped with `REDACTION_VERSION` (PRD §23). Since search hits/snippets are returned to the browser
(they *leave the archive*), redaction-before-index is the §18 gate applied to this surface.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: `packages/db` (new table + migration + repository), `packages/shared` (result
types), `apps/ingest` (new route + schemas + registration)
**Dependencies**: None new. Reuses `@420ai/shared` `redact`/`redactJson`/`REDACTION_VERSION`,
`@420ai/db` `decryptField`, and Postgres built-in FTS (`to_tsvector`/`websearch_to_tsquery`/`ts_rank`/
`ts_headline`). Drizzle 0.45.2 / drizzle-kit 0.31.10 (already present).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/shared/src/redaction.ts` (redact @196, redactJson @261, `REDACTION_VERSION="m8-redact-v1"` @18,
  `RedactionFinding` @25-34) — Why: the redaction engine to reuse. `redact(text): { redacted, findings }`,
  pure/sync/idempotent.
- `packages/db/src/crypto.ts` (full, 1-47) — Why: `decryptField(f: EncryptedField): string` (@40), key from
  `process.env.ARCHIVE_ENCRYPTION_KEY`. The decrypt half of decrypt-for-render.
- `packages/db/src/repositories/transcript.ts` (`sessionTranscript` @67-142) — Why: the canonical
  decrypt-for-render read to MIRROR — events ⨝ raw_source_records, select the ciphertext triple, decrypt,
  order, dedupe by rawRecordId, cap. The reindex's session path mirrors this shape.
- `packages/db/src/repositories/transcript.int.test.ts` (full) — Why: the EXACT int-test harness to mirror
  — `describe.skipIf(!TEST_URL)` @71, `createDb(TEST_URL!)` @76, `pool.end()` @80, `TRUNCATE … RESTART
  IDENTITY CASCADE` @84-85, and **seeding encrypted content via `ingestBatch(dbh.db, machineId, makeBatch())`**
  @96. Inherits `ARCHIVE_ENCRYPTION_KEY` from `.env` (no inline key setup).
- `packages/db/src/repositories/projections.ts` (`usageTotals` @ the first export; `usageOverTime` for the
  bucketed read) — Why: the read-repository shape to MIRROR — `(db: DbClient, …): Promise<T>`, Drizzle
  `.select().from().where()`, `sql<…>` templates, `Number(...)` numeric coercion.
- `packages/db/src/repositories/projections.int.test.ts` (@18-96) — Why: seed pattern for projects/
  workspaces (`upsertWorkspace`, `findOrCreateProjectByRemote`, `remapWorkspace`, `addWorkspaceKey`) and
  the `seedSession()`/events insert shape.
- `packages/db/src/repositories/reports.ts` + `reports.int.test.ts` (@36 `artifact()` factory) — Why: how
  `report_artifacts` rows (incl. `markdown`) are created/inserted — the report source for the index.
- `packages/db/src/schema.ts` — Why: the table-definition style + the EXACT columns to read:
  - `events` @107-143 (plaintext metadata; ciphertext triple `payload_ciphertext/iv/tag`).
  - `raw_source_records` @80-105 (`session_id`, `machine_id`, ciphertext triple, `ingested_at`).
  - `report_artifacts` @238-272 (**all plaintext**; `markdown` @key, `project_id`, `report_type`, `user_id`).
  - `projects` @158-171 (`name`, `git_remote`, `user_id`), `workspaces` @178-197 (`root_path`, `git_remote`,
    `git_branch`, `project_id`).
  - `alert_firings` partial unique index @420 (`.where(sql\`…\`)`) — the raw-SQL-in-schema precedent.
- `apps/ingest/src/routes/projections.ts` (@25 `export default async function projectionRoutes`, @26-34
  inline `adminAuthorized`→401 / `isUuid`→404, @56-69 GET-with-querystring) — Why: the route shape to MIRROR.
- `apps/ingest/src/auth.ts` (`adminAuthorized(app, request): boolean`, `isUuid(s): boolean`) — Why: the auth
  guards. Used **inline**, not as preHandler.
- `apps/ingest/src/app.ts` (@64-79 the `app.register(...)` block) — Why: where to register the new route.
- `apps/ingest/src/schemas.ts` (`usageOverTimeQuerySchema` @160-166) — Why: the querystring JSON-schema style.
- `apps/ingest/src/routes/exports.ts` (@304 `redact(e.text)` per decrypted entry; @133 `REDACTION_VERSION`
  header) — Why: the decrypt→redact ordering precedent for content leaving the archive.
- `packages/db/src/index.ts` (@62-69 the projections re-export block) — Why: barrel export pattern for new
  repo functions + the new table.

### New Files to Create

- `packages/shared/src/search.ts` — `SearchHit`, `SearchResults`, `SearchEntityType`, `ReindexCounts`
  result types (the result-type-in-shared convention).
- `packages/db/src/repositories/search.ts` — `rebuildSearchIndex(db)` + `searchDocuments(db, opts)`.
- `packages/db/src/repositories/search.int.test.ts` — integration test (decrypt+redact+index+query).
- `apps/ingest/src/routes/search.ts` — `searchRoutes` plugin (`GET /v1/search`, `POST /v1/search/reindex`).
- (generated) `packages/db/drizzle/0008_*.sql` — the migration (produced by `db:generate`, **do not** hand-write).

### Files to Modify

- `packages/db/src/schema.ts` — add `searchDocuments` table.
- `packages/db/src/index.ts` — re-export the table + the two repo functions.
- `packages/shared/src/index.ts` — re-export the new search types.
- `apps/ingest/src/schemas.ts` — add `searchQuerySchema`.
- `apps/ingest/src/app.ts` — import + `app.register(searchRoutes)`.
- `docs/guide/usage.md` — document `GET /v1/search` + `POST /v1/search/reindex`.
- `SUMMARY.md` §6 — tick 12.1; `docs/PRD.md` §25 M12 — note 12.1 status on sign-off.

### Relevant Documentation

- [PostgreSQL Full Text Search — Controlling Text Search](https://www.postgresql.org/docs/17/textsearch-controls.html)
  - `websearch_to_tsquery`, `ts_rank`, `ts_headline`, `setweight`. Why: the exact functions used; PG17 is the
    archive version (`docker-compose.yml`).
- [PostgreSQL — Generated Columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html)
  - `GENERATED ALWAYS AS (...) STORED`. Why: the `search_vector` column is DB-maintained.
- [Drizzle ORM — customType & generated columns](https://orm.drizzle.team/docs/generated-columns)
  - `customType` for `tsvector`, `.generatedAlwaysAs(sql\`…\`)`, `index().using("gin", col)`. Why: the schema
    definition that `drizzle-kit generate` turns into the migration (verified by spike — see NOTES).

### Patterns to Follow

**New table in `schema.ts`** (customType + generated tsvector + GIN — VERIFIED by spike, see NOTES):

```ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// tsvector is not a built-in drizzle type; declare it once via customType.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * M12 §21 redacted search projection. Every row's `title`/`body` is ALREADY
 * redacted (REDACTION_VERSION stamped) — we NEVER index encrypted originals
 * (PRD §18.1). `search_vector` is DB-GENERATED from title (weight A) + body
 * (weight B); the app never writes it. Disposable projection — rebuilt by
 * rebuildSearchIndex(), never a source of truth.
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    entityType: text("entity_type").notNull(), // 'session' | 'report' | 'project'
    entityId: text("entity_id").notNull(),     // sessionId | report uuid | project uuid
    projectId: uuid("project_id"),             // nullable filter key
    title: text("title"),
    body: text("body").notNull(),
    redactionVersion: text("redaction_version").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex("search_documents_entity").on(t.entityType, t.entityId),
    index("search_documents_gin").using("gin", t.searchVector),
    index("search_documents_by_project").on(t.projectId),
  ],
);
```

**Read-repository shape** (mirror `projections.ts`): `export async function fn(db: DbClient, …): Promise<T>`,
`Number(...)` any `numeric`/rounded rank, `sql<...>` typed templates, `sql.raw` for closed-set keywords
(none needed here — `'english'` is a constant literal in the SQL string, not a bound param).

**Auth/route shape** (mirror `projections.ts` @26-34, @56-69): inline `adminAuthorized(app, request)`→401,
`isUuid`→404 for any uuid path/filter; querystring via a `schemas.ts` JSON schema.

**Decrypt→redact ordering** (mirror `exports.ts` @304 / `generate-interpretation.ts` @64): decrypt the raw
record, then `redact()` the plaintext, **then** store. Never store the un-redacted decrypted text.

> **Spike-snippet fidelity:** the `search_documents` snippet above was run through `drizzle-kit generate`
> and the emitted SQL was applied to live PG17 (see NOTES → Spikes). The generated column expression and
> GIN index match verbatim. If you change the `generatedAlwaysAs` expression, re-run `db:generate` and
> re-verify the SQL.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — types + table + migration
Add the shared result types, the `searchDocuments` table, and generate the migration.

### Phase 2: Core — the repository
`rebuildSearchIndex(db)` (redact-then-store from reports/projects/sessions, decrypting session content) and
`searchDocuments(db, opts)` (websearch query + rank + headline snippet).

### Phase 3: Integration — routes + registration + barrels
`GET /v1/search`, `POST /v1/search/reindex`, schema, `app.register`, barrel exports.

### Phase 4: Testing & Validation — int test + the DB-required gate
Integration test that seeds encrypted content via `ingestBatch`, reindexes, and asserts search hits +
redaction; run the full `repo-health -- --require-db` gate.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and validated.

### CREATE `packages/shared/src/search.ts`
- **IMPLEMENT**: Result/param types:
  ```ts
  export type SearchEntityType = "session" | "report" | "project";
  export interface SearchHit {
    entityType: SearchEntityType;
    entityId: string;
    projectId: string | null;
    title: string | null;
    snippet: string;   // redacted ts_headline fragment — safe to render
    rank: number;
  }
  export interface SearchResults { query: string; hits: SearchHit[] }
  export interface ReindexCounts { reports: number; projects: number; sessions: number; total: number }
  ```
- **PATTERN**: mirror result types in `packages/shared/src/projections.ts` / `reports.ts`.
- **GOTCHA**: `@420ai/shared` has **no runtime deps** — types only here. No import of `redact` (that's used in
  the db repo, which already depends on shared).
- **VALIDATE**: `npx tsc -b packages/shared` → exit 0.

### UPDATE `packages/shared/src/index.ts`
- **IMPLEMENT**: `export type { SearchEntityType, SearchHit, SearchResults, ReindexCounts } from "./search.js";`
- **PATTERN**: existing `export type { … } from "./….js"` lines.
- **VALIDATE**: `npx tsc -b packages/shared` → exit 0.

### UPDATE `packages/db/src/schema.ts`
- **IMPLEMENT**: add the `tsvector` `customType` + the `searchDocuments` table (snippet in "Patterns").
  Place `searchDocuments` after the latest additive table (`pricing_catalogs`); place the `customType` near
  the top imports. Ensure `users` is referenced for the FK (already imported/defined in this file).
- **IMPORTS**: add `customType` to the existing `drizzle-orm/pg-core` import; `sql` is already imported.
- **GOTCHA**: do NOT add `searchVector` to any insert in the repo — it is `GENERATED`; inserting it errors.
- **VALIDATE**: `npx tsc -b packages/db` → exit 0.

### GENERATE migration `packages/db/drizzle/0008_*.sql`
- **IMPLEMENT**: `npm run db:generate` (drizzle-kit). Inspect the generated `0008_*.sql`: it MUST contain
  `"search_vector" "tsvector" GENERATED ALWAYS AS (...) STORED` and `CREATE INDEX … USING gin
  ("search_vector")` (verified by spike). Do **not** hand-edit it.
- **GOTCHA**: `db:generate` reads `DATABASE_URL` from env but does NOT connect (offline). If it prompts about
  the generated column, accept the create. Commit the generated SQL + the updated `meta/_journal.json` +
  snapshot.
- **VALIDATE**: `git status --short packages/db/drizzle` shows one new `0008_*.sql` + meta updates;
  `grep -c "USING gin" packages/db/drizzle/0008_*.sql` → `1`.

### APPLY migration to the local archive
- **IMPLEMENT**: `npm run db:up && npm run db:migrate`.
- **VALIDATE**: `docker compose exec -T archive psql -U 420ai -d 420ai -c "\d search_documents"` shows the
  `search_vector` generated column + the `search_documents_gin` GIN index. Exit 0.

### CREATE `packages/db/src/repositories/search.ts`
- **IMPLEMENT**:
  - `rebuildSearchIndex(db: DbClient): Promise<ReindexCounts>` —
    1. `await db.delete(searchDocuments)` (full rebuild; manual-first, idempotent).
    2. **Reports**: select `id, userId, projectId, reportType, markdown` from `report_artifacts`; for each,
       `title = reportType`, `body = redact(markdown).redacted`; upsert a `report` doc.
    3. **Projects**: select `id, userId, name, gitRemote` from `projects` (+ optionally workspace
       `rootPath`s via a join to `workspaces`); `title = redact(name).redacted`, `body =
       redact([name, gitRemote, …rootPaths].filter(Boolean).join(" ")).redacted`; upsert a `project` doc.
    4. **Sessions**: enumerate distinct `sessionId` from `raw_source_records` (with `machineId`→`users.id`
       for `userId`, and the session's `projectId` via the M5 attribution join on `events.projectPath`→
       `workspace_keys`→`workspaces` when resolvable, else null). For each session, read its
       `raw_source_records` (ciphertext triple, `ORDER BY ingestedAt`), `decryptField(...)` each, **cap**
       total chars (reuse the spirit of `DEFAULT_TRANSCRIPT_CAPS`), `redact()` the concatenation; `title =
       sourceConnector + " · " + sessionId`, `body = redacted concatenation`; upsert a `session` doc.
    5. Return `{ reports, projects, sessions, total }`.
  - `searchDocuments(db, opts: { q: string; type?: SearchEntityType; projectId?: string | null; limit?: number }): Promise<SearchResults>` —
    ```ts
    const tsq = sql`websearch_to_tsquery('english', ${opts.q})`;
    const rows = await db
      .select({
        entityType: searchDocumentsTbl.entityType,
        entityId: searchDocumentsTbl.entityId,
        projectId: searchDocumentsTbl.projectId,
        title: searchDocumentsTbl.title,
        snippet: sql<string>`ts_headline('english', ${searchDocumentsTbl.body}, ${tsq}, 'MaxFragments=2, MinWords=3, MaxWords=12')`,
        rank: sql<number>`ts_rank(${searchDocumentsTbl.searchVector}, ${tsq})`,
      })
      .from(searchDocumentsTbl)
      .where(/* and(): search_vector @@ tsq [, eq(entityType,type)] [, eq(projectId,projectId)] */)
      .orderBy(/* desc(rank) */)
      .limit(opts.limit ?? 20);
    return { query: opts.q, hits: rows.map(r => ({ ...r, rank: Number(r.rank) })) };
    ```
- **PATTERN**: `projections.ts` read shape; `transcript.ts` for the decrypt loop + caps; `exports.ts`@304 for
  decrypt→redact ordering.
- **IMPORTS**: `import { redact, REDACTION_VERSION } from "@420ai/shared";`
  `import { decryptField } from "../crypto.js";`
  `import { searchDocuments as searchDocumentsTbl, reportArtifacts, projects, workspaces, rawSourceRecords, machines } from "../schema.js";`
  (alias the table so the table import and the query fn `searchDocuments` don't collide — name the **query
  fn** `searchDocuments` and the **table** `searchDocumentsTbl` in this file).
- **GOTCHA (DB)**: (1) `ts_rank` is `double precision` — pg returns it as a JS number, but `Number(r.rank)`
  defensively per the CLAUDE.md numeric gotcha. (2) `'english'` is a **constant literal inside the SQL
  string**, NOT a bound param — do not parameterize the regconfig. (3) the user `q` IS a bound param (`${opts.q}`)
  — `websearch_to_tsquery` sanitizes it; never string-concat `q`. (4) NEVER select/insert `searchVector` (it's
  GENERATED). (5) decrypt requires `ARCHIVE_ENCRYPTION_KEY` in env — same as every decrypt path.
- **GOTCHA (redaction)**: redact EVERY string before storing (title + body), including report markdown and
  project names (home-dir usernames leak via paths). `redact()` is idempotent — safe even on plaintext.
- **VALIDATE**: `npx tsc -b packages/db` → exit 0.

### UPDATE `packages/db/src/index.ts`
- **IMPLEMENT**: re-export `searchDocuments` (table) from `./schema.js` (if schema tables are re-exported
  there — match how `events`/`reportArtifacts` are surfaced) and `{ rebuildSearchIndex, searchDocuments }`
  from `./repositories/search.js`. **Name collision**: the table and the query fn share the name
  `searchDocuments`. Export the **table** under its schema name where tables are exported, and export the
  **repo functions** in the repository block. If both would land in the same namespace, rename the query fn
  export to `searchDocuments` and the table is only imported internally — confirm by reading how other
  repos avoid this (they don't collide today). Simplest: keep the table un-exported from the barrel (only
  the repo + route use it) and export only `{ rebuildSearchIndex, searchDocuments }` (the fn).
- **PATTERN**: `index.ts` @62-69.
- **VALIDATE**: `npx tsc -b` (root) → exit 0.

### CREATE `apps/ingest/src/schemas.ts` entry `searchQuerySchema`
- **IMPLEMENT**:
  ```ts
  export const searchQuerySchema = {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: {
      q: { type: "string", minLength: 1, maxLength: 256 },
      type: { type: "string", enum: ["session", "report", "project"] },
      projectId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  } as const;
  ```
- **PATTERN**: `usageOverTimeQuerySchema` @160-166.
- **VALIDATE**: `npx tsc -b apps/ingest` → exit 0.

### CREATE `apps/ingest/src/routes/search.ts`
- **IMPLEMENT**:
  ```ts
  export default async function searchRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { q: string; type?: SearchEntityType; projectId?: string; limit?: number } }>(
      "/v1/search",
      { schema: { querystring: searchQuerySchema } },
      async (request, reply) => {
        if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
        const { q, type, projectId, limit } = request.query;
        if (projectId !== undefined && !isUuid(projectId)) return reply.code(404).send({ error: "project not found" });
        return reply.code(200).send(await searchDocuments(app.db, { q, type, projectId: projectId ?? null, limit }));
      },
    );
    app.post("/v1/search/reindex", async (request, reply) => {
      if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
      return reply.code(200).send(await rebuildSearchIndex(app.db));
    });
  }
  ```
- **PATTERN**: `projections.ts` route shape (inline auth, querystring schema, `app.db`).
- **IMPORTS**: `import { adminAuthorized, isUuid } from "../auth.js";`
  `import { searchDocuments, rebuildSearchIndex } from "@420ai/db";`
  `import type { SearchEntityType } from "@420ai/shared";`
  `import { searchQuerySchema } from "../schemas.js";`
- **GOTCHA**: this is a `*.int`-style cross-app import only at runtime via the published `@420ai/db` barrel
  (same as other routes) — fine. `app.db`/`app.adminToken` are decorated by the existing plugins.
- **VALIDATE**: `npx tsc -b apps/ingest` → exit 0.

### UPDATE `apps/ingest/src/app.ts`
- **IMPLEMENT**: `import searchRoutes from "./routes/search.js";` and add `app.register(searchRoutes);` to the
  register block (@64-79), after `catalogRoutes`.
- **VALIDATE**: `npx tsc -b` (root) → exit 0.

### CREATE `packages/db/src/repositories/search.int.test.ts`
- **IMPLEMENT**: mirror `transcript.int.test.ts` exactly:
  - `describe.skipIf(!TEST_URL)`, `createDb(TEST_URL!)`, `pool.end()`.
  - `beforeEach`: `TRUNCATE search_documents, workspace_keys, workspaces, projects, report_artifacts,
    raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    then insert a user + machine.
  - Seed: `ingestBatch(dbh.db, machineId, makeBatch())` where `makeBatch()` embeds a **known phrase**
    (e.g. `"the anthropic spend rose"`) AND a **known secret** (`"sk-ant-api03-TESTSECRET0123456789"`) in a
    `message.user` payload; insert a `report_artifacts` row whose `markdown` contains another phrase; create
    a project via `findOrCreateProjectByRemote`.
  - Tests:
    1. `rebuildSearchIndex` returns counts `{ sessions>=1, reports>=1, projects>=1 }`.
    2. `searchDocuments(db, { q: "anthropic spend" })` returns a `session` hit (entityId = the sessionId).
    3. **Redaction**: the secret is **absent** from every hit (`JSON.stringify(hits)` does NOT contain the
       secret) AND absent from the stored `body` (`SELECT body FROM search_documents` contains
       `[REDACTED:` and not the raw secret).
    4. `type: "report"` filter returns only report hits; an unmatched query returns `hits: []`.
    5. Re-running `rebuildSearchIndex` is idempotent (counts stable, no duplicate-key error — the
       `search_documents_entity` unique index holds).
- **PATTERN**: `transcript.int.test.ts` (encrypted seed via `ingestBatch`), `projections.int.test.ts`
  (project/workspace seed helpers).
- **GOTCHA**: this test **requires** the DB + `ARCHIVE_ENCRYPTION_KEY` (decrypt path). It self-skips without
  `DATABASE_URL_TEST`. It is **excluded from `tsc -b`** (int tests are, per `tsconfig`) — vitest type-strips it.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npx vitest run packages/db/src/repositories/search.int.test.ts`
  → all pass, **0 skipped**.

### UPDATE `docs/guide/usage.md`
- **IMPLEMENT**: document `GET /v1/search?q=…[&type=…][&projectId=…][&limit=…]` and
  `POST /v1/search/reindex` (admin-authed), noting hits come from a redacted projection and that reindex is
  manual (run after capture to refresh).
- **VALIDATE**: `grep -c "/v1/search" docs/guide/usage.md` → ≥ 1.

### UPDATE `SUMMARY.md` §6 + `docs/PRD.md` §25 M12 (sign-off only)
- **IMPLEMENT**: on green gate, tick 12.1 in `SUMMARY.md` §6 and note "12.1 Basic Search — DONE" with a one-
  line scope note (manual reindex; incremental deferred; semantic/vector V2). Name the deferrals so they're
  not implied as covered.
- **VALIDATE**: `grep -n "12.1" SUMMARY.md`.

---

## TESTING STRATEGY

### Unit Tests
- Redaction reuse needs no new unit test (covered by `redaction.test.ts`). If any pure helper is extracted
  (e.g. a char-cap concatenator), co-locate a `*.test.ts` mirroring `transcript`'s cap behavior.

### Integration Tests
- `search.int.test.ts` (above) — the load-bearing layer: decrypt→redact→index→query end-to-end against real
  Postgres FTS. MUST run (0 skipped) under `--require-db`.

### Edge Cases
- Empty query (`q=""`) → rejected by schema (`minLength: 1`) → 400.
- Query with FTS operators / quotes / `-negation` → `websearch_to_tsquery` handles safely (spike-verified).
- Session with only non-text/excluded content → still produces a (possibly short) doc; no crash.
- Unknown/malformed `projectId` filter → 404 (mirrors the repo's unknown-id→404 invariant).
- Reindex on an empty archive → returns all-zero counts; `GET /v1/search` returns `hits: []`.
- Re-reindex → idempotent (unique index on `(entityType, entityId)`; full delete-then-insert).
- Secret embedded in session/report/project text → **never** present in any hit or stored row.

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE.

### Level 1: Typecheck (repo-root — catches cross-project/test-only imports)
- `npm run typecheck` (root `tsc -b`) → **exit 0**.
- `npm run typecheck:dashboard` is N/A (no dashboard change in 12.1).

### Level 2: Unit suite
- `npm test` (`vitest run`) → all pass; int tests self-skip without `DATABASE_URL_TEST` (expected locally
  without DB).

### Level 3: Integration (DB-required — the real gate for this slice)
- `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → **exit 0** AND the
  `search.int.test.ts` layer executed (assert **0 skipped**). Per `CLAUDE.md`, a green `repo-health` with int
  tests skipped is NOT evidence — this slice touches `@420ai/db` + `apps/ingest`, so `--require-db` is mandatory.

### Level 4: Manual Validation
```bash
# 1. reindex
curl -s -X POST localhost:8420/v1/search/reindex -H "authorization: Bearer $ADMIN_TOKEN"
# → {"reports":N,"projects":N,"sessions":N,"total":N}
# 2. search
curl -s "localhost:8420/v1/search?q=anthropic%20spend&limit=5" -H "authorization: Bearer $ADMIN_TOKEN"
# → {"query":"anthropic spend","hits":[{"entityType":"session",...,"snippet":"…","rank":0.xx}]}
# 3. auth gate
curl -s -o /dev/null -w "%{http_code}" "localhost:8420/v1/search?q=x"   # → 401
# 4. secret check: confirm no raw secret leaks
docker compose exec -T archive psql -U 420ai -d 420ai -c "SELECT count(*) FROM search_documents WHERE body LIKE 'sk-ant-%';"  # → 0
```

### Level 5: Additional
- `docker compose exec -T archive psql -U 420ai -d 420ai -c "EXPLAIN (COSTS OFF) SELECT 1 FROM search_documents WHERE search_vector @@ websearch_to_tsquery('english','x');"`
  → plan shows `Bitmap Index Scan on search_documents_gin` (index is used).

---

## ACCEPTANCE CRITERIA

- [ ] `GET /v1/search` returns ranked, redacted hits across sessions/reports/projects; admin-gated (401 without token).
- [ ] `POST /v1/search/reindex` rebuilds the index idempotently and returns per-entity counts.
- [ ] Session content is **decrypted, redacted, then indexed** — no encrypted original is indexed (PRD §18.1).
- [ ] No raw secret appears in any hit, snippet, or stored `search_documents` row; rows stamp `REDACTION_VERSION`.
- [ ] `search_vector` is a DB-`GENERATED` column with a working GIN index (used per EXPLAIN).
- [ ] Migration `0008` produced by `db:generate` (not hand-edited); applies cleanly.
- [ ] `npm run repo-health -- --require-db` passes with `search.int.test.ts` executed (0 skipped).
- [ ] Root `tsc -b` = 0 errors; no stray artifacts/NUL bytes; ingest path & fingerprint **untouched**.
- [ ] Deferrals named (incremental indexing; per-event granularity; semantic/vector V2).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task validation passed.
- [ ] `npm run typecheck` (root) = 0 errors.
- [ ] `npm run repo-health -- --require-db` green; int layer ran, 0 skipped.
- [ ] Manual curl checks (reindex, search, 401, secret-leak=0) pass.
- [ ] EXPLAIN confirms GIN index usage.
- [ ] `docs/guide/usage.md` updated; `SUMMARY.md`/PRD M12 12.1 ticked with deferrals named.
- [ ] Code reviewed (`/lril:code-review`) before commit.

---

## NOTES

### Spikes actually run during planning (evidence)
All run against the live archive (PG17, `docker compose` up on 5433) and `drizzle-kit` 0.31.10. Throwaway
artifacts deleted after.

1. **FTS SQL contract** — created a table with `search_vector tsvector GENERATED ALWAYS AS
   (setweight(to_tsvector('english',title),'A') || setweight(to_tsvector('english',body),'B')) STORED` + a
   GIN index; inserted rows; ran `websearch_to_tsquery` queries. Results:
   - plain terms (`anthropic spend`) → ranked hit (rank 0.3964);
   - phrase (`"config file"`) → correct single hit;
   - negation (`reading -nonexistentword`) → correct;
   - `EXPLAIN` → **`Bitmap Index Scan on …_gin`** (GIN index used).
2. **drizzle-kit generation** — ran `drizzle-kit generate` on an **isolated** throwaway schema
   (`customType` tsvector + `.generatedAlwaysAs(sql\`…\`)` + `.using("gin", t.searchVector)`). It emitted
   exactly: `"search_vector" "tsvector" GENERATED ALWAYS AS (…) STORED` and
   `CREATE INDEX … USING gin ("search_vector")` — **no hand-editing needed**; stays in the `db:generate`
   workflow.
3. **Generated SQL applies to live PG** — applied the drizzle-emitted SQL verbatim to PG17: table + GIN
   index created, insert + `ts_rank` query worked, dropped. The quoted `"tsvector"` type name is accepted.
4. **Harness/symbols verified by reading source** — `redact`/`redactJson`/`REDACTION_VERSION`
   (`redaction.ts`), `decryptField`/`EncryptedField` (`crypto.ts`), `sessionTranscript` decrypt loop
   (`transcript.ts`), `adminAuthorized`/`isUuid` (`auth.ts`), the `app.register` block (`app.ts` @64-79),
   the int-test harness + encrypted seeding via `ingestBatch` (`transcript.int.test.ts`).

### Design decisions (object on review if you disagree)
- **Materialized table + Postgres GENERATED tsvector**, not on-read FTS — PRD §21/§18.1 specify a "redacted
  plaintext projection"; FTS needs a stored GIN-indexed vector for the `@@` operator. The vector is
  DB-maintained, so it cannot drift from `title`/`body`.
- **Manual-first reindex** (`POST /v1/search/reindex`, full delete-then-rebuild) — mirrors the M10 pricing-
  catalog "manual trigger first" precedent and keeps the **hot ingest path untouched** (a core invariant).
  Incremental/at-ingest indexing is a **deferred refinement**.
- **Session-grained documents** for message/tool content (not per-event rows) — the session is the navigable
  unit; per-event rows would flood results. Session content is sourced from the session's `raw_source_records`
  (the raw lines contain all message/tool/file content), decrypted once per record and redacted. Per-event /
  per-tool-call granularity is **deferred**.
- **Uniform redaction before index** — every indexed string is `redact()`-ed (reports' markdown, project
  names/paths, session content), because search snippets are returned to the browser (they leave the archive,
  the §18 gate). `REDACTION_VERSION` is stamped per row (§23 replay-metadata consistency).

### Invariants preserved
- **No change** to `/v1/ingest`, the event fingerprint, the token/event shapes, or the encryption split.
- `search_documents` is a **disposable projection** (re-buildable from raw/reports/projects) — consistent
  with "raw sacred, projections disposable."
- Additive migration only (new table; no column added to `events`/`raw_source_records`).

### Deferred (name in the PR; do NOT build here)
- Incremental / at-ingest index maintenance (manual reindex only in 12.1).
- Per-event / per-tool-call result granularity (session-grained only).
- Advanced semantic / vector search (**V2**, PRD §21).
- Search UI (that's M12 Slice 12.2 — dashboard surfaces).

### Confidence: 9.5 / 10
Justification: the two highest-risk unknowns (does the FTS SQL contract work here; does drizzle-kit generate
the tsvector+GIN migration without hand-editing) were **both retired by spikes run during planning** —
emitted SQL applied to live PG17 and the GIN index is used per EXPLAIN. Every reused symbol/signature was
read from source, and the int-test seeding path (encrypted content via `ingestBatch`, key from `.env`) was
confirmed against `transcript.int.test.ts`. Residual 0.5: the exact M5 attribution join to resolve a
session's `projectId` during reindex (nullable — falls back to `null` cleanly if a session is unattributed,
so it cannot block the slice), and the barrel name-collision between the `searchDocuments` table and query fn
(resolved by keeping the table out of the barrel — confirm on implementation).
