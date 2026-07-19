# Feature: M14 Slice 14.4 — Per-event search granularity

> Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (redact-then-store gate, DB/Drizzle gotchas,
> validation gate incl. `--require-db`, frontend lanes) — this plan links, not re-pastes. Milestone
> definition + scope: [`m14-general-ai-chat-capture.md`](./m14-general-ai-chat-capture.md) (slice
> 14.4, from the 12.1 deferral).

## Feature Description

Today the admin search index is **session-grained**: one `search_documents` row per session whose
`body` is the session's raw records concatenated (capped 48 KB) and redacted. A hit points at a whole
session — you cannot see *which message or tool call* matched, and a term buried in one event is
indistinguishable from the session as a whole. 12.1 deferred finer granularity because "per-event rows
would flood results — the session is the navigable unit."

14.4 adds **per-message and per-tool-call** search rows **alongside** the session rows (hybrid), and
**groups results by session** in the UI so the added precision never floods. Row grain and hybrid-vs-
replace were settled with the user during planning (see Scope decisions).

### Scope decisions (settled with the user during planning)

- **Grain = per-message + per-tool-call only.** Event rows are emitted for exactly four event types —
  `message.user`, `message.assistant`, `tool.call.completed`, `tool.call.failed` — the units that
  carry searchable human text. Low-signal types (`file.read`, `context.loaded`, `usage.reported`,
  `cost.estimated`, `session.*`, `tool.call.started`) get NO row. This bounds the flood/size risk.
- **Hybrid, not replace.** The existing per-session rows STAY (broad "this session is about X" matches
  + the group header); event rows ADD drill-down precision. UI groups event hits under their session.
- **Text source = the `events.rawRecordId → raw_source_records` join** (the `transcript.ts` pattern),
  reusing the existing decrypt+redact path — NOT `events.payload_*` (which is NULL for `message.*`
  events, so it would miss message text). Each event row's `body` is its backing raw JSONL line,
  decrypted and `redact()`-ed. Known limitation (documented, acceptable): when two indexed events
  share one raw record line, both rows get that line's text — near-duplicate snippets, distinct
  fingerprints. For the four indexed types on JSONL connectors this is close to 1:1.
- **No fingerprint / redaction-version change.** `events.fingerprint` is reused as the row identity
  (invariant untouched); `REDACTION_VERSION` (`m8-redact-v1`) is unchanged — same redactor, same gate.

## User Story

As the self-hosting admin
I want search hits to pinpoint the specific message or tool call that matched, grouped under their
session
So that I can jump to the exact moment in a long session instead of re-reading the whole thing.

## Problem / Solution

**Problem:** session-grained hits are too coarse; the matching event is invisible and long sessions
are a haystack.

**Solution:** additive per-event indexing behind the SAME redact-then-store pipeline. A new nullable
`session_id` group-key column on `search_documents`; `SearchEntityType` gains `"event"`; a new
per-event indexer fans the four indexed event types into rows keyed on `events.fingerprint`; the
incremental (`indexSessions`) and full (`rebuildSearchIndex`) paths both emit them; the ingest route
+ query schema accept `type=event`; the dashboard groups hits by session. Caps bound index size and
reindex decrypt cost.

## Feature Metadata

**Feature Type**: Enhancement (DB + search pipeline + UI)
**Estimated Complexity**: Medium–High
**Primary Systems Affected**: `packages/db` (schema, migration, search repo), `packages/shared`
(search types), `apps/ingest` (search route + schema), `apps/dashboard` (search UI)
**Dependencies**: none new
**Touches `@420ai/db` + `apps/ingest`** → the `*.int.test.ts` layer MUST run for sign-off
(`repo-health -- --require-db`).

---

## CONTEXT REFERENCES — READ BEFORE IMPLEMENTING

