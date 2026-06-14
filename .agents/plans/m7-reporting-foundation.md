# Feature: Milestone 7 — Reporting Foundation (deterministic Markdown report artifacts)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Pay special attention to naming of
existing utils, types, and models — import from the right files (`@420ai/shared`, `@420ai/db`, `.js`
relative specifiers, `import type` for type-only imports). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **Branch:** all M7 work lands on `m7` (already created off `m6-event-projections`/HEAD `54c060a`). M6 is
> committed but **not yet merged to `main`**, so M7 stacks on it — intentional (M7 renders the M6
> projections into report artifacts).

> **Scope decisions confirmed with the user during planning** (these bound the milestone — honor them):
> 1. **Two anchor report types only** — `project.cost_over_time` and `session.autopsy` (metrics-only).
>    Thread BOTH through the full generate→render→store→version pipeline. The other five PRD §15 types
>    (tool/model comparison, failed-tool-call, context-waste, project-efficiency, trend-anomalies) are a
>    fast follow once the rails exist — **do NOT build them in M7.**
> 2. **Storage = a new `report_artifacts` table (migration); NO `report.generated` event.** The artifact
>    row IS the record. Do **not** emit a `report.generated` event into the event log — the
>    connector-shaped fingerprint (`source + raw_record + index + type`, PRD §12) does not fit a
>    server-generated report, and forcing it adds complexity for no V1 value. (`report.generated` stays in
>    the PRD §12 taxonomy for a later milestone.)
> 3. **Versioned storage, comparison DEFERRED.** Re-generating a report for the same `(type, scope)` keeps
>    prior artifacts and bumps an integer `version`. Add list/history + fetch-by-id endpoints. Do **NOT**
>    build the diff/comparison endpoint or comparison-Markdown rendering — that defers to when a dashboard
>    exists to show it (PRD §15 "comparison against prior report artifacts" is acknowledged-but-deferred).

> **Plaintext-only, never decrypts (inherited M6 invariant — PRD §18.1).** Every M7 report is rendered
> exclusively from the M6 deterministic projections, which read only the **plaintext-queryable** event
> columns (`ts`/`event_type`/`model`/`tokens`/`cost`/`project_path`/`git_branch`/`source_connector`/
> `session_id`/`parser_version`). M7 **never** reads `payload_ciphertext` and **never** calls
> `decryptField`. The stored report Markdown therefore contains no message bodies, tool I/O, file
> contents, or secrets — only counts, tokens, cost, model names, project paths, and timestamps — so it is
> stored **plaintext**, consistent with the §18.1 split and the §21 "searchable plaintext projection"
> intent. **The content-rich "session autopsy" that quotes prompts/outputs (encrypted) is an M8 concern**
> (it needs the redaction path); M7's autopsy is the *metrics* autopsy only.

---

## Feature Description

M6 built the **deterministic projection layer** — read-only SQL aggregations over the event log
(`usageTotals`, `usageByModel`, `usageOverTime`, `sessionProjections`, `sessionDetail`,
`connectorHealth`, `projectGitMetadata`) exposed as admin-gated JSON endpoints. Those projections are
*ephemeral query results*: there is no way to **generate a durable, versioned, human-readable report**
and keep it.

M7 is the **Reporting Foundation** (PRD §15, §16.1, §23, SUMMARY milestone 7). It turns the M6 projection
JSON into **durable Markdown report artifacts with Mermaid diagrams**, stored in a new `report_artifacts`
table, **versioned** so regenerating retains history (the PRD §23 replay/versioning story), and
retrievable by id or as a history list. It introduces:

1. **Pure Markdown renderers** in `@420ai/shared` (dependency-free, clock-injected — the same "pure
   function returns a string" shape as the M1 `renderSessionReport`) for the two anchor report types:
   - **`project.cost_over_time`** — headline token/cost totals + a per-model breakdown + a per-day/week
     time series, rendered as Markdown tables plus Mermaid diagrams. Source: M6 `usageTotals` +
     `usageByModel` + `usageOverTime`.
   - **`session.autopsy`** (metrics-only) — one session's shape: time range/duration, message/tool/file
     counts, tool-call failures, models, token composition, cost + confidence. Source: M6 `sessionDetail`.
2. **A `report_artifacts` table + migration** (the first migration since M5) storing the rendered
   Markdown, a JSON snapshot of the metrics it was rendered from (`metrics`, for future replay/compare
   without re-querying), generation params, the renderer `report_version`, scope, and an incrementing
   `version`.
3. **A small generation orchestrator** (`apps/ingest`) that composes M6 projections + the shared renderer
   + the store, plus **admin-gated endpoints** to generate (`POST`), fetch (`GET /v1/reports/:id`), and
   list history (`GET /v1/reports`), mirroring the M5/M6 route patterns exactly.

This implements PRD §15 (Markdown-first, Mermaid, versioned report artifacts, manual-first generation),
§16.1 (the deterministic-metrics report that precedes AI interpretation — M8), and §23 (track
report/analysis version; artifacts are versioned and retained). It is the substrate M8 (AI
interpretation: feed a redacted report bundle to a provider) and a later dashboard render on top of.

### Why this is a low-medium-risk milestone

M7 is **mostly additive and composes proven layers**: the data layer (M6 projections) is built, tested,
and reused as-is; the renderer is pure string-building already proven by M1's `renderSessionReport`; the
new table + migration + CRUD + admin route are the exact shape M2/M5 already shipped (`projects`,
`workspaces`, `workspace_keys` + their migrations + `repositories/projects.ts` + `routes/projects.ts`).
The one thing M6 deliberately avoided — **a migration** — returns here, but it is well-trodden
(`npm run db:generate` → review the emitted SQL → `npm run db:migrate`). M7 does **NOT** touch the event
fingerprint, the M2 wire types/ingest path, the AES-GCM encryption split, any connector `parse`, or the
M6 projection SQL.

### Explicitly deferred — do NOT build in M7

- **The other five PRD §15 report types** (tool/model comparison, failed-tool-call, context-waste,
  project-efficiency, trend-anomalies). Scope Decision 1.
- **`report.generated` event emission** into the event log. Scope Decision 2.
- **Report comparison / diff endpoint / comparison-Markdown.** Scope Decision 3. (The stored `metrics`
  JSON snapshot is the seam that makes a future compare cheap — store it, don't diff it yet.)
- **AI interpretation / redacted report bundles** (M8). M7 is deterministic metrics rendered to Markdown
  — no AI provider call, no redaction pipeline.
- **Decryption of any event payload.** M7 renders from plaintext projections only (see the plaintext
  banner above). A content-bearing autopsy quoting prompts/tool output is M8.
- **Archive export (Markdown/JSON/JSONL/CSV bundles, PRD §22)** — that is M10. M7 produces *report
  artifacts* (and a raw-Markdown fetch is fine), not the scoped multi-format archive export.
- **A dashboard / web UI** to render or compare reports (its own later milestone — headless, like M5/M6).
- **Scheduled report generation** (PRD §15 "scheduled reports are opt-in") — M7 is manual-first only
  (generation is an admin `POST`). No cron, no settings.
- **Context-waste/efficiency metrics** that need file-hygiene analysis or historical baselines not yet
  built.

## User Story

As an AI-heavy developer whose Claude Code / Codex / Gemini sessions are captured, attributed to
projects, and aggregated by the M6 projection layer,
I want to generate and keep durable, versioned **Markdown reports** — a project's cost-over-time and a
single session's autopsy — with charts, directly from the deterministic metrics,
So that I have a shareable, comparable, point-in-time artifact of what a project cost and how a session
behaved (and a foundation the AI-interpretation milestone can build on), without re-running ad-hoc
queries or hand-writing Markdown.

## Problem Statement

After M6 the archive can *compute* metrics on demand but cannot *produce a report*. There is nowhere to
persist a rendered, human-readable, versioned artifact; no Markdown/Mermaid rendering of the projection
JSON; no history so "what did this project cost last month vs. this month" can ever be answered from
stored artifacts; and no `report.generated`/report-storage surface that PRD §15/§23 require and that M8
(AI interpretation over a report bundle) depends on. The M1 `renderSessionReport` exists but is
collector-side, takes raw `NormalizedEvent[]` (not projections), and writes nothing durable.

## Solution Statement

Add **pure Markdown renderers** to `@420ai/shared` (`reports.ts`) that turn the M6 projection result
shapes into Markdown-with-Mermaid strings — clock-injected and dependency-free, mirroring
`renderSessionReport`'s "pure function → string" contract. Add a **`report_artifacts` table** (+ the
M7 migration) and a **`repositories/reports.ts`** CRUD module (insert-with-version-bump, get, list) in
`@420ai/db`, mirroring `repositories/projects.ts`. Add a **generation orchestrator**
(`apps/ingest/src/reports/generate-report.ts`) that reads M6 projections, calls the shared renderer,
snapshots the metrics, and stores the artifact — and **admin-gated routes** (`routes/reports.ts`) to
generate / fetch / list, mirroring `routes/projects.ts` + `routes/projections.ts` verbatim (admin gate
→ 401, `isUuid` → 404, single-user `userId` via `findUserIdByEmail`/`ensureUserByEmail`). No
fingerprint/wire/encryption/parse change; no collector change; one additive migration.

## Feature Metadata

**Feature Type**: New Capability (durable, versioned Markdown reporting layer over the M6 projections).
**Estimated Complexity**: **Low-Medium.** Lower than M5 (which added 3 tables + a novel reverse-map + a
new machine-authed write surface); a touch above M6 (M6 was read-only with no migration — M7 adds one
table + one migration + a render layer + an admin write path). No new external dependency; the data layer
and the render pattern both already exist and are reused.
**Primary Systems Affected**: `packages/shared` (new `reports.ts` renderers + `ReportType`/input types +
barrel), `packages/db` (1 new table in `schema.ts` + 1 generated migration + `repositories/reports.ts` +
its int test + barrel), `apps/ingest` (1 generation orchestrator + 1 new route file + registration +
report body schemas + int-test additions). **No collector change. No fingerprint/wire/encryption/parse
change. One additive migration (CREATE TABLE only).**
**Dependencies**: none new. `drizzle-orm` + `drizzle-kit` (already used — `db:generate`/`db:migrate`),
Fastify (present), the frozen `@420ai/shared` token/cost arithmetic + the M6 projection repo (present).
Node ≥ 24.

---

## PRE-FLIGHT VERIFICATION (grounded against the M6 codebase this session)

The novel risk in M7 is "add a durable, versioned artifact table + a Markdown renderer over the existing
projections, behind the proven admin-route pattern." Every structural half is **[VERIFIED] in the
codebase**; the only genuinely new mechanic is the migration, which is the M7 analog of M6's spike (see
"Migration verification" below).

