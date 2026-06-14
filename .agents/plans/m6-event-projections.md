# Feature: Milestone 6 — Event Projections (sessions, usage, cost, connector health, Git metadata)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Pay special attention to naming of
existing utils, types, and models — import from the right files (`@420ai/shared`, `@420ai/db`, `.js`
relative specifiers, `import type` for type-only imports). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **Branch:** all M6 work lands on `m6-event-projections` (already created off `m5-project-mapping`). M5
> is not yet merged to `main`, so M6 stacks on it — intentional (M6 projects over the events M1–M4
> capture, attributed via the M5 `workspace_keys` join).

> **Scope decisions confirmed with the user during planning** (these bound the milestone — honor them):
> 1. **Git metadata = project existing on-event metadata only.** M6 surfaces the `git_branch` /
>    `project_path` already attached to events. It does **NOT** add a git-history reader or emit
>    `git.commit.detected` / `git.diff.detected` events — that capture surface is its own later slice.
> 2. **On-demand SQL aggregation, NOT materialized rollup tables.** Projections are read-time query
>    repositories over `events` (the volume is single-digit GB/year — PRD §8.5 — and events are
>    disposable/re-buildable, so materialization would add staleness/backfill code for no V1 benefit).
>    **No new tables, no migration.**
> 3. **Connector health is DERIVED** from existing `events` (+ `raw_source_records`) — last-event
>    timestamp, volume, failure counts, parser/model seen. M6 does **NOT** add collector-side
>    `connector.health` event emission (that is an M9 Live-Monitor concern).

---

## Feature Description

After M5, the archive holds a flat, **attributable** event stream: every event carries plaintext
`project_path` / `git_branch` / `model` / `ts` / `tokens` / `cost` / `source_connector` / `session_id`,
and the M5 `workspace_keys` alias table joins each `project_path` (real path for Claude/Codex, the
`projectHash` for Gemini) to a `workspace` and a `project`. The only projection that exists is the M5
proof-of-wiring `projectEventSummary` (event count + last activity).