- `packages/db/src/repositories/search.ts` (WHOLE FILE) — the pipeline to extend. Key symbols:
  `DocInput` (`:58-65`, add `sessionId`), `upsertDoc` (`:73-96`, upserts on `(entityType, entityId)`
  — target UNCHANGED since event `entityId`=fingerprint is globally unique), `indexOneSession`
  (`:151-193`, the session row + its projectId attribution join), `indexSessions` (`:209-231`,
  incremental, returns count — **return type changes**), `rebuildSearchIndex` (`:292-349`, session loop
  at `:338-345` already routes through `indexSessions` → events come for free), `searchDocuments`
  (`:359-405`, add `sessionId` to select + hit map; `type` filter already generic).
- `packages/db/src/repositories/transcript.ts:83-89` — the EXACT `events ⋈ raw_source_records` join to
  mirror for per-event text: `innerJoin(rawSourceRecords, and(eq(rawSourceRecords.sourceRecordId,
  events.rawRecordId), eq(rawSourceRecords.sessionId, events.sessionId)))`. Decrypt via `decryptField`
  (`crypto.js`), then `redact()`.
- `packages/db/src/schema.ts:543-568` — `searchDocuments` table. Add `sessionId: text("session_id")`
  (nullable) + `index("search_documents_by_session").on(t.sessionId)`. `search_vector` is
  `generatedAlwaysAs` — NEVER written. Events table `:132-168` (PK `fingerprint`, `events_by_session`
  on `(sessionId, ts)`, `eventType` free text). Raw records `:105-130`.
- `packages/shared/src/search.ts` (WHOLE FILE) — `SearchEntityType` (`:14`, add `"event"`), `SearchHit`
  (`:17-28`, add `sessionId: string | null`), `ReindexCounts` (`:37-42`, add `events: number`).
- `packages/shared/src/events.ts:26-39` — the `EventType` union (the four indexed types are members).
- `apps/ingest/src/routes/search.ts:20-43` — GET `/v1/search` (querystring type includes the union;
  passes `type` through) + POST `/v1/search/reindex` (`:45-50`, returns `ReindexCounts`).
- `apps/ingest/src/schemas.ts:436-447` — `searchQuerySchema`; add `"event"` to `type.enum` (`:442`).
- `apps/dashboard/src/components/search/search-view.tsx` — the flat hit list (`:224-251`) to group by
  session; the type `<select>` (`:170-180`, add "Events"); `SEARCH_PAGE=20` paging + dedup on
  `${entityType}:${entityId}`. `apps/dashboard/src/lib/snippet.ts` `HighlightedSnippet` — reuse as-is.
- `packages/db/src/repositories/search.int.test.ts` (WHOLE FILE) — the harness to extend: `ingestBatch`
  seeds events+raw records; `rebuildSearchIndex`; `searchDocuments`. Note the `total ===
  reports+projects+sessions` assertions (`:102`, `:147`) — must add `events`.
- `apps/ingest/src/search.int.test.ts` — the route-level int test (HTTP `type=event` case).
- Migration workflow: edit `schema.ts` → `npm run db:generate` (drizzle-kit) writes `0013_*.sql`;
  hand-write the matching `packages/db/drizzle/down/0013_*.down.sql` (convention: see
  `drizzle/down/0008_violet_wraith.down.sql`).

### Patterns to Follow

- **Redact-then-store gate (§18/§23)** — EVERY string written to `search_documents` passes
  `redact(...).redacted` first (see `search.ts:184-192`). Event bodies are no exception. `REDACTION_VERSION`
  stamped on every row (unchanged).