1. **The data the renderers consume already exists, is typed, and is tested — [VERIFIED].**
   `packages/db/src/repositories/projections.ts` exports `usageTotals` / `usageByModel` / `usageOverTime`
   / `sessionDetail` (M6), returning the `@420ai/shared` result shapes `UsageTotals` / `UsageByModelRow[]`
   / `UsageOverTimeRow[]` / `SessionDetail` (`packages/shared/src/projections.ts:16-76`). M7 renderers
   take exactly these shapes — no new query. Re-export confirmed in `packages/db/src/index.ts:43-51`.
2. **A pure Markdown+Mermaid renderer is proven — [VERIFIED].**
   `apps/collector/src/report/session-report.ts:18-95` (`renderSessionReport`) builds a Markdown string
   with a header bullet list, a token table, a cost section, and a ```` ```mermaid pie showData ```` block
   — pure, returns a string, writes nothing. M7's renderers are this exact shape but keyed off projection
   inputs instead of `NormalizedEvent[]`, and clock-injected (take `generatedAt`). Reuse the `pie
   showData` idiom (it is the proven-rendering Mermaid type).
3. **The cost formatting + confidence vocabulary to reuse is frozen — [VERIFIED].**
   `fmtUsd` (6-decimal, `session-report.ts:9-12`) is the format to mirror; `CostConfidence` +
   `lowestConfidence` + `CONFIDENCE_ORDER` live in `packages/shared/src/cost.ts` (promoted in M6) and
   `NormalizedTokens` in `tokens.ts`. M7 renders the already-computed `costConfidence`/`costUsd`/`tokens`
   from the projection — it does NOT recompute them.
4. **A table + migration + CRUD repo + admin route is proven end-to-end — [VERIFIED].**
   `packages/db/src/schema.ts:144-210` defines `projects`/`workspaces`/`workspace_keys` (uuid pk
   `defaultRandom()`, `userId` FK → `users.id`, `timestamp({withTimezone:true})`, `index`/`uniqueIndex`
   in the `(t) => [...]` callback). `packages/db/drizzle/0001_*.sql` is the M5 migration these produced
   via `db:generate`. `repositories/projects.ts` is the CRUD style (typed `Row` interface, `insert
   ...returning`, `eq`/`and`/`desc`, silent/throwing). `routes/projects.ts` + `routes/projections.ts` are
   the admin-gated route style (`adminAuthorized`→401, `isUuid`→404, `findUserIdByEmail`/
   `ensureUserByEmail` for the single-user id). M7 clones all four.
5. **The write/transaction style is proven — [VERIFIED].** `repositories/ingest.ts:22-90` shows
   `db.transaction(async (tx) => …)` and `insert(...).values(...).returning(...)`. M7's
   `insertReportArtifact` uses a transaction only to compute `version = max(version)+1` for the
   `(user, type, scope)` series and insert atomically (single-user → low contention; the unique index is
   the backstop).
6. **The int-test harness is proven — [VERIFIED].** `apps/ingest/src/app.int.test.ts`
   (`describe.skipIf(!process.env.DATABASE_URL_TEST)`) builds the app in-process (`buildApp`),
   `TRUNCATE … RESTART IDENTITY CASCADE` per test, pairs a machine, ingests events, drives
   discover→attribute→summary, and asserts endpoint numbers. M7 extends it: ingest events →
   `GET /v1/projects` for the id → `POST` a report → assert the artifact's Markdown/version → regenerate →
   assert version bumped. **The `TRUNCATE` list MUST add `report_artifacts`** (M7 adds a table — unlike
   M6). `packages/db/src/repositories/workspaces.int.test.ts` is the db-repo int-test template.
7. **`*.int.test.ts` are excluded from `tsc -b` and self-skip without `DATABASE_URL_TEST` — [VERIFIED].**
   (`packages/db/tsconfig.json` / `apps/ingest/tsconfig.json` exclude them; CLAUDE.md Testing.) The new
   `reports.int.test.ts` follows suit.

**Residual risk (retire with the migration verification below, not a throwaway spike):** the only new
mechanic is the **migration**. M6 deliberately had none; M7 reintroduces one. The risk is purely "did
`db:generate` emit exactly the intended `CREATE TABLE report_artifacts` (+ its indexes) and touch nothing
else." This is deterministic drizzle-kit (proven by M2's `0000` and M5's `0001`), retired by generating
and **reading** the SQL before applying it (Task 5), and pinned by the int tests.

### Migration verification (the M7 analog of M6's spike — do this in Task 5, before relying on the table)

After adding the `reportArtifacts` table to `schema.ts`, run `npm run db:generate` and **open the emitted
`packages/db/drizzle/0002_*.sql`**. Confirm it is **only** `CREATE TABLE "report_artifacts" (...)` plus
its `CREATE INDEX`/`CREATE UNIQUE INDEX` statements and the FK to `users`/`projects` — and that it does
**NOT** `ALTER`/`DROP` `events`, `raw_source_records`, `workspaces`, `workspace_keys`, or `projects`
(those would mean an accidental schema edit — revert it). Then `npm run db:migrate` against the test DB
and confirm it applies cleanly. Lock the column set from what the SQL shows before writing the repo/tests.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/collector/src/report/session-report.ts` (whole file, 1-95) — Why: the **rendering template**.
  Mirror the pure-function-returns-string shape, the header bullet list, the `| input | output | … |`
  token table, the cost section, `fmtUsd`, and the ```` ```mermaid pie showData ```` block. M7's
  renderers differ ONLY in taking projection shapes (not `NormalizedEvent[]`) and a `generatedAt` param.
  **Do NOT modify this file** (it is the collector's M1 CLI report; M7 adds *new* server-side renderers).
- `packages/shared/src/projections.ts` (whole file, 1-76) — Why: the **exact input shapes** M7 renders:
  `UsageTotals`, `UsageByModelRow`, `UsageOverTimeRow`, `SessionDetail`/`SessionProjection`,
  `NormalizedTokens` fields. The renderer signatures consume these verbatim.
- `packages/db/src/repositories/projections.ts` (whole file) — Why: the M6 functions the generation
  orchestrator calls (`usageTotals`/`usageByModel`/`usageOverTime`/`sessionDetail`). Note `usageOverTime`
  takes `bucket: "day"|"week"` and returns ISO `bucket` strings; `sessionDetail` returns a **zeroed**
  projection for an unknown id (not an error) — the autopsy generator must handle the all-zero case.
- `packages/db/src/schema.ts` (esp. `projects` 144-157, `workspaces` 164-183, `workspaceKeys` 192-210;
  header 13-28) — Why: the **table-definition pattern** M7's `reportArtifacts` mirrors exactly (uuid pk
  `defaultRandom()`, `userId`/`projectId` FK columns, `text`/`jsonb`/`integer`/`timestamp({withTimezone:
  true})`, the `(t) => [index(...), uniqueIndex(...)]` index callback). Read the encryption-split header —
  report Markdown is derived plaintext metrics, stored plaintext (no `payload_*` columns).
- `packages/db/drizzle/0001_naive_dreaming_celestial.sql` + `packages/db/drizzle/meta/_journal.json` —
  Why: what a generated migration looks like and how the journal tracks them. M7's `0002_*` is the next
  entry. **Do not hand-edit** — generate it.
- `packages/db/drizzle.config.ts` — Why: confirms `db:generate` reads `schema.ts` and writes to
  `packages/db/drizzle/`. (Read it to know where the migration lands.)
- `packages/db/src/repositories/projects.ts` (whole file) — Why: the CRUD repo style M7's
  `repositories/reports.ts` mirrors — typed `Row` interface, `insert(...).values(...).returning(...)`,
  `select().from().where(eq/and)`, `desc` ordering, silent/throwing (never logs).
- `packages/db/src/repositories/ingest.ts` (22-90) — Why: the `db.transaction(async (tx)=>…)` +
  `insert...returning` pattern for the version-bump insert.
- `packages/db/src/index.ts` (whole file) — Why: the barrel. Add the `reportArtifacts` table export, the
  `repositories/reports.ts` fns, and the `ReportArtifactRow` type here (the ingest app imports from
  `@420ai/db`, never deep paths).
- `apps/ingest/src/routes/projects.ts` (whole file) + `apps/ingest/src/routes/projections.ts` (whole
  file) — Why: the **route template**. Copy the admin gate (`adminAuthorized`→401), the `isUuid`→404
  guard, the `findUserIdByEmail`/`ensureUserByEmail` single-user `userId` resolution, the `DEFAULT_EMAIL`
  constant pattern (`projections.ts:15`), and the body-schema wiring (`{ schema: { body: … } }`).
- `apps/ingest/src/auth.ts` (`adminAuthorized`, `isUuid`) — Why: the shared guards M7 reuses. Do NOT
  re-implement either.
- `apps/ingest/src/app.ts` (1-59) — Why: register `reportRoutes` alongside the others (after
  `projectionRoutes`); the generic error handler (43-56) suffices (read-mostly; a not-found is a guard
  404, a bad body is a schema 400). No new typed error needed.
- `apps/ingest/src/schemas.ts` (whole file — esp. the `as const` style + `usageOverTimeQuerySchema`
  142-151) — Why: the plain-JSON-schema style for the report `POST` bodies (`{ type, bucket? }`) and the
  history `GET` querystring (`?type=&scopeId=`). Mirror exactly; `additionalProperties: false`, `enum`
  for closed sets.
- `apps/ingest/src/app.int.test.ts` (harness + the discover→attribute→summary flow) — Why: the int-test
  template to extend. **Add `report_artifacts` to the `TRUNCATE` list.** Seed events → get the project id
  → `POST` a report → assert.
- `packages/db/src/repositories/workspaces.int.test.ts` — Why: the db-repo int-test template
  (`skipIf(!DATABASE_URL_TEST)`, per-test truncate, direct inserts) for `reports.int.test.ts`.
- `packages/shared/src/cost.ts` (`fmtUsd` is NOT here — it is private in session-report.ts; `CostConfidence`
  + `lowestConfidence` + `CONFIDENCE_ORDER` ARE here) + `packages/shared/src/tokens.ts` (`NormalizedTokens`,
  `zeroTokens`, `computeTotal`) + `packages/shared/src/index.ts` (barrel) — Why: the frozen vocabulary the
  renderers reuse, and where the new `reports.ts` exports are added to the barrel.
- `packages/shared/src/events.ts` (19-32 `EventType`) — Why: naming precedent for the dotted
  `ReportType` strings (`"project.cost_over_time"`, `"session.autopsy"`) — match the dotted-lowercase
  convention.

### New Files to Create

```
packages/shared/src/
  reports.ts                       # ReportType union; renderer input types; renderCostOverTimeReport,
                                    #   renderSessionAutopsyReport; REPORT_VERSION const; fmtUsd (shared)
  reports.test.ts                  # pure render tests: headers/tables/mermaid/confidence present & correct