M6 builds the **deterministic projection layer** the rest of the product reads — the "Deterministic
Metrics Pipeline" (PRD §16.1) that runs *before* any AI interpretation. Per the event-sourcing
principle (PRD §12/§23, SUMMARY §5: *"sessions, reports, summaries, and metrics are projections over the
event log"*), M6 turns the flat log into five read-time projections, all server-side in `@420ai/db`
(query repositories) + `apps/ingest` (admin-gated read endpoints), reusing the proven M5 attribution
join and the frozen `@420ai/shared` token/cost arithmetic:

1. **Sessions** — reconstruct each tool-native session (`session_id`): time range + duration, message /
   tool-call / file-touch counts, tool-call failures, model(s), token totals, cost total + confidence,
   project attribution. (Precursor to PRD §15 "session autopsy".)
2. **Usage** — token aggregates (the normalized `NormalizedTokens` sub-types) per project, per model,
   and over time, from `usage.reported` events.
3. **Cost** — USD aggregates from `cost.estimated` events, carrying the **lowest-confidence-wins** label
   (PRD §13.3) across a mixed set.
4. **Connector health** — per-connector last-event-age ("last event N seconds ago", PRD §10.1.1), event
   volume, tool-call failure count, and parser/model seen — derived from the event log, no collector
   change.
5. **Git metadata** — the distinct `git_branch` / `project_path` values per project/session already on
   events (which branches/repos work happened on). Factual, no inference, no new capture.

This implements PRD §16.1 (deterministic metrics before AI), §14 (the metric categories that have source
data today: project cost over time, token efficiency inputs, tool-call failures, connector health),
§10.1.1 (last-event-age), §6/§19 (project-scoped views), and SUMMARY §3 milestone 6. It is the data
foundation M7 ("Reporting foundation: deterministic metrics + Markdown report artifacts") renders.

### Why this is the lowest-risk milestone so far

M6 is **strictly additive and read-only**. It does NOT touch: the event fingerprint (PRD §12), the M2
event wire types / ingest path, the AES-GCM encryption split (PRD §18.1), any connector's `parse`, the
M5 tables, or **any** migration (zero schema change). It reads only the **plaintext, queryable** columns
(`ts`, `event_type`, `model`, `tokens`, `cost`, `project_path`, `git_branch`, `source_connector`,
`session_id`, `machine_id`, `parser_version`) — it **never decrypts a payload**. The one novel mechanic
(jsonb numeric aggregation in Drizzle `sql` templates) is a small extension of the **already-proven**
`projectEventSummary` join.

### Explicitly deferred — do NOT build in M6

- **Git-history capture.** No `git log` reader, no `git.commit.detected` / `git.diff.detected` event
  emission, no Git **outcome attribution** scorer (PRD §11.3/§11.4). M6 only projects the git fields
  already on events. (Capturing commit/diff metadata is a separate later slice.)
- **Materialized rollup tables / refresh-on-ingest.** On-demand queries only (Scope Decision 2).
- **`connector.health` event emission from the collector.** Health is derived (Scope Decision 3); real
  heartbeats belong to M9 (Live Monitor).
- **Markdown report artifacts + the `report.generated` event + report storage/versioning.** That is M7.
  M6 returns structured projection data (JSON), not rendered reports.
- **AI interpretation, redaction bundles** (M8); **full-text search** over the redacted projection (PRD
  §21); **exports** (M10). M6 is deterministic metrics only.
- **A dashboard / web UI** (its own later milestone — same as M5, headless).
- **Subscription amortization** cost path (PRD §13.3 rung 4) — not enough source data in V1; the ladder
  already types it for later.

## User Story

As an AI-heavy developer whose Claude Code, Codex, and Gemini sessions are captured and attributed to
projects,
I want the archive to compute factual per-session, per-project, per-model, and per-connector
metrics — token usage, cost (with honest confidence), session shape, tool-call failures, and which
connectors are still alive — directly from the event log,
So that I (and the M7 reporting layer) can answer "what did each project cost," "which model/tool is
efficient," "is a connector silently dead," and "how big was that session" without hand-rolling SQL or
waiting on AI interpretation.

## Problem Statement

The archive can store and attribute events but cannot yet **answer questions about them**. There is no
way to ask "total tokens/cost for project X," "break that down by model or by day," "list the sessions
in this project with their failure counts," "show me one session's shape," or "when did each connector
last produce an event." The only projection (`projectEventSummary`) returns a bare count + last
timestamp. PRD §16.1's "Deterministic Metrics Pipeline" — the factual layer that must exist before any
report (M7) or AI interpretation (M8) — does not exist in code. Every later milestone that reads
aggregated metrics is blocked on it.

## Solution Statement

Add a **projections repository** (`packages/db/src/repositories/projections.ts`) of pure-SQL, read-only
aggregation functions that extend the proven M5 attribution join (`events.project_path` →
`workspace_keys.project_key` → `workspaces` → `projects`, scoped by `userId`). Token sums use jsonb
numeric extraction (`sum((tokens->>'input')::bigint)`); session shape uses conditional aggregates
(`count(*) filter (where event_type = …)`); cost carries the **lowest-confidence-wins** label computed in
TS from a shared ladder. Promote the existing `lowestConfidence` ladder out of the M1
`session-report.ts` into `@420ai/shared/cost.ts` so the server projections and the M1 report share ONE
implementation. Define the projection result shapes in `@420ai/shared/projections.ts` (a contract M7 and
a future dashboard consume). Expose them as **admin-gated read endpoints** in
`apps/ingest/src/routes/projections.ts`, mirroring the M5 `routes/projects.ts` admin pattern exactly. No
migration, no wire/fingerprint/encryption/parse change, no collector change.

## Feature Metadata

**Feature Type**: New Capability (deterministic projection/metrics layer over the event log)
**Estimated Complexity**: Low-Medium. **Lowest-risk milestone to date** — zero schema/migration change,
zero capture-surface change, read-only, reuses the proven M5 join + frozen `@420ai/shared` arithmetic.
The only novelty is jsonb aggregation SQL in Drizzle `sql` templates (one small spike retires it).
**Primary Systems Affected**: `packages/db` (1 new repository + its int test; barrel export),
`apps/ingest` (1 new route file + registration + int-test additions), `packages/shared` (projection
result types + the promoted `lowestConfidence`). **No dashboard. No migration. No collector change.**
**Dependencies**: none new. `drizzle-orm` `sql` template (already used in `workspaces.ts:136`), Fastify
(already present). Node ≥ 24.

---

## PRE-FLIGHT VERIFICATION (grounded against the M5 codebase this session)

The novel risk in M6 is "can we aggregate the jsonb `tokens`/`cost` columns and group event shape in
Drizzle, attributed by the M5 join, reading only plaintext." The structural half is **[VERIFIED] in the
codebase**; the residual half is a thin SQL-dialect check (one spike).

1. **The attribution join + `count()::int` + `max(ts)` already work in a Drizzle `sql` template —
   [VERIFIED].** `packages/db/src/repositories/workspaces.ts:136-150` (`projectEventSummary`) does
   exactly `.from(events).innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
   .innerJoin(workspaces, …).where(eq(workspaces.projectId, projectId))` with
   `sql<number>\`count(${events.fingerprint})::int\`` and `sql<Date|null>\`max(${events.ts})\``. M6's
   project-scoped projections are this join + more aggregate columns. The `::int` cast → JS `number` is
   proven.
2. **The plaintext columns M6 reads exist and are queryable — [VERIFIED].** `schema.ts:96-129`: `events`
   has `eventType`, `sessionId`, `machineId`, `projectPath`, `gitBranch`, `model`,
   `ts (timestamptz, mode:"string")`, `tokens jsonb $type<NormalizedTokens>`, `cost jsonb
   $type<CostResult>`, `parserVersion`, `sourceConnector`. The header comment (lines 22-28) confirms
   these are the **PLAINTEXT (queryable)** set; payload_* are the only ciphertext columns and M6 never
   reads them. `index("events_by_project_path")` (line 127) backs the join; `index("events_by_session")`
   on `(sessionId, ts)` (line 123) backs the session grouping.
3. **The token/cost arithmetic to reuse is frozen and pure — [VERIFIED].** `@420ai/shared`:
   `zeroTokens()` / `addTokens()` / `computeTotal()` (`tokens.ts:21-48`) and `CostConfidence` +
   `CostResult` (`cost.ts:14-26`). `computeTotal = input+output+cache_read+cache_write` (excludes
   reasoning/tool by design — `tokens.ts:42-48`); **token aggregation in M6 must use the same four
   sub-types** so totals match the M1 report.
4. **`lowestConfidence` already exists — as a PRIVATE copy in the M1 report — [VERIFIED].**
   `apps/collector/src/report/session-report.ts:13-26` defines `CONFIDENCE_ORDER` +
   `lowestConfidence(labels)`. M6 promotes it to `@420ai/shared/cost.ts` and the M1 report imports it
   back (dedup; no behavior change). **Confirm it is the only copy:** `grep -rn lowestConfidence` should
   hit only `session-report.ts` before the move.
5. **The admin-gated read-route pattern is proven — [VERIFIED].** `apps/ingest/src/routes/projects.ts`
   (esp. the `GET /v1/projects/:id/summary` handler, lines 73-85) wraps `projectEventSummary` behind
   `adminAuthorized(app, request)` (→ 401), `isUuid(request.params.id)` (→ 404 not a cast-500), resolves
   the single-user `userId` via `findUserIdByEmail` / `ensureUserByEmail` (`projects.ts:13,33,46`). M6's
   routes copy this verbatim.
6. **The int-test harness is proven — [VERIFIED].** `apps/ingest/src/app.int.test.ts` builds the app
   in-process (`buildApp`), `TRUNCATE … RESTART IDENTITY CASCADE` per test (line 46-48), pairs a machine
   (helpers lines 51-70), ingests via `POST /v1/ingest`, and already drives discover→attribute→summary
   (lines 235-298). M6 adds events with `tokens`/`cost`/varied `event_type` and asserts the new
   endpoints' numbers. Note the TRUNCATE list must include any new tables — **M6 adds none**, so it is
   unchanged.

**Residual risk (retire with the spike below):** the exact Drizzle `sql` spelling for (a) jsonb numeric
extraction `sum((${events.tokens} ->> 'input')::bigint)::int`, (b) conditional aggregates
`count(*) filter (where ${events.eventType} = 'message.user')::int`, (c) `array_agg(distinct
${events.cost} ->> 'confidence')` for the confidence reduction, and (d) `date_trunc('day',
${events.ts}::timestamptz)` for over-time bucketing. All are standard Postgres; the only risk is template
spelling and the text→number cast. Covered by the spike + the int test asserting exact totals.

### Recommended quick spike (≤10 min, before Task 3 — retires the only residual risk)

With the test DB up (`npm run db:up && npm run db:migrate`), in a scratch `*.int.test.ts` or `psql`,
insert two `usage.reported` events with known `tokens` jsonb and one `cost.estimated` with a known
`cost.usd`, then run the jsonb-sum + `filter` + `array_agg` expressions once and confirm: the sums equal
the hand-computed totals, the cast yields a JS `number` (not a string), and `array_agg(distinct …)`
returns a `string[]`. Lock the exact `sql` spelling into Task 3 from what passes. (The structural join is
already proven by `projectEventSummary` — this only validates the new aggregate columns.)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/db/src/repositories/workspaces.ts` (esp. `projectEventSummary`, lines 136-150; the join
  pattern lines 144-148) — Why: the **exact** join + `sql` aggregate template M6 extends. Every
  project-scoped projection is this join with more columns. Mirror `count(...)::int` / `max(ts)` and the
  `userId`-scoping discipline (the comment at lines 5-12).
- `packages/db/src/schema.ts` (lines 96-129 `events`; lines 122-128 the two indexes; header lines 22-28
  encryption split) — Why: the exact column names M6 reads, their types, and WHICH are plaintext. Read
  the `events_by_project_path` and `events_by_session` index rationale — M6's queries are designed to use
  them. **Do NOT add columns or indexes** (no migration).
- `packages/db/src/repositories/ingest.ts` (lines 49-87) — Why: shows how `tokens`/`cost` land in the
  jsonb columns (`tokens: e.tokens`, `cost: e.cost`) and that events without usage store NULL tokens —
  so M6 sums MUST be NULL-safe (`coalesce`, and `filter (where event_type='usage.reported')`).
- `packages/db/src/repositories/projects.ts` (whole file) — Why: the repository style M6 mirrors (typed
  `Row` interfaces, `eq`/`and`/`desc` from `drizzle-orm`, silent/throwing, `userId`-scoped, `.returning`).
- `packages/db/src/index.ts` (lines 25-42) — Why: the barrel re-exports every table + repository fn +
  `Row` type. Add the projection fns and result types here (the ingest app imports from `@420ai/db`,
  never deep paths).
- `apps/ingest/src/routes/projects.ts` (whole file — esp. `/summary`, lines 73-85; admin gate lines
  30-32; userId resolution lines 33,46; `isUuid` guard lines 64,79) — Why: the **template** for every M6
  route. Copy the admin-gate + uuid-guard + single-user-userId-resolution verbatim.
- `apps/ingest/src/auth.ts` (`adminAuthorized` lines 11-18, `isUuid` lines 27-29) — Why: the shared
  guards M6 routes reuse. Do NOT re-implement either.
- `apps/ingest/src/app.ts` (lines 26-39 registration; 41-54 error handler) — Why: register
  `projectionRoutes` alongside the others. M6 adds no new typed error (read-only; bad input → 400/404 via
  guards) — the generic handler suffices.
- `apps/ingest/src/app.int.test.ts` (harness lines 30-70; the attribute-via-summary test lines 235-298)
  — Why: the int-test template. M6 extends it: ingest events carrying `tokens`/`cost`/varied
  `event_type`, then assert the projection endpoints' exact numbers. The `TRUNCATE` list (lines 46-48)
  needs **no change** (no new tables).
- `apps/ingest/src/schemas.ts` (whole file) — Why: the plain-JSON-schema style if you validate any
  querystring (e.g. `?bucket=day`, `?by=model`). Most M6 endpoints are param-less GETs; add a tiny
  querystring schema ONLY where you accept a query param, in this exact `as const` style.
- `packages/shared/src/cost.ts` (lines 14-63) + `packages/shared/src/tokens.ts` (lines 10-48) — Why: the
  frozen arithmetic M6 reuses, and the file `lowestConfidence` is promoted INTO (`cost.ts`). Read
  `computeTotal`'s four-sub-type definition — M6 token sums must match it.
- `packages/shared/src/events.ts` (lines 19-32 `EventType`; 50-65 `NormalizedEvent`) — Why: the canonical
  event-type strings M6's `filter (where event_type = …)` clauses must match BYTE-FOR-BYTE
  (`"message.user"`, `"tool.call.failed"`, `"usage.reported"`, `"cost.estimated"`, …). A typo silently
  yields 0.
- `apps/collector/src/report/session-report.ts` (lines 13-71) — Why: the SOURCE of `lowestConfidence`
  (promote it) AND the canonical session-aggregation shape M6's session projection mirrors (token sum
  over `usage.reported`, cost sum over `cost.estimated`, the message/tool/file counts lines 63-71). Keep
  the server projection's field names consistent with what this report already computes.
- `packages/shared/src/discovery.ts` + `packages/shared/src/index.ts` — Why: the plain-interface wire-type
  style M6's `projections.ts` mirrors, and how new shared types get exported from the barrel.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/PRD.md` §16.1 (Deterministic Metrics Pipeline — M6 IS this), §14 (metric categories — build the
  ones with source data: cost-over-time, token efficiency inputs, tool-call failures, connector health;
  the failure **classification** taxonomy in §14 is M7+ unless trivially derivable), §13.1/§13.3 (token
  sub-types + the cost-confidence ladder M6 aggregates with lowest-wins), §10.1.1 (connector liveness —
  "last event N seconds ago", which the health projection computes), §11.3 (Git **metadata** — note M6
  only projects on-event git fields per Scope Decision 1; commit capture is deferred), §12/§23 (the
  fingerprint + "events are disposable projections" principle that justifies on-demand recompute), §8.5
  (volume — why on-demand beats materialized), §18.1 (the plaintext-queryable set M6 is restricted to).
- `docs/CONTEXT.md` — canonical terms to name code after: **Deterministic Metrics Pipeline**, **Event
  Log**, **Tool-Native Session**, **Token Efficiency**, **Tool Call Failure**, **Connector Fidelity**,
  **Cost Confidence**, **Project**, **Workspace**.
- `.agents/plans/m5-project-workspace-mapping.md` — Why: the immediately-prior milestone; M6 is "M5-shaped
  minus the migration." Mirror its route/repo/int-test discipline and its D5 ("attribution is a JOIN")
  reasoning — M6 is the materialization-at-read-time D5 promised.
- `.agents/plans/m2-archive-deployment.md` — Why: the Fastify route + int-test conventions baseline.
- `.agents/system-reviews/milestones-1-3-review.md` — Why: the enforced gates (repo-root `tsc -b`, full
  vitest, NUL scan, stray-artifact scan; no per-workspace-build substitution; snippet↔spike fidelity).
- Drizzle ORM `sql` operator + aggregations: https://orm.drizzle.team/docs/sql ,
  https://orm.drizzle.team/docs/select#aggregations — Why: the `sql<T>` template + cast spelling.
- Postgres JSON operators (`->>`, casts) + `date_trunc` + aggregate `FILTER`:
  https://www.postgresql.org/docs/current/functions-json.html ,
  https://www.postgresql.org/docs/current/functions-aggregate.html — Why: get the aggregate SQL exactly
  right (the residual risk).

### New Files to Create

```
packages/shared/src/
  projections.ts                 # SessionProjection, SessionDetail, UsageTotals, UsageByModelRow,
                                  #   UsageOverTimeRow, ConnectorHealthRow, ProjectGitMetadata result types
  projections.test.ts            # pure tests for any helper added here (e.g. lowestConfidence re-export
                                  #   sanity); arithmetic is tested in cost.test.ts/tokens.test.ts
packages/db/src/repositories/
  projections.ts                 # sessionProjections, sessionDetail, usageTotals, usageByModel,
                                  #   usageOverTime, connectorHealth, projectGitMetadata (read-only)
  projections.int.test.ts        # skipIf(!DATABASE_URL_TEST): seed events, assert exact aggregates
apps/ingest/src/routes/
  projections.ts                 # admin-gated GET endpoints (see route list in D6)
```

### Files to MODIFY

```
packages/shared/src/cost.ts        # ADD CONFIDENCE_ORDER + lowestConfidence (promoted from session-report)
packages/shared/src/index.ts       # export lowestConfidence + the projection result types
packages/db/src/index.ts           # export the projection repository fns + their Row/result types
apps/ingest/src/routes/...         # (new projections.ts registered in app.ts)
apps/ingest/src/app.ts             # app.register(projectionRoutes)
apps/ingest/src/schemas.ts         # ADD querystring schema(s) ONLY if a route takes ?bucket/?by params
apps/ingest/src/app.int.test.ts    # ADD projection-endpoint assertions (seed tokens/cost/varied types)
apps/collector/src/report/session-report.ts  # IMPORT lowestConfidence from @420ai/shared (delete local copy)
README.md                          # bump Status; brief M6 note (do not re-paste conventions)
```

> **No file under `packages/db/drizzle/` is created or edited — M6 adds no migration.** If `npm run
> db:generate` would emit one, your schema changed by accident; revert it.

### Patterns to Follow

**Promote the confidence ladder (dedup — mirror the existing private copy exactly):**
```ts
// packages/shared/src/cost.ts — ADD (these are LIFTED verbatim from session-report.ts:13-26)
/** Cost-confidence ladder, best → worst. The lowest-confidence label in a mixed
 *  aggregate wins — an aggregate is only as trustworthy as its weakest component. */
export const CONFIDENCE_ORDER: CostConfidence[] = [
  "exact",
  "estimated-model-known",
  "estimated-model-unknown",
  "subscription-amortized",
  "unknown",
];
export function lowestConfidence(labels: CostConfidence[]): CostConfidence {
  if (labels.length === 0) return "unknown";
  return labels.reduce((worst, c) =>
    CONFIDENCE_ORDER.indexOf(c) > CONFIDENCE_ORDER.indexOf(worst) ? c : worst,
  );
}
```
> **Spike-snippet fidelity:** this MUST be byte-identical in behavior to
> `apps/collector/src/report/session-report.ts:13-26`. After moving it, `session-report.ts` imports
> `{ lowestConfidence }` from `@420ai/shared` and DELETES its local copy + `CONFIDENCE_ORDER`. The
> existing `session-report.test.ts` (if any) must still pass unchanged — proof the move is behavior-
> preserving.

**Projection result types (mirror `packages/shared/src/discovery.ts` plain-interface style):**
```ts
// packages/shared/src/projections.ts
import type { NormalizedTokens } from "./tokens.js";
import type { CostConfidence } from "./cost.js";

/** One tool-native session, reconstructed from its events (PRD §15 autopsy precursor). */
export interface SessionProjection {
  sessionId: string;
  sourceConnector: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[];                 // distinct, nulls dropped
  startedAt: string | null;         // min(ts) — ISO string (events.ts is mode:"string")
  endedAt: string | null;           // max(ts)
  eventCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;                // event_type LIKE 'tool.call.%'
  toolsCompleted: number;
  toolsFailed: number;
  filesRead: number;
  filesModified: number;
  tokens: NormalizedTokens;         // summed over usage.reported (subtypes; total recomputed)
  costUsd: number;                  // summed over cost.estimated
  costConfidence: CostConfidence;   // lowest-wins across the session's cost events
}
export interface UsageTotals {
  tokens: NormalizedTokens;
  costUsd: number;
  costConfidence: CostConfidence;
  eventCount: number;
}
export interface UsageByModelRow { model: string | null; tokens: NormalizedTokens; costUsd: number; }
export interface UsageOverTimeRow { bucket: string; tokens: NormalizedTokens; costUsd: number; }
export interface ConnectorHealthRow {
  sourceConnector: string;
  lastEventAt: string | null;
  eventCount: number;
  toolsFailed: number;
  parserVersions: string[];
  models: string[];
}
export interface ProjectGitMetadata {
  branches: string[];               // distinct git_branch on the project's events
  projectPaths: string[];           // distinct project_path keys mapped to the project
}
export type SessionDetail = SessionProjection; // M6 = same shape; M7 may extend with per-tool breakdowns
```

**Read-only aggregate repository (mirror `projectEventSummary` — workspaces.ts:136):**
```ts
// packages/db/src/repositories/projections.ts (illustrative — confirm sql spelling via the spike)
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { events, workspaceKeys, workspaces } from "../schema.js";
import { lowestConfidence, zeroTokens, type CostConfidence } from "@420ai/shared";

// Reusable jsonb token-sum SQL columns, NULL-safe + restricted to usage.reported.
// computeTotal sums the SAME four subtypes — keep them in lockstep (tokens.ts:42-48).
const tokenSum = (field: "input" | "output" | "cache_read" | "cache_write") =>
  sql<number>`coalesce(sum((${events.tokens} ->> ${field})::bigint) filter (where ${events.eventType} = 'usage.reported'), 0)::int`;

/** Per-project token + cost totals (the on-demand version of D5, scaled to metrics). */
export async function usageTotals(db: DbClient, projectId: string): Promise<UsageTotals> {
  const [row] = await db
    .select({
      input: tokenSum("input"), output: tokenSum("output"),
      cacheRead: tokenSum("cache_read"), cacheWrite: tokenSum("cache_write"),
      costUsd: sql<number>`coalesce(sum((${events.cost} ->> 'usd')::numeric) filter (where ${events.eventType} = 'cost.estimated'), 0)`,
      confidences: sql<string[]>`coalesce(array_agg(distinct ${events.cost} ->> 'confidence') filter (where ${events.eventType} = 'cost.estimated'), '{}')`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId));
  const t = zeroTokens();
  t.input = row?.input ?? 0; t.output = row?.output ?? 0;
  t.cache_read = row?.cacheRead ?? 0; t.cache_write = row?.cacheWrite ?? 0;
  t.total = t.input + t.output + t.cache_read + t.cache_write; // == computeTotal
  return {
    tokens: t,
    costUsd: Number(row?.costUsd ?? 0),
    costConfidence: lowestConfidence((row?.confidences ?? []) as CostConfidence[]),
    eventCount: row?.eventCount ?? 0,
  };
}
```
> **GOTCHAs baked in above:** (1) `filter (where event_type='usage.reported')` so message/tool events
> (NULL tokens) don't poison the sum; (2) `coalesce(…, 0)` so an empty project returns 0 not NULL;
> (3) sum the four subtypes and **recompute `total`** (don't trust a possibly-stale stored `total`) — it
> equals `computeTotal` by construction; (4) `::numeric` for USD (fractional), `::int` for token counts;
> (5) confidence is reduced in TS with the shared ladder, NOT in SQL; (6) `array_agg … filter` returns
> `'{}'` (empty) when no cost rows — `lowestConfidence([])` → `"unknown"`, correct.

**Session projection (group by session_id, conditional counts):**
```ts
// count(*) filter (where event_type = 'message.user')::int  → userMessages
// count(*) filter (where event_type like 'tool.call.%')::int → toolCalls
// count(*) filter (where event_type = 'tool.call.failed')::int → toolsFailed
// min(ts) / max(ts) → startedAt / endedAt ; array_agg(distinct model) filter (where model is not null)
// ...group by events.sessionId; for a single session, add .where(eq(events.sessionId, id))
```

**Over-time bucketing:** `date_trunc('day', ${events.ts}::timestamptz)` as the group key (cast because
`ts` is `mode:"string"`). Return the bucket as an ISO string.

**Admin-gated read route (mirror `routes/projects.ts:73-85` EXACTLY):**
```ts
app.get<{ Params: { id: string } }>("/v1/projects/:id/usage", async (request, reply) => {
  if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
  if (!isUuid(request.params.id)) return reply.code(404).send({ error: "project not found" });
  return reply.code(200).send(await usageTotals(app.db, request.params.id));
});
```

**Library files never log / `process.exit`** (CLAUDE.md): the projections repo is silent and pure-read
(throws on DB error, never logs); only the Fastify error handler surfaces anything. Inject `db` so int
tests pass a test-DB client (mirror every existing repo).

---

## KEY DESIGN DECISIONS (read before coding)

### D1 — Pure read-only projection layer; ZERO schema/capture change
M6 adds query repositories + read endpoints only. It does not alter `events`, add tables/indexes/
migrations, change the fingerprint, the wire types, the encryption split, any connector `parse`, or the
collector. If `npm run db:generate` produces a migration, something changed by accident — revert. This is
what keeps M6 the lowest-risk milestone and what backs the >9 confidence.

### D2 — On-demand SQL aggregation, not materialized rollups (Scope Decision 2)
Projections are computed at read time over `events`, extending `projectEventSummary`'s join. At PRD
§8.5 volume (single-digit GB/year) and with the `events_by_project_path` / `events_by_session` indexes,
this is fast and always consistent. Materialized tables would add refresh/staleness/backfill code and a
migration for no V1 benefit. (If a real perf problem ever appears, a materialized view is a future drop-in
behind the same repository function signature — nothing here is thrown away.)

### D3 — Read ONLY plaintext columns; never decrypt (PRD §18.1)
Every projection selects from the queryable-plaintext set (`ts`, `event_type`, `model`, `tokens`, `cost`,
`project_path`, `git_branch`, `source_connector`, `session_id`, `machine_id`, `parser_version`). It never
touches `payload_ciphertext`/`_iv`/`_tag` and never calls `decryptField`. A projection therefore cannot
leak message bodies or tool I/O — privacy holds by construction.

### D4 — Attribution = the M5 join, scoped by userId; unattributed never errors
Project-scoped projections join `events.project_path = workspace_keys.project_key` → `workspaces` →
`projects` (the exact `projectEventSummary` join), filtered to `workspaces.project_id = :projectId`.
Events whose `project_path` is unmapped (e.g. Gemini hash-only sessions) simply don't join — they're
absent from project rollups, not an error. (A global "unattributed usage" projection is a possible later
add; M6 keeps project-scoped + global-by-connector, which is enough for M7.)

### D5 — Token sums use the four sub-types and recompute `total`; confidence reduces in TS
Aggregate `input/output/cache_read/cache_write` via jsonb sum and set `total = Σ subtypes` (==
`computeTotal`, `tokens.ts:42-48`) — never sum the stored `total` (avoids trusting a possibly-stale
value and matches the M1 report). `reasoning`/`tool` are 0 in V1 and excluded from `total` by design.
Cost USD sums in SQL; the **confidence label** is computed in TS via the promoted `lowestConfidence` over
the distinct labels SQL returns (lowest-wins, PRD §13.3).

### D6 — Endpoint surface: admin-gated GET, project- or session-scoped (mirror routes/projects.ts)
```
GET /v1/projects/:id/sessions          → SessionProjection[]   (sessions in a project, newest first)
GET /v1/projects/:id/usage             → UsageTotals           (token+cost totals for a project)
GET /v1/projects/:id/usage/by-model    → UsageByModelRow[]     (tool/model comparison input, PRD §14)
GET /v1/projects/:id/usage/over-time   → UsageOverTimeRow[]    (?bucket=day|week; default day — cost-over-time)
GET /v1/projects/:id/git               → ProjectGitMetadata    (distinct branches + project_path keys)
GET /v1/sessions/:sessionId            → SessionDetail         (single session shape; sessionId is text)
GET /v1/connectors/health              → ConnectorHealthRow[]  (global per user; last-event-age etc.)
```
All admin-gated (`adminAuthorized` → 401). Project routes guard `:id` with `isUuid` → 404. `:sessionId`
is a connector text id (NOT a uuid) — no `isUuid` guard; an unknown id returns an empty/zeroed projection
(200), not 404. Resolve the single-user `userId` via `findUserIdByEmail`/`ensureUserByEmail` exactly as
`routes/projects.ts` does, where a query needs it (connector-health and any global query are
`userId`-scoped through `workspaces`/`workspace_keys`; project-scoped queries are already bounded by the
`projectId`'s ownership — but still resolve and assert `userId` for defense per the workspaces.ts
"scope EVERY query by userId" rule).

### D7 — Git metadata = projection of existing fields only (Scope Decision 1)
`ProjectGitMetadata` returns the distinct `git_branch` values on the project's events and the distinct
`project_path` keys mapped to it. No `git log`, no commit/diff events, no outcome attribution. PRD §11.3's
richer commit metadata (hash/author/changed-files/line-counts) requires a capture surface that M6 does
not build.

### D8 — Connector health is derived (Scope Decision 3)
`connectorHealth` groups all of a user's events by `source_connector`: `max(ts)` (→ `lastEventAt`;
"last event N seconds ago" is computed by the *consumer* relative to now — the projection returns the
timestamp, staying pure/clock-free per the inject-clocks convention), `count`, `tool.call.failed` count,
distinct `parser_version` and `model`. No `connector.health` event emission (M9).

---

## IMPLEMENTATION PLAN

### Phase 1: Shared contracts
Promote `lowestConfidence` to `@420ai/shared/cost.ts`; add `projections.ts` result types; export both
from the barrel. Update the M1 report to import the promoted helper (dedup).

### Phase 2: Projection repository (`@420ai/db`)
Add the read-only aggregation functions extending `projectEventSummary`'s join. Pure SQL; `userId`-scoped;
NULL-safe sums; confidence reduced in TS. Export from the barrel. (Run the spike before writing the SQL.)

### Phase 3: Server surface (`apps/ingest`)
Add the admin-gated GET endpoints (D6), register the route plugin, add any querystring schema.

### Phase 4: Tests, validation, docs
Pure shared tests + Postgres-gated int tests (db repo + ingest endpoints, asserting EXACT aggregates) +
the full `repo-health` gate + README.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Run each task's VALIDATE before moving on. (Run the "Recommended quick
spike" before Task 3.)

### Task 1 — UPDATE `packages/shared/src/cost.ts`: promote `lowestConfidence` + `CONFIDENCE_ORDER`
- **IMPLEMENT**: add `CONFIDENCE_ORDER` + `lowestConfidence(labels)` per "Patterns to Follow" (behavior
  identical to `session-report.ts:13-26`).
- **PATTERN**: `packages/shared/src/cost.ts` existing exports; keep `packages/shared` dependency-free.
- **VALIDATE**: `npm run -w @420ai/shared build` (exit 0).

### Task 2 — UPDATE `apps/collector/src/report/session-report.ts`: consume the promoted helper
- **REMOVE** the local `CONFIDENCE_ORDER` + `lowestConfidence` (lines 13-26); **IMPORT**
  `{ lowestConfidence }` from `@420ai/shared`. No other behavior change.
- **GOTCHA**: first `grep -rn "lowestConfidence" apps packages` to confirm `session-report.ts` is the
  only definition before deleting (PRE-FLIGHT #4). Keep `fmtUsd` local — it is report-only.
- **VALIDATE**: `npm test -w @420ai/collector -- session-report` (existing report tests pass unchanged);
  `npm run typecheck` (exit 0).

### Task 3 — CREATE `packages/shared/src/projections.ts` (+ export from `index.ts`)
- **IMPLEMENT**: the result interfaces in "Patterns to Follow" (`SessionProjection`, `SessionDetail`,
  `UsageTotals`, `UsageByModelRow`, `UsageOverTimeRow`, `ConnectorHealthRow`, `ProjectGitMetadata`).
  Export all from `packages/shared/src/index.ts`. Add `packages/shared/src/projections.test.ts` only if
  you add a pure helper here (otherwise the arithmetic is covered by `cost.test.ts`/`tokens.test.ts` and
  the db int test — do not write a vacuous test).
- **GOTCHA**: types only; import `NormalizedTokens`/`CostConfidence` with `import type`. Keep shared
  dependency-free.
- **VALIDATE**: `npm run -w @420ai/shared build && npm test -w @420ai/shared` (exit 0).

### Task 4 — CREATE `packages/db/src/repositories/projections.ts`
- **IMPLEMENT** (read-only; mirror `projectEventSummary`'s join + `sql` aggregates; use the spike-verified
  spelling):
  - `usageTotals(db, projectId): Promise<UsageTotals>` — per "Patterns to Follow".
  - `usageByModel(db, projectId): Promise<UsageByModelRow[]>` — same join, `group by events.model`.
  - `usageOverTime(db, projectId, bucket: "day"|"week"): Promise<UsageOverTimeRow[]>` — `group by
    date_trunc(:bucket, ts::timestamptz)`, ordered ascending.
  - `sessionProjections(db, projectId): Promise<SessionProjection[]>` — join + `group by
    events.sessionId, sourceConnector, projectPath, gitBranch`, conditional counts, ordered by `max(ts)`
    desc.
  - `sessionDetail(db, sessionId): Promise<SessionDetail>` — same aggregate but `.where(eq(events.sessionId,
    sessionId))` (NO project join — a session is identified directly); returns a zeroed projection if no
    rows.
  - `connectorHealth(db, userId): Promise<ConnectorHealthRow[]>` — join `events`→`workspace_keys`→
    `workspaces` filtered by `workspaces.userId = userId` (so it is the user's connectors), `group by
    source_connector`. (If simpler and still correct, group all events by connector — but scope by userId
    via the join to honor multi-user-capable schema.)
  - `projectGitMetadata(db, projectId): Promise<ProjectGitMetadata>` — distinct `git_branch` + distinct
    `project_key` for the project.
- **PATTERN**: `repositories/workspaces.ts:136-150` (join + `sql` aggregates), `repositories/projects.ts`
  (typed returns, `eq`/`and`/`desc`). Silent library — throws, never logs.
- **GOTCHA**: every project-scoped query uses the D4 join; sums are NULL-safe + `filter`ed by event_type
  (D5); recompute `total` from subtypes; reduce confidence in TS. Cast text→number (`::int`/`::numeric`)
  and wrap USD in `Number(...)`. Match event-type strings to `events.ts` byte-for-byte.
- **VALIDATE**: `npm run typecheck` (exit 0); covered by Task 6 int test.

### Task 5 — UPDATE `packages/db/src/index.ts`: export the projection repo
- **IMPLEMENT**: export all Task 4 functions from the barrel (the ingest app imports from `@420ai/db`).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 6 — CREATE `packages/db/src/repositories/projections.int.test.ts`
- **IMPLEMENT** (`describe.skipIf(!process.env.DATABASE_URL_TEST)`, mirror `workspaces.int.test.ts`):
  seed a user + workspace + `workspace_keys` + a handful of `events` with KNOWN `tokens` jsonb (two
  `usage.reported`), KNOWN `cost` jsonb (two `cost.estimated` with different confidences), plus
  `message.user`/`message.assistant`/`tool.call.completed`/`tool.call.failed`/`file.read`/`file.modified`
  events sharing a `session_id` and `project_path`. Assert:
  - `usageTotals` returns the hand-summed token subtypes, `total = Σ subtypes`, summed `costUsd`, and the
    **lowest** confidence of the two cost events; empty project → all zeros + `"unknown"`.
  - `usageByModel` splits correctly across two models; `usageOverTime("day")` buckets by day.
  - `sessionProjections`/`sessionDetail` return the exact message/tool/file counts, `toolsFailed`,
    distinct models, and min/max ts.
  - `connectorHealth` returns `lastEventAt = max(ts)`, the failure count, and distinct parser versions.
  - `projectGitMetadata` returns the distinct branches.
- **GOTCHA**: int tests import across boundaries and are EXCLUDED from `tsc -b` (`packages/db/tsconfig.json`
  already excludes `*.int.test.ts` per the M5 precedent — confirm) and self-skip without
  `DATABASE_URL_TEST`. Insert events directly (or via `ingestBatch`); if direct, remember the server
  encrypts payloads but M6 reads none — you can insert NULL payload columns.
- **VALIDATE**: `npm test` (self-skips, exit 0) AND with DB up:
  `DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test` (passes).

### Task 7 — CREATE `apps/ingest/src/routes/projections.ts` (+ querystring schema if needed)
- **IMPLEMENT** the D6 endpoints, each admin-gated (`adminAuthorized` → 401), project routes
  `isUuid`-guarded (→ 404), `:sessionId` ungated (text id). Resolve `userId` via
  `findUserIdByEmail`/`ensureUserByEmail` where a query needs it (connector-health). For
  `usage/over-time`, accept `?bucket=day|week` (default `day`) validated by a small `as const` querystring
  schema in `schemas.ts` (mirror the existing schema style); reject other values.
- **PATTERN**: `routes/projects.ts` verbatim (admin gate + uuid guard + userId resolution + 200 send).
- **GOTCHA**: read-only — no new typed error; bad input is handled by the guards (400/404). Do NOT add a
  preHandler machine-auth (these are admin/dashboard reads, like the project CRUD).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 8 — UPDATE `apps/ingest/src/app.ts`: register the route plugin
- **IMPLEMENT**: `import projectionRoutes from "./routes/projections.js";` and
  `app.register(projectionRoutes);` after `workspaceRoutes`. No error-handler change.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 9 — UPDATE `apps/ingest/src/app.int.test.ts`: projection-endpoint assertions
- **IMPLEMENT** (extend the existing suite, `skipIf(!DATABASE_URL_TEST)`): pair → discover (reuse the
  existing `discoverPayload`) → ingest a batch of events carrying `tokens`/`cost`/varied `event_type` for
  the discovered `project_path` → `GET /v1/projects` to get the id → assert:
  - `GET /v1/projects/:id/usage` returns the expected token total + cost + confidence.
  - `GET /v1/projects/:id/sessions` lists the session with correct counts.
  - `GET /v1/sessions/:sessionId` returns the same session's detail.
  - `GET /v1/connectors/health` lists the connectors with a `lastEventAt`.
  - All five 401 without the admin token; a non-uuid project id → 404 (not 500).
- **GOTCHA**: the `TRUNCATE` list (lines 46-48) needs NO change (M6 adds no tables). Use ISO `ts` strings
  like the existing tests (`"2026-06-14T00:00:00.000Z"`).
- **VALIDATE**: `npm test` (self-skips) / with DB: full int passes.

### Task 10 — UPDATE README "Status" + run the gate
- **UPDATE** README Status: M6 added the deterministic projection layer (sessions/usage/cost/connector-
  health/git-metadata) as admin-gated read endpoints over the event log — on-demand, no migration, no
  capture change; reporting/Markdown artifacts deferred to M7. Brief — do not re-paste conventions.
- **VALIDATE (the gate)**: `npm run repo-health` (root `tsc -b` + full `vitest run` + NUL-byte scan +
  stray-artifact scan; exit 0). With DB up, also run the Postgres-gated int suite (Level 3 below).

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, no infra — always run)
- `packages/shared`: `lowestConfidence` ladder (if not already covered by `cost.test.ts`, add cases:
  empty → `"unknown"`; mixed → worst wins). `tokens.test.ts`/`cost.test.ts` already cover the arithmetic
  M6 reuses — no duplication.
- `apps/collector`: `session-report` tests pass unchanged after the import swap (proof the promotion is
  behavior-preserving).

### Integration Tests (`*.int.test.ts`, `DATABASE_URL_TEST`-gated, excluded from `tsc -b`)
- `packages/db/.../projections.int.test.ts`: seed known events → assert EXACT aggregates for every
  projection function (the numbers are the contract — hand-compute them in the test).
- `apps/ingest/.../app.int.test.ts` additions: the discover→ingest→project endpoints round-trip; admin
  401s; uuid-guard 404s.

### Edge Cases (must be covered)
- **Empty project** (no matching events) → `usageTotals` all-zero tokens, `costUsd: 0`,
  `costConfidence: "unknown"`; `sessionProjections` `[]`; no throw.
- **Mixed confidence** in one project/session → lowest wins (e.g. one `estimated-model-known` + one
  `estimated-model-unknown` → `"estimated-model-unknown"`).
- **Events with NULL tokens** (message/tool events) do NOT poison token sums (the `filter` clause).
- **Unattributed events** (Gemini hash with no `workspace_keys` row) → absent from project rollups, not an
  error; still counted in `connectorHealth` (global by connector).
- **Unknown `:sessionId`** → zeroed `SessionDetail` (200), not 404.
- **Non-uuid project `:id`** → 404, not a Postgres cast 500 (the `isUuid` guard).
- **`?bucket` other than day/week** → 400 (querystring schema).
- **Idempotent re-ingest** before projecting → counts reflect deduped events (fingerprint upsert), i.e.
  re-ingesting the same batch does NOT double the totals (assert this — it ties M6 to the PRD §23
  invariant).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with the stated pass signal.

### Level 1: Typecheck / Build (repo-root — catches cross-project + test-only imports)
- `npm run typecheck` → root `tsc -b`, **exit 0**. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests
- `npm test` → full `vitest run`; units always run, `*.int.test.ts` self-skip without `DATABASE_URL_TEST`.
  **All pass, exit 0.**
- Focused: `npm test -w @420ai/shared`; `npm test -w @420ai/collector -- session-report`.

### Level 3: Integration Tests (Postgres)
- `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test`
  → the db-repo projection int test + the ingest endpoint int tests pass. **Exit 0.** (No new migration
  to apply — confirm `db:migrate` is a no-op beyond M5's `0001`.)

### Level 4: Manual Validation (real data, read-only)
- With a paired + discovered archive carrying real captured sessions, start the API
  (`npm run ingest:dev`), then with the admin token:
  - `curl -s localhost:8420/v1/projects -H "authorization: Bearer $ADMIN_TOKEN"` → pick a project id.
  - `curl -s localhost:8420/v1/projects/<id>/usage -H "authorization: Bearer $ADMIN_TOKEN"` → non-zero
    tokens + a sane USD + a confidence label for a project you actually used.
  - `.../usage/by-model`, `.../usage/over-time?bucket=day`, `.../sessions`, `.../git`, and
    `localhost:8420/v1/connectors/health` → values consistent with your real usage; connector
    `lastEventAt` is recent for tools you use.
- Spot-check the totals against the M1 `collector report <session-uuid>` for the same session — the token
  total should match (same arithmetic, now server-side).

### Level 5: The enforced gate
- `npm run repo-health` → typecheck + full vitest + NUL-byte scan + stray-artifact scan. **Exit 0.**
  Pre-commit hook runs the fast subset. Confirm **no migration file appeared** under `packages/db/drizzle/`
  (M6 adds none) and no stray emitted JS/d.ts.

---

## ACCEPTANCE CRITERIA

- [ ] `lowestConfidence` + `CONFIDENCE_ORDER` live in `@420ai/shared/cost.ts`; `session-report.ts` imports
      them and its tests pass unchanged (behavior-preserving dedup).
- [ ] `@420ai/shared/projections.ts` defines the projection result shapes and they are exported from the
      barrel.
- [ ] `projections.ts` repository computes — read-only, via the M5 join, NULL-safe, plaintext-only:
      `usageTotals`, `usageByModel`, `usageOverTime`, `sessionProjections`, `sessionDetail`,
      `connectorHealth`, `projectGitMetadata`; token `total` recomputed from the four subtypes; cost
      confidence is lowest-wins.
- [ ] Admin-gated GET endpoints (D6) return the projections; 401 without the admin token; non-uuid project
      id → 404; `?bucket` validated.
- [ ] Postgres int tests assert EXACT aggregates (db repo) and the discover→ingest→project endpoint
      round-trip (ingest); re-ingest does not double totals (PRD §23).
- [ ] **No migration, no `events`/schema change, no fingerprint/wire/encryption/parse change, no collector
      change.** `npm run db:generate` would produce nothing.
- [ ] `npm run repo-health` passes (exit 0); no stray artifacts, no NUL bytes; Postgres int suite passes
      with `DATABASE_URL_TEST`.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately (paste exit codes).
- [ ] The spike retired the jsonb-aggregation SQL spelling before Task 3's SQL was written.
- [ ] Full suite passes (unit always; integration with `DATABASE_URL_TEST`).
- [ ] Manual projection calls on real data returned sane numbers; a session total matched the M1 report.
- [ ] Deferred scope honored (no git-history capture, no materialized tables, no `connector.health`
      emission, no Markdown report artifacts — those are M7+).
- [ ] README Status updated. `npm run repo-health` green. No migration file added.

---

## NOTES

**Why on-demand, not materialized (D2 / PRD §8.5 / §23):** events are disposable, re-buildable
projections; at single-digit GB/year the join is cheap (and indexed on `project_path` + `session_id`).
Materialization would introduce refresh ordering, staleness windows, and a backfill on every re-parse —
complexity that buys nothing at V1 volume. The repository function is the seam: a future materialized
view can sit behind the same signature without changing callers (M7 included).

**Why this is genuinely lower-risk than M5:** M5 added 3 tables + a migration + a novel Gemini reverse-map
+ a new machine-authed write surface (it scored 8.5). M6 adds **no migration, no write path, no capture
change** — it is read-only SQL over columns that already exist, behind the admin-route pattern M5 already
proved, reusing arithmetic that is already frozen and tested. The single new primitive (jsonb aggregation)
is retired by a 10-minute spike and pinned by int tests that hand-compute the expected numbers.

**Reuse over reinvention:** `lowestConfidence` is promoted (not re-written); `zeroTokens`/`addTokens`/
`computeTotal` are reused; the join is `projectEventSummary` extended; the routes are `routes/projects.ts`
cloned; the int harness is `app.int.test.ts` extended. The plan deliberately adds the *minimum* new code.

**What M7 builds on this:** M7 ("Reporting foundation") renders these projection JSONs into Markdown
report artifacts with Mermaid diagrams (the M1 `renderSessionReport` is the template), adds the
`report.generated` event + report storage/versioning, and the report-comparison feature. M6 is the
deterministic-metrics substrate; keep the projection shapes report-friendly but do NOT render Markdown
here.

**Tool-call failure classification (PRD §14):** M6 surfaces failure *counts* (`tool.call.failed`). The
seven-way *classification* (model error / environment / permission / state mismatch / runtime / cancel /
expected-negative) needs per-failure payload inspection (encrypted) or richer parse output — defer to M7+
where the redaction/render path exists. Counting is enough for the V1 metric.

**Connector health is clock-free:** the projection returns `lastEventAt` (a timestamp); the "N seconds
ago" framing (PRD §10.1.1) is computed by the consumer against the current time, keeping the repository
pure and deterministic per the inject-clocks convention (CLAUDE.md / SUMMARY §6).

**Confidence score: 9.3/10.** This is the lowest-risk milestone planned so far: zero migration, zero
schema/wire/fingerprint/encryption/parse change, zero capture-surface change, read-only, behind an
admin-route pattern and an attribution join that are BOTH already proven in the M5 code
(`routes/projects.ts` + `projectEventSummary`), reusing frozen `@420ai/shared` arithmetic. The user's
three scope decisions removed the only real ambiguity (git capture, materialization, health source). The
−0.7 is the single irreducible unknown — the exact Drizzle `sql` spelling for jsonb numeric aggregation +
`filter` + `array_agg` + `date_trunc` and the text→JS-number cast — which is standard Postgres, retired by
the ≤10-min spike, and pinned by int tests that assert hand-computed totals. Everything else is a faithful
repeat of proven patterns.