- **DB gotchas (`CLAUDE.md`)** — the per-event query uses no new aggregates over `mode:"string"`
  timestamps (order by `events.ts` is fine; we don't select a `max/min(ts)` here). If you add any
  aggregate, ISO-normalize + `Number()` per the gotcha. Closed-set SQL keywords stay literal.
  `ts_headline`/`ts_rank`/`websearch_to_tsquery` regconfig `'english'` remains a constant literal, never
  a bound param (`search.ts:355-357`).
- **Silent library** — `decryptField` throws loudly on a tag/key error; let it propagate (no logging).
  Incremental indexing stays best-effort at the CALLER (`ingest.ts:27-34` already try/catch-warns).
- **Bounded work** — mirror `SESSION_BODY_MAX_CHARS`: cap per-event body chars and events-per-session
  (see Task 3) so per-event indexing can't unbound the index or the reindex decrypt loop.

---

## STEP-BY-STEP TASKS (in order)

### 1. UPDATE `packages/shared/src/search.ts` — widen types

- **IMPLEMENT**: `SearchEntityType = "session" | "report" | "project" | "event"`. Add `sessionId:
  string | null` to `SearchHit` (doc: "grouping key — the event's/session's sessionId; null for
  report/project"). Add `events: number` to `ReindexCounts`.
- **VALIDATE**: `npm run typecheck` (root graph includes shared; will now flag every downstream
  consumer that must be updated — expected until Tasks 2–5 land).

### 2. UPDATE `packages/db/src/schema.ts` + GENERATE migration

- **IMPLEMENT**: on `searchDocuments`, add `sessionId: text("session_id")` (nullable — existing rows
  backfill NULL safely) after `projectId`. Add `index("search_documents_by_session").on(t.sessionId)`
  to the index list. Do NOT touch `search_vector`.
- **GENERATE**: `npm run db:generate` → produces `packages/db/drizzle/0013_*.sql`. Inspect it: it must
  be exactly `ALTER TABLE "search_documents" ADD COLUMN "session_id" text;` + the new index. Then
  hand-write `packages/db/drizzle/down/0013_*.down.sql` (drop index + drop column) mirroring
  `down/0008_*.down.sql`.
- **GOTCHA**: drizzle-kit may prompt if it can't infer — the change is a pure add, so it should be
  non-interactive; if it asks anything, abort and re-inspect the schema diff (do NOT accept a rename).
- **VALIDATE**: `npm run db:migrate` against dev DB, then `npm run db:migrate` targeting the TEST DB
  (`420ai_test`) — per memory, `db:migrate` does NOT migrate the test DB; migrate it explicitly so the
  int tests see `session_id` (else they fail on an unknown column). Confirm the column exists.

### 3. ADD per-event indexer to `packages/db/src/repositories/search.ts`

- **IMPLEMENT**:
  - Add `sessionId: string | null` to `DocInput`; thread it through `upsertDoc` (`.values` +
    `onConflictDoUpdate.set`). Existing callers (`reportDoc`/`projectDoc`/session) pass `sessionId:
    null` except the session row which passes its own `sessionId` (so a session hit also carries its
    group key). The `onConflictDoUpdate.target` STAYS `(entityType, entityId)`.
  - Constants: `const EVENT_BODY_MAX_CHARS = 4000;` (mirrors `DEFAULT_TRANSCRIPT_CAPS.maxCharsPerRecord`)
    and `const MAX_EVENT_DOCS_PER_SESSION = 500;` (mirrors `maxRecords`) — bound size + decrypt cost.
  - `const INDEXED_EVENT_TYPES = ["message.user", "message.assistant", "tool.call.completed",
    "tool.call.failed"] as const;`
  - New `async function indexSessionEvents(db, s: SessionMetaRow, projectId: string | null):
    Promise<number>`: select the session's events of `INDEXED_EVENT_TYPES` joined to
    `rawSourceRecords` (the transcript.ts join), `orderBy(asc(events.ts))`, `limit(MAX_EVENT_DOCS_PER_
    SESSION)`, selecting `fingerprint`, `ciphertext/iv/tag`. For each: `decryptField` → slice to
    `EVENT_BODY_MAX_CHARS` → `upsertDoc({ userId: s.userId, entityType: "event", entityId:
    row.fingerprint, projectId, sessionId: s.sessionId, title: null, body: redact(plaintext).redacted
    })`. Return the count upserted.
  - Wire into `indexOneSession`: it already computes `projectId` (`:160`) and upserts the session row
    (pass `sessionId: s.sessionId` now). After the session upsert, `return indexSessionEvents(db, s,
    projectId)` — but `indexOneSession` currently returns `void`. Change it to return the event count,
    OR keep it void and call `indexSessionEvents` inside, accumulating via the caller. **Cleanest**:
    make `indexOneSession` return `number` (events upserted) and have `indexSessions` sum them.
  - Change `indexSessions` return type from `Promise<number>` to `Promise<{ sessions: number; events:
    number }>`: `sessions` = distinct session docs, `events` = summed event docs. Update its loop to
    accumulate both.
  - Update `rebuildSearchIndex`: destructure `const { sessions, events } = await indexSessions(tx,
    ...)` and return `{ reports, projects: projectCount, sessions, events, total: reports +
    projectCount + sessions + events }`.
  - Update `searchDocuments`: add `sessionId: searchDocumentsTbl.sessionId` to the `.select`, and
    `sessionId: r.sessionId` to the hit map.
- **GOTCHA — the OTHER `indexSessions` caller**: `apps/ingest/src/routes/ingest.ts:29` calls
  `await indexSessions(app.db, touched)` and IGNORES the return — the object return is
  backward-compatible there (no code change needed), but VERIFY it still compiles (Task 5 covers ingest
  typecheck). Do NOT change its best-effort try/catch.
- **VALIDATE**: `npm run typecheck` (exit 0 for the four backend workspaces).

### 4. UPDATE `apps/ingest/src/schemas.ts` — accept `type=event`

- **IMPLEMENT**: add `"event"` to `searchQuerySchema.properties.type.enum` (`:442`). Update the
  doc-comment enum list (`:435`). No route logic changes (`search.ts:32` passes `type` through; the
  `SearchEntityType` union already widened in Task 1 covers the handler's `Querystring` type).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 5. UPDATE `apps/dashboard/src/components/search/search-view.tsx` — group by session

- **IMPLEMENT**: after fetching `hits`, group for render: build an ordered list of groups keyed by
  `sessionId` for `entityType === "event"` and by `entityId` for `entityType === "session"`; `report`
  and `project` hits render as standalone (ungrouped) items, preserving overall rank order of each
  group's best hit. Within a session group: show the session hit (if present) as the header/first row
  (its `title` = `sourceConnector · sessionId`), then its event hits nested (indented), each with an
  "event" Badge + `HighlightedSnippet`. When only event hits exist for a session (no session hit),
  synthesize the header from the group's `sessionId`. Add an `<option value="event">Events</option>` to
  the type `<select>` (`:170-180`). Keep the existing dedup key `${entityType}:${entityId}` (fingerprints
  are unique so event hits dedup correctly) and the "Load more" offset paging.
- **GOTCHA**: keep it XSS-safe — render snippets ONLY via `HighlightedSnippet`/`splitSnippet`
  (`lib/snippet.ts`), never `dangerouslySetInnerHTML`. Grouping is a pure client-side reshape of the
  already-ranked `hits`; do NOT re-sort in a way that breaks offset pagination determinism (append new
  pages into existing groups).
- **VALIDATE**: `npm run typecheck:dashboard` AND `npm run build:dashboard` (each exit 0).

### 6. EXTEND integration tests

- **`packages/db/src/repositories/search.int.test.ts`**:
  - Extend `makeBatch()` (or add a second batch) to include a `message.assistant` and a
    `tool.call.completed` event with their own raw records carrying distinctive phrases (e.g. a
    `TOOL_PHRASE`), each with a unique `fingerprint`.
  - Add `events` to the counts assertions: `total === reports + projects + sessions + events`, and
    `counts.events >= 1` (`:97-103`, `:141-148`). Update the idempotency `total` check.
  - New test: after `rebuildSearchIndex`, `searchDocuments({ q: <phrase in one message>, type: "event"
    })` returns ≥1 hit with `entityType === "event"`, `sessionId === "s1"`, `entityId === <that
    event's fingerprint>`, `rank > 0`. Assert the SECRET never appears in an event hit or the stored
    event row (`entityType = "event"` body contains `[REDACTED:`), proving the gate holds per-event.
    New test (hybrid): a phrase present in a message returns BOTH a `session` hit and an `event` hit
    for `s1`.
- **`apps/ingest/src/search.int.test.ts`**: add an HTTP case: `GET /v1/search?q=<phrase>&type=event`
  → 200 with event hits; `?type=bogus` → 400 (schema enum rejects it).
- **VALIDATE**: `npm run repo-health -- --require-db` (see Validation).

### 7. UPDATE the milestone doc

- **IMPLEMENT**: in `.agents/plans/m14-general-ai-chat-capture.md` (14.4 bullet, `:82-84`), record the
  settled grain (message + tool-call), hybrid model, and text source (raw-record join).
- **VALIDATE**: `npx prettier --check .agents/plans/m14-general-ai-chat-capture.md`

---

## TESTING STRATEGY

### Integration (the load-bearing layer — DB-backed)

Extend both `search.int.test.ts` files (Task 6). These prove: per-event rows are created for the four
types only; the redact gate holds per-event (secret never leaks); hybrid returns both session and
event hits; `type=event` filters correctly; counts include `events` and `total` sums right; idempotent
re-index yields stable counts (the `(entity_type, entity_id)` unique index holds with fingerprint
entity ids). These CANNOT self-skip for sign-off — run with `--require-db`.

### Unit

The pure redaction is already covered (`redaction.test.ts`). No new pure helper is extracted (the
indexer is DB-bound → integration is the right layer). The UI grouping is a pure reshape; if a reviewer
wants a unit, extract `groupHitsBySession(hits): Group[]` into a tiny pure module beside `snippet.ts`
and test it (optional).

### Edge cases to cover

- A session whose matching term sits beyond the 48 KB session cap → only the event row matches → UI
  still groups it (synthesized header).
- `tool.call.completed` event with a NULL raw-record join (defensive) → skipped, not a crash.
- `MAX_EVENT_DOCS_PER_SESSION` cap honored (a session with > 500 indexed events indexes 500).

---

## VALIDATION COMMANDS (GATES — from repo root)

1. **Level 1 — root typecheck**: `npm run typecheck` (exit 0). Covers shared+db+ingest (the type
   ripple from Task 1). Dashboard is out of this graph.
2. **Level 1b — frontend lanes**: `npm run typecheck:dashboard` AND `npm run build:dashboard` (exit 0).
3. **Level 2 — unit**: `npm test` (all pass; int layer self-skips without `DATABASE_URL_TEST` — that's
   Level 3's job).
4. **Level 3 — DB gate (REQUIRED for this slice — it touches `@420ai/db` + `apps/ingest`)**:
   `npm run db:up && npm run db:migrate` (dev DB), migrate the **test DB** (`420ai_test`) explicitly
   (per memory — `db:migrate` doesn't), then `npm run repo-health -- --require-db`. This FAILS if any
   `*.int.test.ts` self-skipped — it must show the search int tests RAN (0 skipped) and passed.
5. **Lint + format** (CI-only, per memory): `npm run lint` and `npx prettier --check` on changed files.
6. **Level 4 — manual**: with a live stack + a seeded session containing a distinctive message,
   `/search` for that phrase shows the session with the matching message nested under it; the type
   filter "Events" narrows to event hits; `grep -c "$ADMIN_TOKEN"` on the served page == 0; a known
   secret in a message never appears in any snippet.

---

## ACCEPTANCE CRITERIA

- [ ] `search_documents` has a nullable `session_id` column + `search_documents_by_session` index
      (migration `0013` up + down); existing rows unaffected.
- [ ] Event rows exist for exactly `message.user/message.assistant/tool.call.completed/tool.call.failed`,
      keyed on `events.fingerprint`, `entityType="event"`, `sessionId` set, body redacted + capped.
- [ ] Session rows still exist (hybrid); a term in a message returns BOTH a session and an event hit.
- [ ] `GET /v1/search?type=event` filters to event hits; `type` enum rejects unknown values (400).
- [ ] UI groups hits by session with events nested; snippets rendered XSS-safe; paging still works.
- [ ] Redact gate holds per-event (a seeded secret never leaks into a hit or a stored event row);
      `REDACTION_VERSION` unchanged; `events.fingerprint` invariant untouched.
- [ ] `ReindexCounts` includes `events`; `total = reports+projects+sessions+events`; reindex idempotent.
- [ ] Bounded: `EVENT_BODY_MAX_CHARS` + `MAX_EVENT_DOCS_PER_SESSION` caps applied.
- [ ] `repo-health -- --require-db` PASSES with the search int tests RUN (0 skipped), plus lint +
      prettier + dashboard build.

## NOTES

- **Spikes run during planning (evidence):**
  - Read the ENTIRE `search.ts` repo — confirmed `upsertDoc` upserts on `(entityType, entityId)` (so
    fingerprint-keyed event rows need NO index widening), `indexOneSession` already computes `projectId`
    + upserts the session row, `rebuildSearchIndex` routes sessions through `indexSessions` (events come
    free on rebuild), and `searchDocuments`'s `type` filter is generic (`eq(entityType, opts.type)`).
  - Read `search.int.test.ts` — confirmed the `ingestBatch → rebuildSearchIndex → searchDocuments`
    harness, the `TRUNCATE ... RESTART IDENTITY CASCADE` reset, and the exact `total` assertions that
    must gain `events`. Confirmed the redact-gate test pattern (`body` contains `[REDACTED:`, never the
    secret) to mirror per-event.
  - Verified `searchQuerySchema` (`schemas.ts:436-447`) enum is the only place `type` is constrained;
    the route (`search.ts:20-43`) passes `type` straight through, so `SearchEntityType` widening + the
    enum line are the whole ingest change.
  - Verified `ReindexCounts` consumers: only `search.ts` (repo) + the reindex route (passes it through)
    — adding `events` is safe/additive.
  - Verified the migration workflow: `db:generate` (drizzle-kit) autogenerates the up SQL from the
    schema diff; the `drizzle/down/*.down.sql` convention is hand-maintained (`0008` precedent). The
    change is a pure additive nullable column → safe on existing rows, non-interactive generate.
  - Confirmed the per-event text source: `events.payload_*` is NULL for `message.*` (recon of
    `transcript.ts:12-17`), so message text MUST come from the raw-record join — hence the join, not the
    payload, is the body source. `decryptField` + `redact()` reused verbatim.
- **Index-size / reindex-cost mitigation** (the doc's stated risk): grain limited to 4 types; per-body
  and per-session caps; upsert-only (append-only events → no delete churn); incremental path stays
  best-effort + capped. The hybrid ~doubles session-related rows but the caps keep growth bounded and
  predictable. If real-world size proves heavy, a follow-up can drop the session concatenation rows
  (the "replace" variant) without a schema change.
- **Known limitation (accepted):** events sharing one raw-record line get near-duplicate bodies
  (distinct fingerprints). Documented; acceptable for the 4 indexed types on JSONL connectors.
- **Confidence: 9.4/10** — every symbol/signature verified at source; the extension mirrors the exact
  in-repo redact-then-store pipeline and int-test harness; blast radius is additive (new nullable
  column, new union member, new indexer fn, two caller updates). Residual risk: (a) the UI grouping
  refactor (caught by `build:dashboard`), (b) drizzle-generate output (inspected before migrate), (c)
  reindex-cost tuning (a perf, not correctness, concern — caps in place). The DB-gate (`--require-db`)
  retires the correctness risk by running the per-event int tests against a real Postgres.