packages/db/src/repositories/
  reports.ts                       # insertReportArtifact (version-bump), getReportArtifact,
                                    #   listReportArtifacts  (read/write, silent library)
  reports.int.test.ts              # skipIf(!DATABASE_URL_TEST): insert → version bump → get → list
packages/db/drizzle/
  0002_*.sql                       # GENERATED by `npm run db:generate` (do NOT hand-write); CREATE TABLE
                                    #   report_artifacts + indexes only
apps/ingest/src/reports/
  generate-report.ts               # orchestrator: read M6 projections → render → snapshot → store
apps/ingest/src/routes/
  reports.ts                       # admin-gated POST (generate) + GET (fetch/list) endpoints
```

### Files to MODIFY

```
packages/shared/src/index.ts       # export ReportType, renderer fns + input types, REPORT_VERSION, fmtUsd
packages/db/src/schema.ts          # ADD reportArtifacts table
packages/db/src/index.ts           # export reportArtifacts + reports repo fns + ReportArtifactRow type
apps/ingest/src/app.ts             # app.register(reportRoutes)
apps/ingest/src/schemas.ts         # ADD generateReportBodySchema(s) + listReportsQuerySchema
apps/ingest/src/app.int.test.ts    # ADD report generate/fetch/version round-trip; ADD report_artifacts to TRUNCATE
README.md                          # bump Status; brief M7 note (do not re-paste conventions)
```

> **Exactly ONE migration file is created**, by `db:generate` (Task 5). If `db:generate` emits more than
> the single `report_artifacts` CREATE, or any `ALTER`/`DROP` on an existing table, your `schema.ts` edit
> touched something it shouldn't — revert and re-isolate the change.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/PRD.md` §15 (Reporting — Markdown-first, Mermaid, tables, code blocks, links, **versioned report
  artifacts**, **comparison against prior artifacts** [deferred], **manual-first** [M7 is manual `POST`],
  the seven report types [M7 builds two]), §16.1 (Deterministic Metrics Pipeline — M7 reports are the
  deterministic layer that precedes M8 AI interpretation), §23 (Replay & Versioning — "track
  report/analysis version"; artifacts are versioned + retained — `report_version` + `version` columns
  satisfy this), §12 (event taxonomy includes `report.generated` — **NOT emitted in M7**, Scope Decision
  2), §18.1 (the plaintext-queryable set — report Markdown is derived plaintext, stored plaintext, never
  decrypts), §13.1/§13.3 (token sub-types + cost-confidence the report displays, already computed by M6).
- `docs/CONTEXT.md` — name code after these terms: **Report Artifact**, **Report History**, **Markdown
  Report**, **Mermaid Diagram**, **Deterministic Metrics Pipeline**, **User-Selectable Report**,
  **Manual-First Reporting**, **Project Cost**, **Tool-Native Session**, **Cost Confidence**.
- `.agents/plans/m6-event-projections.md` — Why: the immediately-prior milestone; M7 consumes its
  projections. Mirror its route/repo/int-test discipline, its D3 "plaintext-only, never decrypts" stance,
  and its "reuse over reinvention" thesis.
- `.agents/code-reviews/m6-event-projections.md` + `.agents/execution-reports/m4-m6-execution.md` — Why:
  the lessons that MUST carry into M7 (see "Lessons from M4–M6 to apply" below).
- `.agents/plans/m5-project-workspace-mapping.md` — Why: the last milestone that **added a table +
  migration**; M7's migration/table/CRUD/route discipline mirrors it.
- `.agents/plans/m2-archive-deployment.md` — Why: the Fastify route + migration baseline conventions.
- Drizzle ORM: schema/`pgTable` https://orm.drizzle.team/docs/sql-schema-declaration , migrations
  (`drizzle-kit generate`/`migrate`) https://orm.drizzle.team/docs/migrations , insert/`returning`
  https://orm.drizzle.team/docs/insert — Why: the table declaration + migration generation + version-bump
  insert.
- Mermaid: pie https://mermaid.js.org/syntax/pie.html , xychart (bar/line, **experimental**)
  https://mermaid.js.org/syntax/xyChart.html — Why: the diagram syntax the renderers emit. **`pie` is
  proven by M1; `xychart-beta` is newer** — the cost-over-time report renders BOTH a data table (always
  correct) AND an `xychart-beta` bar so the data is guaranteed even if a viewer can't render the chart.

### Patterns to Follow

**Pure renderer (mirror `renderSessionReport` — pure, returns string, NO file write, clock-injected):**
```ts
// packages/shared/src/reports.ts  (illustrative — keep dependency-free; import type only)
import type { UsageTotals, UsageByModelRow, UsageOverTimeRow, SessionDetail } from "./projections.js";

/** Dotted-lowercase per the EventType naming convention (events.ts). */
export type ReportType = "project.cost_over_time" | "session.autopsy";

/** Renderer identity stamped on every artifact for replay/versioning (PRD §23). Bump on render change. */
export const REPORT_VERSION = "m7-report-v1";

/** 6-decimal USD — sessions are cheap; 2 decimals reads as "$0.00" (lifted from session-report.ts:9-12). */
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

export interface CostOverTimeReportInput {
  projectName: string;
  generatedAt: string;            // ISO — injected by the caller (clock-free renderer, CLAUDE.md)
  bucket: "day" | "week";
  totals: UsageTotals;
  byModel: UsageByModelRow[];
  overTime: UsageOverTimeRow[];
}
export function renderCostOverTimeReport(input: CostOverTimeReportInput): string {
  const lines: string[] = [];
  lines.push(`# Project Cost Report — ${input.projectName}`);
  lines.push("");
  lines.push(`- **Generated:** ${input.generatedAt}`);
  lines.push(`- **Bucket:** ${input.bucket}`);
  lines.push(`- **Total cost:** ${fmtUsd(input.totals.costUsd)} (\`${input.totals.costConfidence}\`)`);
  lines.push(`- **Total tokens:** ${input.totals.tokens.total}`);
  // ...per-model table, per-bucket table, a `pie showData` of token composition,
  //    and an `xychart-beta` bar of cost per bucket (table guarantees the data).
  return lines.join("\n");
}

export interface SessionAutopsyReportInput { generatedAt: string; session: SessionDetail; }
export function renderSessionAutopsyReport(input: SessionAutopsyReportInput): string { /* mirror M1 */ }
```
> **Spike-snippet fidelity:** `fmtUsd` MUST be byte-behavior-identical to `session-report.ts:9-12`
> (6 decimals). The token table + `pie showData` block MUST match the M1 column order
> (`input | output | cache_read | cache_write | total`) so a session report rendered server-side reads
> identically to the collector's. M7 does NOT modify `session-report.ts`; it does not need to import from
> it (the renderer is independent) — `fmtUsd` is re-declared in `reports.ts` (shared) and the collector
> keeps its private copy (no behavior change to M1). Do not refactor M1 in this milestone.

**Report-artifact table (mirror `projects`/`workspaces` in schema.ts:144-210):**
```ts
// packages/db/src/schema.ts — ADD (after workspaceKeys). Plaintext metrics; no payload_* columns.
export const reportArtifacts = pgTable(
  "report_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    // Project-scoped reports set project_id; session-scoped reports leave it null.
    projectId: uuid("project_id").references(() => projects.id),
    reportType: text("report_type").notNull(),         // ReportType ("project.cost_over_time" | "session.autopsy")
    scopeKind: text("scope_kind").notNull(),           // "project" | "session"
    scopeId: text("scope_id").notNull(),               // project uuid (as text) OR connector session_id (text)
    version: integer("version").notNull(),             // 1-based; bumps per (user, report_type, scope_id)
    reportVersion: text("report_version").notNull(),   // REPORT_VERSION (renderer identity, PRD §23)
    params: jsonb("params"),                           // generation params, e.g. {bucket:"day"} (reproducibility)
    metrics: jsonb("metrics").notNull(),               // snapshot of the projection JSON rendered (replay/compare seam)
    markdown: text("markdown").notNull(),              // the rendered report (plaintext — derived metrics only)
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // History lookup + the version-bump backstop (one row per (user, type, scope, version)).
    uniqueIndex("report_artifacts_scope_version").on(t.userId, t.reportType, t.scopeId, t.version),
    index("report_artifacts_by_scope").on(t.userId, t.reportType, t.scopeId),
  ],
);
```

**Version-bump insert (mirror `repositories/ingest.ts` transaction + `repositories/projects.ts` returning):**
```ts
// packages/db/src/repositories/reports.ts (illustrative)
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { reportArtifacts } from "../schema.js";

export interface ReportArtifactRow {
  id: string; userId: string; projectId: string | null;
  reportType: string; scopeKind: string; scopeId: string;
  version: number; reportVersion: string;
  params: unknown; metrics: unknown; markdown: string; generatedAt: Date;
}

/** Insert a new artifact, bumping version per (user, reportType, scopeId). Returns the stored row. */
export async function insertReportArtifact(
  db: DbClient,
  a: Omit<ReportArtifactRow, "id" | "version" | "generatedAt">,
): Promise<ReportArtifactRow> {
  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select({ v: sql<number>`coalesce(max(${reportArtifacts.version}), 0)::int` })
      .from(reportArtifacts)
      .where(and(
        eq(reportArtifacts.userId, a.userId),
        eq(reportArtifacts.reportType, a.reportType),
        eq(reportArtifacts.scopeId, a.scopeId),
      ));
    const version = (prev?.v ?? 0) + 1;
    const [row] = await tx.insert(reportArtifacts).values({ ...a, version }).returning();
    return row as ReportArtifactRow;
  });
}
```
> **GOTCHAs:** (1) compute `version` inside the SAME transaction as the insert; the
> `report_artifacts_scope_version` unique index is the backstop if two generations race (single-user → all
> but irrelevant, but correct). (2) `metrics`/`params` are `jsonb` — pass JS objects, Drizzle serializes.
> (3) `generatedAt` defaults in the DB (`defaultNow()`) — but the renderer needs an ISO string at render
> time; resolve `generatedAt` ONCE in the orchestrator and pass the SAME value to BOTH the renderer and
> (optionally) the row, OR render with the orchestrator's timestamp and let the row default — keep them
> consistent (prefer: orchestrator computes `generatedAt`, passes to renderer, and sets the column
> explicitly so Markdown and row agree).

**Generation orchestrator (apps/ingest — composes db projections + shared renderer + db store):**
```ts
// apps/ingest/src/reports/generate-report.ts (illustrative)
import type { Db } from "@420ai/db";
import { usageTotals, usageByModel, usageOverTime, sessionDetail, getProjectName,
         insertReportArtifact, type ReportArtifactRow } from "@420ai/db";
import { renderCostOverTimeReport, renderSessionAutopsyReport, REPORT_VERSION } from "@420ai/shared";

export async function generateProjectCostReport(
  db: Db, userId: string, projectId: string, bucket: "day" | "week", generatedAt: string,
): Promise<ReportArtifactRow> {
  const [totals, byModel, overTime, projectName] = await Promise.all([
    usageTotals(db, projectId), usageByModel(db, projectId),
    usageOverTime(db, projectId, bucket), getProjectName(db, projectId),
  ]);
  const metrics = { totals, byModel, overTime };
  const markdown = renderCostOverTimeReport({ projectName: projectName ?? "(unknown)", generatedAt, bucket, ...metrics });
  return insertReportArtifact(db, {
    userId, projectId, reportType: "project.cost_over_time", scopeKind: "project",
    scopeId: projectId, reportVersion: REPORT_VERSION, params: { bucket }, metrics, markdown,
  });
}
// generateSessionAutopsyReport(db, userId, sessionId, generatedAt): sessionDetail → render → store
//   (projectId: null, scopeKind: "session", scopeId: sessionId).
```

**Admin-gated routes (mirror `routes/projections.ts` EXACTLY):**
```ts
// POST /v1/projects/:id/reports        body { type?: "project.cost_over_time", bucket?: "day"|"week" }
//   adminAuthorized→401; isUuid(:id)→404; resolve userId via ensureUserByEmail; generate → 201 {row}
// POST /v1/sessions/:sessionId/reports  body { type?: "session.autopsy" }
//   adminAuthorized→401; :sessionId is text (ungated); generate → 201
// GET  /v1/reports/:id                  adminAuthorized→401; isUuid(:id)→404; getReportArtifact → 200 | 404
// GET  /v1/reports                      adminAuthorized→401; ?type=&scopeId= → listReportArtifacts (history)
```
> **Precedence rule (resolves the M6 conflict the execution report flagged):** where the route needs a
> user, **resolve `userId` via `ensureUserByEmail`/`findUserIdByEmail` and store it on the artifact**
> (artifacts are user-owned and listed by user — unlike M6's pure project-scoped reads). This does NOT
> contradict "mirror routes/projections.ts": M6 reads were project-scoped (id is an owned UUID);
> M7 *writes* user-owned rows, so resolving the single-user id is required, not optional. Single-user M2:
> one user, `DEFAULT_EMAIL` constant as in `projections.ts:15`.

**Library files never log / `process.exit`** (CLAUDE.md): `reports.ts` (shared + db) and
`generate-report.ts` are silent and pure-ish (the db repo throws on error; the renderer is pure). Only
the Fastify error handler surfaces anything. Inject `db` so int tests pass a test-DB client.

---

## KEY DESIGN DECISIONS (read before coding)

### D1 — Two anchor report types, full pipeline (Scope Decision 1)
M7 builds `project.cost_over_time` (project-scoped, from `usageTotals`+`usageByModel`+`usageOverTime`) and
`session.autopsy` (session-scoped, from `sessionDetail`) — and threads BOTH through render→snapshot→store→
version→fetch→list. The other five §15 types are deferred; the `ReportType` union + `reportType` column
make adding them later a pure additive change (new renderer + new orchestrator branch, same table/routes).

### D2 — Renderers are PURE and live in `@420ai/shared`; orchestration lives in `apps/ingest`
The Markdown/Mermaid string-building is a pure function of projection data + an injected `generatedAt`
(mirrors `renderSessionReport`; unit-tested with no DB). It CANNOT live in `@420ai/db` (db has no business
formatting Markdown) and SHOULD NOT live only in the route (untestable without a server). The
orchestrator (`apps/ingest/src/reports/generate-report.ts`) is the only place that composes db-reads +
render + db-write, and it is int-tested. This keeps `@420ai/shared` dependency-free and the renderer
trivially unit-testable.

### D3 — Plaintext storage; never decrypts (inherited M6 D3 / PRD §18.1)
Reports render from the M6 projections, which read only plaintext columns. The stored `markdown` +
`metrics` contain only counts/tokens/cost/model/paths/timestamps — none of §18.1's encrypt-list — so
`report_artifacts` has **no `payload_*` columns** and stores Markdown as plaintext `text`. M7 never reads
`events.payload_*` and never calls `decryptField`. A content-quoting autopsy (encrypted prompt/output
excerpts) is **M8** (it needs the redaction pipeline) — M7's autopsy is metrics-only.

### D4 — `report_artifacts` table + ONE additive migration; no event/schema change elsewhere (Scope Decision 2)
The artifact row is the record of a generated report — NOT a `report.generated` event in the event log
(the connector fingerprint model doesn't fit a server-generated artifact). M7 adds exactly one table and
one generated migration (`CREATE TABLE report_artifacts` + indexes); it does NOT alter `events`, the
fingerprint, the wire types, the encryption split, any connector `parse`, or the M6 projection SQL. If
`db:generate` emits anything beyond the single CREATE, revert.

### D5 — Versioned, append-only artifacts; comparison deferred (Scope Decision 3 / PRD §23)
Regenerating a report for the same `(userId, reportType, scopeId)` inserts a NEW row with
`version = max(version)+1` — prior artifacts are retained (history). `GET /v1/reports?type=&scopeId=`
lists them newest-first; `GET /v1/reports/:id` fetches one. The `metrics` JSON snapshot is stored on every
row so a FUTURE comparison endpoint can diff two artifacts without re-querying — but **M7 builds no
diff/compare endpoint** (deferred). `reportVersion` (`REPORT_VERSION`) stamps the renderer identity so a
future renderer change is distinguishable on replay (PRD §23 "track report/analysis version").

### D6 — Endpoint surface: admin-gated POST (generate) + GET (fetch/list), mirroring routes/projects.ts
```
POST /v1/projects/:id/reports          body { type?, bucket? }   → 201 ReportArtifactRow   (isUuid :id → 404)
POST /v1/sessions/:sessionId/reports   body { type? }            → 201 ReportArtifactRow   (:sessionId text — ungated)
GET  /v1/reports/:id                   → 200 ReportArtifactRow | 404                       (isUuid :id → 404)
GET  /v1/reports?type=&scopeId=        → 200 ReportArtifactRow[] (history, newest first)
```
All admin-gated (`adminAuthorized`→401). `type` defaults to the scope's only M7 type
(`project.cost_over_time` for project routes, `session.autopsy` for session routes) and is validated
against the `ReportType` enum (reject unknown → 400). `bucket` defaults `day`, validated `day|week`.
Resolve the single-user `userId` via `ensureUserByEmail`/`findUserIdByEmail` (D2 precedence rule).
**Optional convenience (only if trivial):** `GET /v1/reports/:id/markdown` returning `text/markdown`
(`reply.type("text/markdown")`) for a raw download — nice-to-have, not required; skip if it adds risk.

### D7 — Unknown/empty scopes return an EMPTY but valid report, never a 500
`sessionDetail` returns a zeroed projection for an unknown `sessionId` (M6 contract) — generating an
autopsy for it yields a valid "empty session" Markdown (all-zero counts), stored at version 1. A
project with no events yields a zeroed cost report (all-zero totals, empty tables, `"unknown"`
confidence). Generation never throws on empty data; only a genuinely missing **project id** (non-uuid)
→ 404 via the guard. This mirrors M6's "empty project → zeros, not error" edge contract.

---

## Lessons from M4–M6 to apply (from the execution report + code review — do NOT relearn these)

- **Run the gate with the test DB UP before declaring done.** M5 shipped a latent `lastActivity` type bug
  because int tests self-skip without `DATABASE_URL_TEST` (a green gate with int tests skipped is NOT
  green — CLAUDE.md). M7 adds a **table** and an int-dependent write path → this is mandatory:
  `npm run repo-health -- --require-db` (asserts the int layer actually ran, 0 skipped).
- **`mode:"string"` timestamps come back as STRINGS in raw `sql`.** `usageOverTime` already returns ISO
  `bucket` strings; `sessionDetail.startedAt/endedAt` are strings. The renderer treats them as strings
  (no `.toISOString()` on an already-string). `report_artifacts.generatedAt` is a real `timestamp` column
  (Date in the `Row`), but the renderer's `generatedAt` PARAM is an ISO string the orchestrator computes.
- **Verify aggregate/output shape against the live DB, not just types.** The M6 phantom-null-model row
  was invisible to `tsc`. The M7 int tests must assert the actual Markdown content + the version bump
  against the real DB, not just that a row was inserted.
- **State which instruction wins when two could conflict** (D2 precedence rule above resolves
  "mirror the route exactly" vs "resolve userId").
- **Keep the milestone diff clean** — no stray dependency creep (an unrelated `headroom-ai` dep crept into
  M6 mid-session and had to be reverted). M7 adds **no** new dependency.

---

## IMPLEMENTATION PLAN

### Phase 1: Shared renderers (no infra)
Add `ReportType`, the renderer input types, `REPORT_VERSION`, `fmtUsd`, and the two pure render functions
to `@420ai/shared/reports.ts`; export from the barrel. Unit-test the rendered Markdown.

### Phase 2: Storage (`@420ai/db`)
Add the `reportArtifacts` table to `schema.ts`; **generate + review + apply the migration** (Task 5 — the
migration-verification gate); add `repositories/reports.ts` (version-bump insert + get + list); export
from the barrel; int-test it.

### Phase 3: Generation + server surface (`apps/ingest`)
Add the generation orchestrator, the admin-gated routes, the body/query schemas; register the route
plugin.

### Phase 4: Tests, validation, docs
Pure shared render tests + Postgres-gated int tests (db repo + ingest endpoints: generate→fetch→version
round-trip) + the full `repo-health` gate (with `--require-db`) + README.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Run each task's VALIDATE before moving on.

### Task 1 — CREATE `packages/shared/src/reports.ts`
- **IMPLEMENT**: `ReportType` union (`"project.cost_over_time" | "session.autopsy"`); `REPORT_VERSION`
  const (`"m7-report-v1"`); `fmtUsd` (6-decimal, behavior-identical to `session-report.ts:9-12`);
  `CostOverTimeReportInput` + `renderCostOverTimeReport`; `SessionAutopsyReportInput` +
  `renderSessionAutopsyReport`. Cost-over-time renders: a header bullet list (project, generated,
  bucket, total cost+confidence, total tokens), a **per-model table** (`| model | input | output |
  cache_read | cache_write | total | cost |`), a **per-bucket table** (`| bucket | total tokens | cost |`),
  a `pie showData` of total token composition (input/output/cache_read/cache_write — mirror
  `session-report.ts:84-91`), and an `xychart-beta` bar of cost-per-bucket (with a comment noting the
  table is the source of truth). Autopsy renders the M1 session shape (project/branch/models/time
  range/counts/tool outcomes/token table/cost) from `SessionDetail`, plus the token-composition pie.
- **PATTERN**: `apps/collector/src/report/session-report.ts` (whole file). Pure function → string; no file
  I/O; clock injected via `generatedAt`.
- **IMPORTS**: `import type { UsageTotals, UsageByModelRow, UsageOverTimeRow, SessionDetail } from
  "./projections.js";` (type-only). Keep `@420ai/shared` dependency-free.
- **GOTCHA**: token table column order MUST be `input | output | cache_read | cache_write | total`
  (matches M1). `generatedAt`/`startedAt`/`endedAt` are already ISO strings — do NOT call `.toISOString()`.
  Escape nothing fancy; Mermaid `pie` labels are quoted strings as in M1. Handle empty `overTime`/all-zero
  totals gracefully (valid Markdown, empty table body).
- **VALIDATE**: `npm run -w @420ai/shared build` (exit 0).

### Task 2 — UPDATE `packages/shared/src/index.ts`: export the report surface
- **IMPLEMENT**: export `ReportType`, `REPORT_VERSION`, `fmtUsd`, `renderCostOverTimeReport`,
  `renderSessionAutopsyReport`, and the input types (`CostOverTimeReportInput`,
  `SessionAutopsyReportInput`) from the barrel.
- **VALIDATE**: `npm run -w @420ai/shared build` (exit 0).

### Task 3 — CREATE `packages/shared/src/reports.test.ts` (pure unit tests)
- **IMPLEMENT**: feed hand-built `UsageTotals`/`UsageByModelRow[]`/`UsageOverTimeRow[]` and a
  `SessionDetail` into the renderers; assert the output **string** contains: the `# ` title with the
  project/session name, the total-cost line with `fmtUsd` formatting + the confidence in backticks, each
  model row, each bucket row, a ```` ```mermaid ```` fence with `pie showData`, and (cost-over-time) the
  `xychart-beta` block. Assert an empty/all-zero input still renders valid Markdown (title + zero totals,
  no thrown error).
- **PATTERN**: existing `packages/shared/src/*.test.ts` (vitest, co-located, no infra).
- **VALIDATE**: `npm test -w @420ai/shared` (exit 0).

### Task 4 — UPDATE `packages/db/src/schema.ts`: add the `reportArtifacts` table
- **IMPLEMENT**: the `reportArtifacts` `pgTable` per "Patterns to Follow" — uuid pk `defaultRandom()`,
  `userId` FK → `users.id` (notNull), `projectId` FK → `projects.id` (nullable), `reportType`/`scopeKind`/
  `scopeId`/`reportVersion`/`markdown` text, `version` integer notNull, `params` jsonb (nullable),
  `metrics` jsonb notNull, `generatedAt` timestamptz `defaultNow()`; the `report_artifacts_scope_version`
  uniqueIndex + the `report_artifacts_by_scope` index.
- **PATTERN**: `schema.ts:144-210` (`projects`/`workspaces`/`workspaceKeys`). NO `payload_*` columns
  (D3 — plaintext metrics).
- **GOTCHA**: `metrics`/`params` are `jsonb` — type them `jsonb("metrics").$type<...>()` only if a precise
  type helps; `jsonb(...).notNull()` returning `unknown` is acceptable (it's a snapshot blob). Place the
  table AFTER `workspaceKeys` so FKs resolve.
- **VALIDATE**: `npm run typecheck` (exit 0). (Migration is Task 5.)

### Task 5 — GENERATE + VERIFY + APPLY the migration (the M7 "spike" gate)
- **IMPLEMENT**: `npm run db:generate`. Confirm **exactly one** new file
  `packages/db/drizzle/0002_*.sql` appeared and `_journal.json` gained one entry. **Open the SQL** and
  confirm it is ONLY `CREATE TABLE "report_artifacts" (...)` + its `CREATE [UNIQUE] INDEX` + the FK
  constraints to `users`/`projects` — and contains NO `ALTER TABLE`/`DROP` on `events`,
  `raw_source_records`, `workspaces`, `workspace_keys`, `projects`, or any existing table. If it touches
  anything else, your schema edit leaked — revert and re-isolate.
- **THEN**: `npm run db:up && npm run db:migrate` (apply to the local/test DB) and confirm clean apply.
- **GOTCHA**: do NOT hand-edit the generated SQL. The migration file IS committed (it is the source of
  truth for `db:migrate`) — unlike the M6 "no migration" invariant, M7 SHIPS one migration.
- **VALIDATE**: the `0002_*.sql` exists and reads as a single CREATE TABLE (+ indexes/FKs); `db:migrate`
  exits 0; re-running `npm run db:generate` now reports **"No schema changes"** (the schema and migrations
  are in sync).

### Task 6 — CREATE `packages/db/src/repositories/reports.ts`
- **IMPLEMENT**: `ReportArtifactRow` interface; `insertReportArtifact(db, a)` (version-bump in a
  transaction per "Patterns to Follow"); `getReportArtifact(db, id): Promise<ReportArtifactRow |
  undefined>`; `listReportArtifacts(db, userId, filter?: { reportType?: string; scopeId?: string }):
  Promise<ReportArtifactRow[]>` (newest first by `generatedAt`/`version`, filtered by the optional
  `reportType`/`scopeId`, scoped by `userId`).
- **PATTERN**: `repositories/projects.ts` (typed Row, `insert...returning`, `select().from().where(eq/and)`,
  `desc`), `repositories/ingest.ts:22` (transaction). Silent library — throws, never logs.
- **GOTCHA**: version computed inside the transaction; `metrics`/`params` passed as JS objects (Drizzle
  serializes jsonb). Scope `listReportArtifacts` by `userId` (artifacts are user-owned).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 7 — UPDATE `packages/db/src/index.ts`: export the table + repo + Row type
- **IMPLEMENT**: add `reportArtifacts` to the table re-exports; export `insertReportArtifact`,
  `getReportArtifact`, `listReportArtifacts`, and `type ReportArtifactRow`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 8 — CREATE `packages/db/src/repositories/reports.int.test.ts`
- **IMPLEMENT** (`describe.skipIf(!process.env.DATABASE_URL_TEST)`, mirror `workspaces.int.test.ts`):
  seed a user; `insertReportArtifact` twice for the SAME `(userId, reportType, scopeId)` → assert the
  first is `version: 1`, the second `version: 2`, both rows retained; `getReportArtifact(id)` returns the
  exact stored Markdown + metrics; `listReportArtifacts(userId, { scopeId })` returns both newest-first
  and filters by `reportType`/`scopeId`. Assert a different `scopeId` starts again at `version: 1`.
- **GOTCHA**: int test excluded from `tsc -b` + self-skips without `DATABASE_URL_TEST`. Insert directly
  via the repo (no server). TRUNCATE/clean `report_artifacts` per test (mirror the existing per-test
  cleanup).
- **VALIDATE**: `npm test` (self-skips, exit 0) AND with DB up:
  `DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test` (passes).

### Task 9 — CREATE `apps/ingest/src/reports/generate-report.ts`
- **IMPLEMENT**: `generateProjectCostReport(db, userId, projectId, bucket, generatedAt)` and
  `generateSessionAutopsyReport(db, userId, sessionId, generatedAt)` per "Patterns to Follow" — read the
  M6 projections, snapshot them into `metrics`, render Markdown, `insertReportArtifact`, return the row.
- **PATTERN**: the orchestrator snippet above; imports from `@420ai/db` (projections + getProjectName +
  insertReportArtifact) and `@420ai/shared` (renderers + REPORT_VERSION). Silent — throws on error.
- **GOTCHA**: compute `generatedAt` ONCE in the route, pass it in (clock injected — do NOT call
  `new Date()` in the renderer or here; the route owns the clock). `projectId` is null for autopsy;
  `scopeId` = projectId (project report) or sessionId (autopsy).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 10 — UPDATE `apps/ingest/src/schemas.ts`: add report body + query schemas
- **IMPLEMENT**: `generateProjectReportBodySchema` (`{ type?: enum["project.cost_over_time"],
  bucket?: enum["day","week"] }`, `additionalProperties:false`), `generateSessionReportBodySchema`
  (`{ type?: enum["session.autopsy"] }`), `listReportsQuerySchema` (`{ type?: string, scopeId?: string }`).
- **PATTERN**: the `as const` JSON-schema style + `usageOverTimeQuerySchema` (142-151).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 11 — CREATE `apps/ingest/src/routes/reports.ts`
- **IMPLEMENT** the D6 endpoints, each admin-gated (`adminAuthorized`→401); project POST + `GET /reports/:id`
  `isUuid`-guarded (→404); `:sessionId` ungated (text). Resolve `userId` via `ensureUserByEmail`
  (single-user, `DEFAULT_EMAIL` constant as in `projections.ts:15`). Compute `generatedAt = new Date()
  .toISOString()` in the handler and pass to the orchestrator. POST → 201 with the stored row; unknown
  `type` → 400 (schema enum); `GET /v1/reports/:id` unknown id → 404.
- **PATTERN**: `routes/projects.ts` + `routes/projections.ts` verbatim (admin gate + uuid guard + userId
  resolution + body-schema wiring).
- **GOTCHA**: the renderer/orchestrator are clock-free — the **route** owns `generatedAt`. Read-only
  guards handle bad input (no new typed error). Do NOT add a machine-auth preHandler (these are
  admin/dashboard ops, like the project CRUD).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 12 — UPDATE `apps/ingest/src/app.ts`: register the route plugin
- **IMPLEMENT**: `import reportRoutes from "./routes/reports.js";` and `app.register(reportRoutes);` after
  `projectionRoutes`. No error-handler change.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 13 — UPDATE `apps/ingest/src/app.int.test.ts`: report round-trip + TRUNCATE
- **IMPLEMENT** (extend the suite, `skipIf(!DATABASE_URL_TEST)`): **add `report_artifacts` to the
  `TRUNCATE … RESTART IDENTITY CASCADE` list** (M7 adds a table). Then: pair → discover → ingest events
  with `tokens`/`cost`/varied `event_type` for a `project_path` and a known `session_id` →
  `GET /v1/projects` for the id → `POST /v1/projects/:id/reports` → assert 201, `version: 1`, Markdown
  contains the project name + a cost line + a `mermaid` block; `POST` again → `version: 2`;
  `GET /v1/reports/:id` returns the stored row; `GET /v1/reports?scopeId=<projectId>` lists both;
  `POST /v1/sessions/:sessionId/reports` → 201 autopsy with the session counts. Assert all routes 401
  without the admin token; a non-uuid project id → 404 (not 500); an unknown report `:id` → 404.
- **GOTCHA**: reuse the existing `discoverPayload`/ingest helpers; ISO `ts` strings
  (`"2026-06-14T00:00:00.000Z"`). If `report_artifacts` is NOT truncated, version assertions flake across
  tests.
- **VALIDATE**: `npm test` (self-skips) / with DB up: full int passes.

### Task 14 — UPDATE README "Status" + run the gate
- **UPDATE** README Status: M7 added the reporting foundation — durable, versioned Markdown report
  artifacts (project cost-over-time + session autopsy, metrics-only) rendered from the M6 projections,
  stored in `report_artifacts` (one additive migration), generated/fetched/listed via admin endpoints;
  comparison + AI interpretation + the other five report types deferred to M8+. Brief — do not re-paste
  conventions.
- **VALIDATE (the gate)**: `npm run repo-health` (root `tsc -b` + full `vitest run` + NUL + stray-artifact
  scan; exit 0), THEN with the DB up `npm run repo-health -- --require-db` (asserts the int layer ran,
  0 skipped — mandatory for this DB-touching milestone). Confirm exactly ONE migration (`0002_*`) is
  staged and no stray emitted JS/d.ts.

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, no infra — always run)
- `packages/shared/src/reports.test.ts`: the renderers produce correct Markdown for representative +
  empty/all-zero inputs (title, totals, model/bucket rows, mermaid fences, confidence formatting). Pure,
  deterministic (inject `generatedAt`).

### Integration Tests (`*.int.test.ts`, `DATABASE_URL_TEST`-gated, excluded from `tsc -b`)
- `packages/db/src/repositories/reports.int.test.ts`: version bump per `(user, type, scope)`; retention;
  get/list/filter.
- `apps/ingest/src/app.int.test.ts` additions: discover→ingest→`POST` report→`GET` fetch/list→regenerate
  version bump; admin 401s; uuid-guard 404s; unknown report id 404.

### Edge Cases (must be covered)
- **Empty project** (no events) → cost report renders all-zero totals + empty tables + `"unknown"`
  confidence, stored at `version: 1`; no throw (D7).
- **Unknown `sessionId`** → autopsy renders a zeroed session (M6 `sessionDetail` contract), stored; no
  throw, no 404 (session ids are text).
- **Regeneration** of the same `(type, scope)` → new row `version+1`, prior retained (history).
- **Distinct scope** → version restarts at 1.
- **Unknown report `type`** in the POST body → 400 (schema enum), no row written.
- **Non-uuid project `:id`** / **unknown report `:id`** → 404, not a Postgres cast 500.
- **Mermaid/markdown integrity** → the output contains a balanced ```` ```mermaid … ``` ```` fence and
  the token table column order matches M1.
- **Idempotency note (NOT dedup):** unlike events, report generation is intentionally NON-idempotent —
  each POST is a new versioned artifact. Assert two POSTs yield two rows (this is by design, the inverse
  of the event fingerprint upsert).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with the stated pass signal.

### Level 1: Typecheck / Build (repo-root — catches cross-project + test-only imports)
- `npm run typecheck` → root `tsc -b`, **exit 0**. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests
- `npm test` → full `vitest run`; units always run, `*.int.test.ts` self-skip without `DATABASE_URL_TEST`.
  **All pass, exit 0.** Focused: `npm test -w @420ai/shared -- reports`.

### Level 3: Integration Tests (Postgres) — MANDATORY for this milestone (it adds a table + write path)
- `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test`
  → the db-repo reports int test + the ingest report endpoint int tests pass. **Exit 0.** `db:migrate`
  applies the new `0002_*` migration (NOT a no-op this time — unlike M6).

### Level 4: Manual Validation (real data)
- With a paired + discovered archive carrying real captured sessions, start the API
  (`npm run ingest:dev`), then with the admin token:
  - `curl -s localhost:8420/v1/projects -H "authorization: Bearer $ADMIN_TOKEN"` → pick a project id.
  - `curl -s -X POST localhost:8420/v1/projects/<id>/reports -H "authorization: Bearer $ADMIN_TOKEN"
    -H "content-type: application/json" -d '{"bucket":"day"}'` → 201 with `version:1` and a `markdown`
    field; paste the Markdown into a Mermaid-aware viewer and confirm the pie + bar render.
  - `curl` it again → `version:2`. `GET /v1/reports?scopeId=<id>` lists both. `GET /v1/reports/<artifactId>`
    fetches one.
  - `POST /v1/sessions/<sessionId>/reports` for a real session id → an autopsy whose counts match the M1
    `collector report <sessionId>` for the same session (same arithmetic, now server-side).

### Level 5: The enforced gate
- `npm run repo-health` → exit 0. THEN `npm run repo-health -- --require-db` (DB up) → exit 0, int layer
  ran with **0 skipped**. Confirm exactly one `0002_*` migration is staged; no stray emitted JS/d.ts;
  `db:generate` reports "No schema changes" (schema ↔ migrations in sync).

---

## ACCEPTANCE CRITERIA

- [ ] `@420ai/shared/reports.ts` exports `ReportType`, `REPORT_VERSION`, `fmtUsd`,
      `renderCostOverTimeReport`, `renderSessionAutopsyReport` (+ input types); renderers are pure,
      clock-injected, dependency-free, and produce Markdown with Mermaid (`pie` + `xychart-beta` for
      cost-over-time; `pie` for autopsy). Exported from the barrel.
- [ ] `report_artifacts` table added; **exactly one** generated migration `0002_*.sql` (CREATE TABLE +
      indexes/FKs only — nothing else touched); `db:migrate` applies it; `db:generate` then reports no
      changes.
- [ ] `repositories/reports.ts` provides `insertReportArtifact` (version-bumps per `(user, type, scope)`,
      retains history), `getReportArtifact`, `listReportArtifacts` (userId-scoped, filterable); exported
      from the barrel.
- [ ] Admin-gated endpoints (D6): `POST /v1/projects/:id/reports`, `POST /v1/sessions/:sessionId/reports`,
      `GET /v1/reports/:id`, `GET /v1/reports` — 401 without admin; non-uuid/unknown id → 404; unknown
      `type` → 400; POST → 201 with the stored row; regenerate bumps `version`.
- [ ] Reports render from M6 projections only — **never decrypts a payload**, no `payload_*` columns;
      stored Markdown contains only derived metrics (D3).
- [ ] **No `report.generated` event emitted; no comparison/diff endpoint; only two report types** (the
      three scope decisions honored).
- [ ] **No fingerprint/wire/encryption/parse change, no collector change, no `events`/M5-table schema
      change** — the only schema delta is the additive `report_artifacts` table.
- [ ] `npm run repo-health` passes; `npm run repo-health -- --require-db` passes with the int layer run,
      0 skipped (DB up); no stray artifacts/NUL bytes; exactly one new migration committed.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately (paste exit codes).
- [ ] Task 5 migration-verification gate done: the generated `0002_*.sql` was READ and confirmed to be a
      single CREATE TABLE (+ indexes/FKs), touching no existing table, before being applied.
- [ ] Full suite passes (unit always; integration with `DATABASE_URL_TEST` — run WITH the DB up at least
      once via `repo-health -- --require-db`, 0 int tests skipped).
- [ ] Manual generation on real data returned a valid versioned Markdown report; the Mermaid rendered; an
      autopsy's counts matched the M1 collector report for the same session.
- [ ] Deferred scope honored (only 2 report types; no `report.generated` event; no compare endpoint; no
      AI interpretation; no decryption; no export bundle; no dashboard; no scheduling).
- [ ] README Status updated; `repo-health` green; exactly one migration (`0002_*`) committed.

---

## NOTES

**Why renderers in `@420ai/shared`, not in the route or db (D2):** the Markdown/Mermaid string-building is
a pure function of projection data; putting it in shared keeps it dependency-free and unit-testable with
no DB (mirroring how `renderSessionReport` is a pure collector function). The db layer stays
formatting-agnostic; the route stays a thin guard+compose. The orchestrator in `apps/ingest` is the only
seam that touches all three, and it is the int-tested boundary.

**Why versioned append, not overwrite (D5 / PRD §23):** report artifacts are the point-in-time, durable
record (unlike the disposable event projections). Retaining every generation + stamping `reportVersion`
is exactly the PRD §23 "track report/analysis version, allow future replay" story, and the stored
`metrics` snapshot is the seam a future comparison endpoint diffs — so the comparison feature (deferred)
costs almost nothing to add later: a new route over two existing rows, no schema change.

**Why one migration is fine here (contrast M6):** M6's signature was "zero migration" because it was
read-only. M7 must persist artifacts, so a table is unavoidable and correct. The risk is not "should we
migrate" but "did `db:generate` emit only what we intended" — retired by Task 5 reading the SQL, the
analog of M6's jsonb-aggregation spike. The table is purely additive (CREATE TABLE), so it cannot affect
the frozen event/fingerprint/encryption invariants.

**What M8 builds on this:** AI interpretation (PRD §16.2) feeds a **redacted report bundle** to a
configurable provider. M7's `report_artifacts.metrics` snapshot + `markdown` are the bundle's
deterministic core; M8 adds the redaction pass (for any content-bearing section) and the provider call,
storing the AI findings as a new artifact (or a column) — without changing M7's table shape. The
content-rich autopsy (quoting prompts/outputs) also lands in M8, where the decryption+redaction path
exists. Keep M7's artifacts report-bundle-friendly (structured `metrics` + clean Markdown) but do NOT
call any AI provider or decrypt anything here.

**Tool-call failure classification (PRD §14) stays deferred:** the autopsy surfaces failure *counts*
(`toolsFailed` from M6), not the seven-way classification (which needs per-failure encrypted-payload
inspection) — same boundary M6 drew.

**Confidence score: 9.0/10.** M7 composes layers that are already built and proven: the M6 projection
data (tested), the pure-Markdown-renderer pattern (M1's `renderSessionReport`), and the
table+migration+CRUD+admin-route shape (M2/M5's `projects`/`workspaces`). It adds no new dependency, no
new external surface beyond admin GET/POST, and never decrypts. The one mechanic M6 avoided — a migration
— returns, but it is deterministic drizzle-kit retired by reading the emitted SQL (Task 5) and pinned by
int tests, and it is purely additive (cannot touch the frozen invariants). The −1.0 is: (a) the migration
must be generated-and-verified rather than asserted-absent (a new step, low risk); (b) `xychart-beta` is a
newer Mermaid type whose rendering in an arbitrary viewer is not guaranteed — mitigated by always
emitting the source-of-truth data table alongside it; and (c) the renderers' exact Markdown is taste-laden
and may need a polish pass, but correctness (the numbers + structure) is pinned by the unit + int tests.
Everything else is a faithful repeat of patterns proven across M1–M6.
