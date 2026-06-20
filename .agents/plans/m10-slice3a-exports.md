# Feature: Archive & Report Exports — MD/JSON/JSONL/CSV portable data bundles (V1 close-out Slice 3A — PRD §22)

The following plan should be complete, but it is important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files (`.js` specifiers, `import type`).

> **Conventions are NOT re-pasted here.** [`CLAUDE.md`](../../CLAUDE.md) (repo root) is the source of
> truth for module/TS/naming rules, the library-no-logging boundary, the testing layers, the validation
> GATE (incl. `--require-db`), and the **Drizzle/SQL gotchas**. Read it first. This plan links to it
> rather than duplicating it — do not let a snippet here drift from `CLAUDE.md`.

> **Scope note — this is sub-slice 3A of the M10 hardening bundle, sequenced SECOND (after 3B).** Per the
> V1 close-out roadmap in [`SUMMARY.md`](../../SUMMARY.md) the M10 bundle is four sub-slices in order
> **3b → 3a → 3c → 3d**. 3B (replay metadata) is **DONE**. This is **3A — Exports (§22)**. The other
> sub-slices — **3c persisted alert engine**, **3d catalog signing (§10.4)** — are OUT OF SCOPE here and
> get their own plans.

> **Scope boundaries confirmed with the user (2026-06-19):**
> 1. **Delivery surface = admin-gated Fastify routes** returning a downloadable file (mirrors
>    `routes/reports.ts`; what the future dashboard, slice 5, will proxy to). **No collector CLI** export
>    in this slice.
> 2. **Raw transcript content IS in scope.** §22's "decrypt-for-render only when scope includes raw
>    content" clause is honored by a dedicated, gated session-transcript export route reusing the M8
>    `sessionTranscript` decrypt path + the `redact()` gate.
> 3. **Format × subject matrix is deliberate** (not every format on every endpoint — see the matrix
>    below). **Parquet and the full restore-UI are deferred** (PRD §22, §8.4). **No schema change, no new
>    table.**

---

## Feature Description

PRD §22 ("Export And Backup") requires V1 to support **Archive Export and Portable Data Bundles** in
**Markdown, JSON, JSONL, and CSV** (Parquet deferred), scoped by **project, time range, session, work
session, report, and connector**. Today the archive is queryable only through the live
reporting/projection/monitor read APIs; there is **no way to get data *out*** of the archive for backup,
migration, inspection, or external analysis — the stated purpose of §22.

This slice adds a self-contained **export surface**: three admin-gated read routes that serialize scoped
archive data into the four V1 formats, each **redacted before it leaves the archive** (the §18 gate) and
each carrying a self-describing **manifest** (version stamps + scope + redaction findings) so an export
is a portable, honest bundle. It reuses — does not reinvent — the established machinery: the `redact()`
pipeline (M8), the `sessionTranscript` decrypt-for-render read (M8), the plaintext projection columns
(M6), and the admin-gated route conventions (M7).

The governing §18 principle (becomes the module docstring on the new repository/serializer):

> *"Redaction applies before AI analysis or external export."* Every byte that leaves the archive passes
> through the Redaction Pipeline first; raw encrypted content is decrypted **only** on the explicit
> transcript route, and even then is redacted before it is serialized.

## User Story

```
As a self-hosting developer who owns my AI-usage archive
I want to export my data — a project's events, a single report, or a session's transcript — as Markdown, JSON, JSONL, or CSV, scoped and redacted
So that I can back it up, migrate it, inspect it, or analyze it externally, without leaking any secret, key, or home-path username that lives in the raw records
```

## Problem Statement

PRD §22 is an explicit V1 MVP-hardening requirement (`SUMMARY.md` line 108; PRD §27 step 10) that is
**not yet implemented**. There is no export endpoint, no serializer for JSONL/CSV (only the M7 Markdown
renderers and ad-hoc JSON-over-HTTP exist), and no "redact everything that leaves" gate generalized
beyond the M8 AI-interpretation path. Without it, the archive is a roach motel — data checks in but
cannot be backed up or moved. The risk to avoid: a naïve export that dumps `events.projectPath`
(`C:\Users\<username>\…`) or a decrypted transcript verbatim would **leak PII/secrets**, violating §18.

## Solution Statement

Add an export surface that is **pure serialization + scoped reads + a universal redaction gate**, with
**zero schema change**:

1. **One generalized redaction gate** — `redactJson(value)` in `packages/shared/src/redaction.ts`, a deep
   walk that runs the existing `redact()` over every string in any JSON value and merges the findings.
   This is THE "redact before anything leaves" gate; every export payload passes through it (the
   transcript route additionally uses per-entry `redact()` exactly like M8).
2. **Pure format serializers** — `packages/shared/src/serialize.ts`: `toJsonl(rows)` and
   `toCsv(rows, columns)` (RFC-4180 quoting), plus an `ExportManifest` type. `@420ai/shared` is the home
   for pure, dependency-free functions (mirrors `redaction.ts`/`reports.ts`).
3. **One additive read repository** — `packages/db/src/repositories/exports.ts`: `exportEvents(db,
   userId, filters)` selects **only plaintext event columns** (never decrypts) scoped by any combination
   of project / session / connector / time range. M6 projection signatures are **left untouched**.
4. **Three admin-gated routes** — `apps/ingest/src/routes/exports.ts`, mirroring `routes/reports.ts`:
   - `GET /v1/exports/events` — scoped redacted event-row export → **json | jsonl | csv**.
   - `GET /v1/reports/:id/export` — single report artifact → **md | json**.
   - `GET /v1/sessions/:sessionId/transcript/export` — **decrypt-for-render** redacted transcript →
     **md | json | jsonl**.

Each route owns the clock (`exportedAt`), sets `Content-Type` + `Content-Disposition: attachment`, and
emits `X-Export-*` headers (rowCount, truncated, redactionVersion) so a non-silent truncation is
observable on every format (CLAUDE.md "no silent caps").

**The format × subject matrix is intentional** (resolves the "no contradictory instructions" rule —
formats are assigned where they carry meaning, not universally):

| Subject (route)                         | md  | json | jsonl | csv | Decrypts raw? |
|-----------------------------------------|-----|------|-------|-----|---------------|
| Event stream (`/v1/exports/events`)     | —   | ✅   | ✅    | ✅  | **No** (plaintext columns only) |
| Report artifact (`/v1/reports/:id/export`) | ✅ | ✅ | —     | —   | **No** (already-rendered artifact) |
| Session transcript (`.../transcript/export`) | ✅ | ✅ | ✅ | —   | **Yes** (M8 `sessionTranscript`, then redact) |

Rationale for the gaps: an event/transcript stream as prose Markdown, or a multi-shape report as a flat
CSV row, is noise — md is for the prose subjects, csv/jsonl for the row-shaped subjects. All four §22
formats are delivered across the feature.

> **"Work session" scope (§22):** the codebase models a session as the connector `session_id`
> (`events.sessionId`); there is no separate "work session" entity. The session routes cover both. A
> distinct work-session grouping is **not introduced** in this slice (no schema change).

## Feature Metadata

**Feature Type**: New Capability (implements PRD §22 export surface)
**Estimated Complexity**: **Medium** (pure serializers + 1 additive read repo + 3 read routes + a
generalized redaction gate; no new table, no migration, no new dependency)
**Primary Systems Affected**: `packages/shared` (serializers + `redactJson` + manifest type),
`packages/db` (1 new read repository + barrel export), `apps/ingest` (3 routes + Fastify query schemas +
route registration)
**Dependencies**: **None new.** Pure Node/TS string building for CSV/JSONL.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/ingest/src/routes/reports.ts` (whole file, ~120 lines) — **the route pattern to MIRROR**:
  admin-gated (`adminAuthorized(app, request)` → 401), `isUuid` → 404, `getReportArtifact` →
  404-if-undefined, owner resolved via `findUserIdByEmail`/`ensureUserByEmail` + `DEFAULT_EMAIL`, route
  owns the clock. The new `routes/exports.ts` follows this exactly.
- `apps/ingest/src/app.ts` (lines 4–17 imports, 57–69 registration, 72–92 error handler) — Why: register
  the new `exportRoutes` plugin here (after `reportRoutes`); confirm error-handler masks 500s and 400s on
  `err.validation`.
- `apps/ingest/src/auth.ts` (`adminAuthorized` lines ~10–18, `isUuid` lines ~20–29) — Why: the inline
  admin guard + UUID guard every export route calls.
- `apps/ingest/src/schemas.ts` (`listReportsQuerySchema` and the `as const` JSON-Schema pattern, e.g.
  lines ~80–88) — Why: add the export querystring schemas in the SAME raw-JSON-Schema `as const` style
  (format enum → Fastify returns 400 on a bad value via the existing error handler).
- `apps/ingest/src/routes/monitor.ts` (lines ~82–127) — Why: the ONLY precedent for non-JSON / custom
  content-type responses (`reply.hijack()` + `reply.raw`). We do NOT stream in v1 (see GOTCHA), but read
  it to understand `reply.header(...)` / raw-reply handling and the teardown-before-await leak rule.
- `packages/shared/src/redaction.ts` (lines 17–18 `REDACTION_VERSION`, 25–39 `RedactionFinding`/
  `RedactionResult`, 196 `redact`) — Why: `redactJson` lives here and reuses `redact`; the manifest
  stamps `REDACTION_VERSION`.
- `packages/shared/src/index.ts` (lines 1–16) — Why: add `export * from "./serialize.js";` (redaction is
  already barrelled at line 13).
- `packages/db/src/repositories/projections.ts` (lines 1–16 imports, 31–53 token/cost SQL helpers,
  74–92 `usageTotals`, 122–151 `usageOverTime`, 259–290 `connectorHealth`) — Why: the scoped-read
  patterns to MIRROR — the `workspaceKeys`→`workspaces` project join, the `machines` user join, and the
  jsonb token/cost columns. `exports.ts` reuses these JOINs but selects **row-level plaintext columns**,
  not aggregates.
- `packages/db/src/repositories/transcript.ts` (lines 1–66 header + types + caps, `sessionTranscript`
  signature) — Why: the decrypt-for-render read the transcript route calls; note it returns **PLAINTEXT**
  and the caller (us) is contractually required to `redact()` before serializing.
- `packages/db/src/repositories/reports.ts` (`getReportArtifact` lines ~63–73, `listReportArtifacts`
  80–94, `ReportArtifactRow` type) — Why: the report export reads one artifact via `getReportArtifact`.
- `packages/db/src/schema.ts` (events lines 106–142 — esp. `ts` mode:"string" @127, `tokens`/`cost` jsonb
  @128–129, `payloadCiphertext`/`Iv`/`Tag` @131–133, `sourceConnector` @112, `projectPath` @123,
  `parserVersion` @113, `catalogVersion` @116) — Why: `exportEvents` selects the plaintext columns and
  MUST NOT select the `payload*` ciphertext triple.
- `packages/db/src/index.ts` (lines 53–72) — Why: barrel-export the new `exportEvents` + its types
  alongside the projection/report/transcript exports.
- `apps/ingest/src/reports/generate-report.ts` (lines 32–93) and `apps/ingest/src/analysis/
  generate-interpretation.ts` (lines 50–108, esp. line 64 the per-entry `redact()` call) — Why: the
  reference "decrypt → redact → emit" discipline the transcript route mirrors.
- `apps/ingest/src/app.int.test.ts` — **the int-test harness to COPY** (there are NO shared seed
  helpers; each int-test file defines its own). Specifically: the `beforeAll`/`beforeEach`/`afterAll`
  setup (lines ~47–73 — `createDb(TEST_URL!)`, `buildApp({db, adminToken:"test-admin",
  analysisProvider: stubProvider, logger:false})`, the `TRUNCATE … RESTART IDENTITY CASCADE` reset at
  line 71, `dbh.pool.end()`), the `stubProvider` (lines ~17–26), the `projectionBatch()` seed (448–497,
  `projectPath = CLAUDE_KEY = "/home/a/420ai"` @445 — a redactable home path), the
  `discoverIngestAndGetProject()` helper (499–521 — pair → discover → ingest → returns `{token,
  projectId}`), and the M8 AI-session seed (`aiBatch`/`ingestAiSession`, `AI_SECRET` anthropic key in a
  raw record, `AI_SESSION`) used by the interpretation test at ~843–895. Why: the exports int test reuses
  these verbatim — do NOT invent new fixtures.

### New Files to Create

- `packages/shared/src/serialize.ts` — pure `toJsonl`, `toCsv`, `ExportManifest`/`ExportFormat` types.
- `packages/shared/src/serialize.test.ts` — unit tests (CSV quoting edge cases, JSONL, manifest shape).
- `packages/db/src/repositories/exports.ts` — `exportEvents(db, userId, filters)` + `EventExportRow`/
  `EventExportFilters` types.
- `apps/ingest/src/routes/exports.ts` — the three export routes (one Fastify plugin).
- `apps/ingest/src/exports.int.test.ts` — integration tests (DB-backed, `describe.skipIf(!…TEST)`).
  **NOTE the location: int tests are co-located in `apps/ingest/src/`** (alongside `app.int.test.ts`),
  NOT in a `test/` dir. (Confirmed: `apps/ingest/src/app.int.test.ts`, `apps/ingest/src/git.int.test.ts`.)
- (Add `redactJson` + its unit tests to the EXISTING `redaction.ts` / `redaction.test.ts`.)

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md` §22 "Export And Backup"](../../docs/PRD.md) (lines ~600–621) — the authoritative format
  list (MD/JSON/JSONL/CSV; Parquet deferred) and scope list (project/time/session/work-session/report/
  connector). Why: the acceptance contract for this slice.
- [`docs/PRD.md` §18 "Redaction"](../../docs/PRD.md) (line ~527 "redaction applies before AI analysis or
  external export") — Why: the gate every export must pass through.
- [`SUMMARY.md`](../../SUMMARY.md) (lines 253–257, the slice-3a bullet) — Why: the agreed scope
  ("redact before anything leaves; decrypt-for-render only when the scope includes raw content; Parquet +
  full restore-UI deferred; Size: M").
- [RFC 4180 — CSV](https://www.rfc-editor.org/rfc/rfc4180#section-2) — Why: the exact quoting rules
  `toCsv` implements (escape `"`→`""`, wrap fields containing `,`/`"`/CR/LF; CRLF row terminator).
- [MDN `Content-Disposition`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition#as_a_response_header_for_the_main_body)
  — Why: the `attachment; filename="…"` header each route sets.

### Patterns to Follow

**Admin-gated read route (MIRROR `routes/reports.ts:92–119`):**
```ts
app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
  "/v1/reports/:id/export",
  { schema: { querystring: exportReportQuerySchema } },
  async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "report not found" });
    }
    const row = await getReportArtifact(app.db, request.params.id);
    if (!row) return reply.code(404).send({ error: "report not found" });
    // … redactJson → serialize → set headers → reply.send(body)
  },
);
```

**Scoped event read (MIRROR the joins in `projections.ts`; SELECT plaintext row columns, no aggregate):**
```ts
// repositories/exports.ts — conditional WHERE/JOIN; user-scoped via the SAME joins M6 uses.
// projectId → workspaceKeys→workspaces.projectId (inherently user-scoped through the project);
// otherwise → machines.userId. ts is mode:"string": a DIRECT column select returns the ISO string
// verbatim (the mode:"string" parser DOES apply to a plain column — this is NOT an aggregate, so NO
// re-coercion is needed and none should be added). tokens/cost are jsonb → parsed JS objects.
const rows = await db
  .select({
    fingerprint: events.fingerprint,
    ts: events.ts,                       // ISO string, verbatim — do NOT wrap in new Date()
    sourceConnector: events.sourceConnector,
    sessionId: events.sessionId,
    projectPath: events.projectPath,     // home path — redactJson masks the username before it leaves
    gitBranch: events.gitBranch,
    eventType: events.eventType,
    model: events.model,
    tokens: events.tokens,               // jsonb → NormalizedTokens | null
    cost: events.cost,                   // jsonb → CostResult | null
    parserVersion: events.parserVersion,
    catalogVersion: events.catalogVersion,
  })
  .from(events)
  // … conditional .innerJoin(...) + .where(and(...conditions)) + .orderBy(asc(events.ts), asc(events.eventIndex))
```

**Deep redaction gate (NEW `redactJson` in `redaction.ts`, reusing `redact`):**
```ts
/**
 * The §18 "redact before external export" gate generalized to any JSON value: deep-clone `value`,
 * run `redact()` over every string, and merge the per-kind findings. Numbers/bools/null pass through.
 * Idempotent (placeholders are digit-free, so re-running finds nothing new — same property as redact()).
 */
export function redactJson<T>(value: T): { value: T; findings: RedactionFinding[] }
```
- Put the assertion next to it (spike-snippet fidelity): *findings are metadata only — a unit test
  asserts no merged finding contains a raw secret*, mirroring the existing `redaction.test.ts` guarantee.

**Per-entry transcript redaction (MIRROR `generate-interpretation.ts:64`):**
```ts
const { entries } = await sessionTranscript(app.db, sessionId);   // PLAINTEXT (decrypt-for-render)
const findings: RedactionFinding[] = [];
const redactedEntries = entries.map((e) => {
  const r = redact(e.text);            // the §18 gate — same call M8 uses
  findings.push(...r.findings);
  return { role: e.role, text: r.redacted, ts: e.ts, truncated: e.truncated };
});
```

> **Spike-snippet fidelity:** the snippets above encode behavior proven by PRE-FLIGHT spikes (below).
> If a snippet drifts from a spike's stated assertion, the spike wins — fix the snippet.

---

## PRE-FLIGHT SPIKES — ALREADY RUN DURING PLANNING (both PASSED; results folded in)

Both design-gating assumptions were verified at plan time, not deferred to the executor. Re-running is
optional confirmation; the design below already reflects the proven results.

**Spike 1 — `events.ts` mode:"string" stays ISO on a DIRECT column select (not an aggregate). ✅ CONFIRMED
by precedent.** The repo's recurring bug (M5 `lastActivity`, M9 `activeSessions`) is that
`min/max(ts)`/`date_trunc` **aggregates** over a `mode:"string"` column come back as Postgres *text*, not
ISO. A **plain column** select does NOT have this problem: `repositories/transcript.ts:75` selects
`ts: events.ts` directly (comment: *"mode:"string" — order by it directly, no Date coercion"*) and returns
it verbatim at line 139 into an ISO `ts: string`. Existing int tests assert ISO content off that path
(e.g. `connectorHealth` `lastEventAt` `.toContain("2026-06-14")`, app.int.test.ts:565). **Design choice
locked: `exportEvents` selects `ts` as a plain column and does NOT wrap it in `new Date(...)`.**

**Spike 2 — `redact()` masks an `events.projectPath` home-path username. ✅ CONFIRMED by execution.** Ran a
throwaway vitest (`packages/shared/src/_spike_export.test.ts`, since deleted) asserting:
`redact("C:\\Users\\seanr\\OneDrive\\Documents\\420AI")` → output does **not** contain `seanr` and yields
a `home_user_path` finding; an embedded `sk-ant-…` key is masked; and the result is idempotent. **All
three assertions passed.** Root cause why it works: the `home_user_path` rule
(`redaction.ts:148`, `/(\/home\/|\/Users\/|[A-Za-z]:\\+Users\\+)([^/\\\s[][^/\\\s]*)/g`) explicitly
covers the Windows `C:\Users\` form. The existing int-test seed uses the Unix form `projectPath =
"/home/a/420ai"` (app.int.test.ts:445), which redacts to `/home/[REDACTED:home_user_path]/420ai` — the
exact assertion target for the events-export int test below. **No `redaction.ts` change is needed.**

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (pure, no DB) — serializers + redaction gate

Build and unit-test the pure pieces first; they have no infra and are the substrate every route uses.

**Tasks:**
- `ExportFormat` / `ExportManifest` types + `toJsonl` + `toCsv` in `serialize.ts`.
- `redactJson` in `redaction.ts`.
- Unit tests for all of the above (CSV quoting edge cases are the high-value tests).

### Phase 2: Scoped read repository

**Tasks:**
- `exportEvents(db, userId, filters)` + `EventExportRow`/`EventExportFilters` in `repositories/exports.ts`.
- Barrel-export from `packages/db/src/index.ts`.

### Phase 3: Routes & integration

**Tasks:**
- `routes/exports.ts` with the three routes; query schemas in `schemas.ts`.
- Register `exportRoutes` in `app.ts`.
- The redact-gate + serialize + headers wiring in each route.

### Phase 4: Testing & validation

**Tasks:**
- DB-backed `exports.int.test.ts` (filters, redaction-on-export, decrypt-for-render, route headers/codes).
- Run the full gate incl. `--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### Task 0 — (spikes already run during planning; nothing to do)
- Both pre-flight spikes PASSED at plan time (see the section above) and their results are baked into the
  tasks below: `ts` is selected as a plain column (no `new Date` coercion), and no `redaction.ts` change
  is needed (Windows + Unix home paths are already masked). Proceed directly to the first CREATE task.

### CREATE `packages/shared/src/serialize.ts`
- **IMPLEMENT**:
  - `export type ExportFormat = "md" | "json" | "jsonl" | "csv";`
  - `export interface ExportManifest { exportedAt: string; subject: "events" | "report" | "transcript";
    format: ExportFormat; scope: Record<string, string | undefined>; redactionVersion: string;
    rowCount: number; truncated: boolean; redactionFindings: RedactionFinding[]; }`
    (import `RedactionFinding` via `import type { RedactionFinding } from "./redaction.js";`).
  - `export function toJsonl(rows: readonly unknown[]): string` → `rows.map(r => JSON.stringify(r)).join("\n")`
    with a **trailing newline** when non-empty; `""` for an empty array.
  - `export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[]): string`
    — header row from `columns`; one row per record reading `columns` in order; **RFC-4180 quoting**:
    a field is wrapped in `"…"` iff it contains `,` `"` CR or LF, with inner `"`→`""`; `null`/`undefined`
    → empty field; numbers/bools → `String(v)`; objects → `JSON.stringify(v)` then quoted. Use **CRLF**
    (`\r\n`) row terminator (RFC 4180). Deterministic (no clock, no Math.random — `@420ai/shared` rule).
- **IMPORTS**: `import type { RedactionFinding } from "./redaction.js";`
- **GOTCHA**: `@420ai/shared` forbids I/O / `new Date()` / deps (see `redaction.ts:13`). Keep these pure;
  the route supplies `exportedAt`. Do NOT `JSON.stringify` with indentation for jsonl (one line per row).
- **VALIDATE**: `npx vitest run packages/shared/src/serialize.test.ts` (written next task).

### CREATE `packages/shared/src/serialize.test.ts`
- **IMPLEMENT**: assert `toCsv` quotes a value with a comma, a value with embedded `"`, a value with a
  newline; emits header in `columns` order; renders `null`→empty, a number unquoted, an object as quoted
  JSON. Assert `toJsonl` emits one `JSON.parse`-able object per line + trailing newline, and `""` for
  `[]`. Assert column subsetting (a key not in `columns` is omitted; a column not in the row → empty).
- **PATTERN**: co-located vitest, mirrors `packages/shared/src/redaction.test.ts`.
- **VALIDATE**: `npx vitest run packages/shared/src/serialize.test.ts` → all pass.

### UPDATE `packages/shared/src/redaction.ts` — ADD `redactJson`
- **IMPLEMENT**: `export function redactJson<T>(value: T): { value: T; findings: RedactionFinding[] }` —
  recursively deep-clone: strings → `redact(s)` (collect `.redacted` + `.findings`); arrays → map;
  plain objects → map values; numbers/bool/null → as-is. Merge findings by `(kind, ruleId, placeholder)`
  summing `count`. Pure; reuses the existing `redact`.
- **IMPORTS**: none new (same module as `redact`).
- **GOTCHA**: do NOT redact object **keys** (they are schema field names, not data). Idempotent: relies on
  `redact`'s digit-free placeholders — add a test asserting `redactJson(redactJson(x).value)` adds no new
  findings.
- **VALIDATE**: `npx vitest run packages/shared/src/redaction.test.ts`.

### UPDATE `packages/shared/src/redaction.test.ts` — cover `redactJson`
- **IMPLEMENT**: a nested object `{ a: "sk-ant-…secret", b: { path: "C:\\Users\\alice\\x" }, n: 42,
  list: ["plain", "AKIA…"] }` → assert the key/number structure is preserved, the secret/path/AKIA
  strings are masked, `n` stays `42`, findings are merged with summed counts, and **no finding contains a
  raw secret substring** (mirror the existing no-leak assertion). Assert idempotence.
- **VALIDATE**: `npx vitest run packages/shared/src/redaction.test.ts` → all pass.

### UPDATE `packages/shared/src/index.ts` — barrel the serializer
- **IMPLEMENT**: add `export * from "./serialize.js";` (redaction is already exported at line 13).
- **VALIDATE**: `npm run typecheck` (root `tsc -b`, exit 0).

### CREATE `packages/db/src/repositories/exports.ts`
- **IMPLEMENT**:
  - `export interface EventExportFilters { projectId?: string; sessionId?: string; connector?: string;
    start?: string; end?: string; }` (start/end are ISO strings).
  - `export interface EventExportRow { fingerprint: string; ts: string; sourceConnector: string;
    sessionId: string; projectPath: string | null; gitBranch: string | null; eventType: string;
    model: string | null; tokens: NormalizedTokens | null; cost: CostResult | null;
    parserVersion: string; catalogVersion: string | null; }`
  - `export async function exportEvents(db: DbClient, userId: string, filters: EventExportFilters,
    cap = EXPORT_MAX_ROWS): Promise<{ rows: EventExportRow[]; truncated: boolean }>` — build a `conditions`
    array + conditional joins:
    - **If `filters.projectId`**: `.innerJoin(workspaceKeys, eq(events.projectPath,
      workspaceKeys.projectKey)).innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))` and
      push `eq(workspaces.projectId, filters.projectId)` (project join is inherently user-scoped — mirrors
      `usageTotals`).
    - **Else**: `.innerJoin(machines, eq(events.machineId, machines.id))` and push `eq(machines.userId,
      userId)` (mirrors `connectorHealth`; note this drops null-`machineId` converged events — same
      semantics as `connectorHealth`; document it).
    - `filters.sessionId` → `eq(events.sessionId, …)`; `filters.connector` → `eq(events.sourceConnector,
      …)`; `filters.start` → `gte(events.ts, start)`; `filters.end` → `lte(events.ts, end)`.
    - `.orderBy(asc(events.ts), asc(events.eventIndex)).limit(cap + 1)` — fetch one past the cap to detect
      truncation; return `rows = take(cap)`, `truncated = fetched.length > cap`.
  - `export const EXPORT_MAX_ROWS = 100_000;` (a generous, NON-silent bound — truncation is surfaced in
    the manifest + `X-Export-Truncated` header).
- **IMPORTS**: `import { and, asc, eq, gte, lte } from "drizzle-orm";`
  `import type { CostResult, NormalizedTokens } from "@420ai/shared";`
  `import type { DbClient } from "../client.js";`
  `import { events, machines, workspaceKeys, workspaces } from "../schema.js";`
- **GOTCHA**: SELECT **only the plaintext columns above** — NEVER select `payloadCiphertext/Iv/Tag`
  (this route must not decrypt; that is the transcript route's job). `ts` is a **direct column** →
  returns the stored ISO string verbatim; do **NOT** wrap it in `new Date(...)` (Spike 1). `tokens`/`cost`
  are jsonb → already parsed objects; pass through. `gte`/`lte` on the `mode:"string"` `ts` is a
  lexicographic ISO compare — the caller MUST pass normalized ISO bounds (mirrors `attribution.ts:198`).
- **VALIDATE**: `npm run typecheck` (root `tsc -b`, exit 0). Behavior is covered by the int test.

### UPDATE `packages/db/src/index.ts` — barrel the export repo
- **IMPLEMENT**: `export { exportEvents, EXPORT_MAX_ROWS } from "./repositories/exports.js";` and
  `export type { EventExportRow, EventExportFilters } from "./repositories/exports.js";` (place near the
  projections/reports exports, ~lines 53–72).
- **VALIDATE**: `npm run typecheck`.

### UPDATE `apps/ingest/src/schemas.ts` — ADD export query schemas
- **IMPLEMENT** three `as const` raw JSON-Schema objects (mirror `listReportsQuerySchema`):
  - `exportEventsQuerySchema`: properties `format` (`enum: ["json","jsonl","csv"]`, required),
    `projectId`/`sessionId`/`connector`/`start`/`end` (optional strings), `additionalProperties: false`.
  - `exportReportQuerySchema`: `format` (`enum: ["md","json"]`, required), `additionalProperties: false`.
  - `exportTranscriptQuerySchema`: `format` (`enum: ["md","json","jsonl"]`, required),
    `additionalProperties: false`.
- **GOTCHA**: making `format` **required** in the schema → Fastify returns **400** (via the
  `err.validation` branch in `app.ts:83`) for a missing/invalid format, satisfying the "bad format → 400"
  acceptance test. Keep filter fields permissive strings (no format coercion).
- **VALIDATE**: `npm run typecheck`.

### CREATE `apps/ingest/src/routes/exports.ts`
- **IMPLEMENT** one Fastify plugin `export default async function exportRoutes(app)` with three routes,
  each starting with the `adminAuthorized → 401` guard:
  1. **`GET /v1/exports/events`** (`Querystring` typed): resolve `userId` via `findUserIdByEmail(app.db,
     DEFAULT_EMAIL)` (if undefined → empty export, `rowCount: 0`). If `projectId` present and not
     `isUuid` → 404 `{error:"project not found"}` (malformed only; a well-formed-unknown id yields an
     empty export, matching M6 read semantics). Normalize `start`/`end` via `new Date(x).toISOString()`
     **inside a try** → invalid date → 400 `{error:"invalid time range"}`. Call `exportEvents`. Pass the
     rows through `redactJson` (collect findings). Build `ExportManifest` (route owns `exportedAt =
     new Date().toISOString()`). Serialize per `format`:
     - `json` → `JSON.stringify({ manifest, rows: redacted })`, `application/json`.
     - `jsonl` → `toJsonl(redacted)`, `application/x-ndjson`.
     - `csv` → `toCsv(flatRows, EVENT_CSV_COLUMNS)` where a local `flattenEventRow` lifts
       `tokens.input/output/cache_read/cache_write/total` and `cost.usd/cost.confidence` to columns
       (`text/csv`).
  2. **`GET /v1/reports/:id/export`**: `isUuid` → 404; `getReportArtifact` → 404 if undefined;
     `redactJson({ markdown, metrics, params, reportVersion, catalogVersion, analysisVersion,
     generatedAt, ... })`; `md` → the redacted `markdown` (`text/markdown`); `json` → `{ manifest,
     report: redacted }` (`application/json`).
  3. **`GET /v1/sessions/:sessionId/transcript/export`**: `sessionId` is a connector text id (NOT a uuid)
     — ungated, unknown → empty transcript. `sessionTranscript(app.db, sessionId)` →
     **per-entry `redact()`** (the M8 pattern) → `md` (render a simple `**role** (ts):\n\ntext` document),
     `json` (`{ manifest, entries }`), `jsonl` (`toJsonl(entries)`). `Content-Type` per format.
  - **All routes**: set `reply.header("content-disposition", 'attachment; filename="420ai-<subject>-<scopeKey>-<exportedAt>.<ext>"')`,
    `reply.header("x-export-row-count", String(rowCount))`,
    `reply.header("x-export-truncated", String(truncated))`,
    `reply.header("x-export-redaction-version", REDACTION_VERSION)`, then
    `reply.type(contentType).send(body)`.
- **IMPORTS**: `import { findUserIdByEmail, getReportArtifact, sessionTranscript, exportEvents } from
  "@420ai/db";` · `import { redact, redactJson, toJsonl, toCsv, REDACTION_VERSION, type ExportManifest }
  from "@420ai/shared";` · `import { adminAuthorized, isUuid } from "../auth.js";` · the three schemas
  from `../schemas.js`. Reuse `const DEFAULT_EMAIL = "seanrobertwright@gmail.com";` (as in `reports.ts:20`).
- **GOTCHA**: **No streaming in v1** — build the body string and `reply.send` it (the `EXPORT_MAX_ROWS`
  cap + truncation flag bound memory honestly). Do NOT use `reply.hijack()` here; staying on the normal
  reply path keeps the global error handler active (a hijacked reply bypasses it — `monitor.ts` accepts
  that only because SSE needs it). The transcript route is the ONLY one that decrypts — keep the
  `redact()` call on the SAME line of reasoning as the decrypt so a future edit can't separate them.
- **VALIDATE**: `npm run typecheck` + the int test below.

### UPDATE `apps/ingest/src/app.ts` — register the plugin
- **IMPLEMENT**: `import exportRoutes from "./routes/exports.js";` (near line 13) and
  `app.register(exportRoutes);` after `app.register(reportRoutes);` (line 66).
- **VALIDATE**: `npm run typecheck`.

### CREATE `apps/ingest/src/exports.int.test.ts`
- **IMPLEMENT** `describe.skipIf(!process.env.DATABASE_URL_TEST)` using the in-process `buildApp` +
  `app.inject`. **COPY the harness verbatim from `app.int.test.ts`** (there are NO shared helpers — each
  int-test file is self-contained): the imports, `const ADMIN = "test-admin"`, the `stubProvider`
  (lines ~17–26), the `beforeAll` (`createDb(TEST_URL!)` + `buildApp({db, adminToken:ADMIN,
  analysisProvider:stubProvider, logger:false})` + `app.ready()`), `afterAll` (`app.close()` +
  `dbh.pool.end()`), and the `beforeEach` `TRUNCATE … RESTART IDENTITY CASCADE` (line 71). Also copy the
  seed helpers it depends on: `createCode`/`pair`/`discoverPayload`, `projectionBatch()` (448–497),
  `discoverIngestAndGetProject()` (499–521), and the AI-session seed (`aiBatch`/`ingestAiSession`,
  `AI_SECRET`, `AI_SESSION`).
  - **events export** — `const { projectId } = await discoverIngestAndGetProject();` (seeds 4 events on
    `projectPath = "/home/a/420ai"`, connector `claude-code`, session `ms1`, ts `00:00`–`00:03` on
    2026-06-14). Then:
    - `GET /v1/exports/events?format=jsonl&projectId=${projectId}` (admin bearer) → 200,
      `content-type: application/x-ndjson`, `content-disposition` starts `attachment;`; split on `\n`
      (drop trailing empty) → 4 `JSON.parse`-able rows; `x-export-row-count: 4`. **`projectPath` in every
      row === `"/home/[REDACTED:home_user_path]/420ai"`** (the proven redaction). Assert **no `ciphertext`
      / `payloadCiphertext` / `payloadIv` / `payloadTag` key** appears anywhere in the body.
    - `format=csv` → `content-type: text/csv`; first line is the header (`fingerprint,ts,sourceConnector,
      sessionId,projectPath,…,tokens_total,cost_usd,…`); 4 data rows; a value containing a comma is
      RFC-4180-quoted.
    - `format=json` → `{ manifest, rows }`; `manifest.redactionVersion === "m8-redact-v1"`
      (`REDACTION_VERSION`), `manifest.rowCount === 4`, `manifest.truncated === false`.
    - **filters**: `&connector=claude-code` → 4 rows; `&connector=nope` → 0 rows;
      `&sessionId=ms1` → 4; `&sessionId=nope` → 0; `&start=2026-06-14T00:00:30.000Z` → 3 rows (drops the
      `00:00:00` usage event); a malformed `&start=not-a-date` → **400** `{error:"invalid time range"}`.
  - **report export** — after `discoverIngestAndGetProject`, POST `/v1/projects/${projectId}/reports`
    `{bucket:"day"}` → 201, capture `id`. `GET /v1/reports/${id}/export?format=md` → 200
    `text/markdown`, body contains `"# Project Cost Report — 420AI"` (matches app.int.test.ts:665).
    `format=json` → `{ manifest, report }`, `manifest.redactionVersion === "m8-redact-v1"`.
  - **transcript export** (decrypt-for-render) — `await ingestAiSession()` (seeds an encrypted raw record
    whose plaintext contains `AI_SECRET`, an `sk-ant-…` key, for `AI_SESSION`).
    `GET /v1/sessions/${AI_SESSION}/transcript/export?format=json` → 200; `entries` non-empty and the
    user entry text is present (decrypt happened) BUT contains `"[REDACTED:anthropic_key]"` and **NOT**
    `AI_SECRET`; `manifest.redactionFindings` includes a `kind:"anthropic_key"` finding; assert
    `JSON.stringify(body)` does not contain `AI_SECRET`. Repeat `format=jsonl` (one redacted entry/line)
    and `format=md` (contains `[REDACTED:` , not the raw key).
  - **route contract** — `GET /v1/exports/events` with NO `authorization` → 401; `?format=parquet` (bad
    enum) → 400; `?format` omitted → 400; `GET /v1/reports/not-a-uuid/export?format=md` → 404;
    `GET /v1/reports/00000000-0000-4000-8000-000000000000/export?format=md` → 404;
    `GET /v1/exports/events?format=json&projectId=00000000-0000-4000-8000-000000000000` → 200 with
    `rowCount: 0` (well-formed-unknown → empty, M6 read semantics); `…&projectId=not-a-uuid` → 404.
- **PATTERN**: `apps/ingest/src/app.int.test.ts` (the whole harness + `discoverIngestAndGetProject` +
  `projectionBatch` + the AI-session interpretation test at ~843–895 for the secret-redaction assertion
  shape).
- **GOTCHA**: int tests import across app boundaries → excluded from `tsc -b` (type-stripped by vitest).
  They **self-skip** without `DATABASE_URL_TEST` — they only count as evidence under `--require-db`. The
  test DB needs `ARCHIVE_ENCRYPTION_KEY` set (in gitignored `.env`) or the transcript decrypt throws —
  the same precondition the existing interpretation int test already relies on.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db`.

---

## TESTING STRATEGY

### Unit Tests (no infra — always run)
- `serialize.test.ts`: `toCsv` RFC-4180 quoting (comma/quote/newline/null/number/object), header ordering,
  column subsetting; `toJsonl` line-per-row + trailing newline + empty-array.
- `redaction.test.ts` (extended): `redactJson` deep redaction, structure/number preservation, findings
  merge, idempotence, no-raw-secret-in-findings.

### Integration Tests (`*.int.test.ts`, gated on `DATABASE_URL_TEST`)
- `exports.int.test.ts`: the filter matrix, redaction-on-export (events PII + transcript secret),
  decrypt-for-render correctness, the format content-types/headers, and the auth/validation/404 contract
  (above). MUST actually run under `--require-db` (0 skipped) to count as evidence.

### Edge Cases (must be tested)
- Empty scope (no matching events) → 200, empty body for jsonl/csv (header-only csv), `rowCount: 0`.
- Truncation: more than the cap → `truncated: true` + `X-Export-Truncated: true` (test with a tiny
  injected cap if feasible, else assert the flag plumbing on a small set with `cap` overridden).
- A transcript whose decrypted text contains a secret → masked; a transcript with NO secret → unchanged
  text, empty findings.
- `projectPath` that is a Windows `C:\Users\<name>` path → username masked (Spike 2).
- Bad `start`/`end` (unparseable) → 400; `start` after `end` → 200 empty (not an error).
- Unknown well-formed `projectId` → 200 empty (M6 read semantics), malformed → 404.

---

## VALIDATION COMMANDS

Every command runs from the repo root. **`repo-health` is the GATE** (CLAUDE.md "Validation is a GATE").

### Level 1: Syntax & Style / Typecheck
- `npm run typecheck` — root `tsc -b` across the four backend workspaces. **Expected: exit 0.** (Per-
  workspace build is NOT a substitute; only the root build catches the cross-package
  `@420ai/shared`→`@420ai/db`→`apps/ingest` imports this slice adds.)

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/serialize.test.ts packages/shared/src/redaction.test.ts` —
  **Expected: all pass** (serializer + `redactJson`).

### Level 3: Integration Tests (DB-backed — the real evidence)
- `npm run db:up && npm run db:migrate` then
  `npm run repo-health -- --require-db` — **Expected: exit 0 AND the `*.int.test.ts` layer ran with 0
  skipped** (the flag FAILS if `DATABASE_URL_TEST` is unconfigured or any int test self-skipped). This is
  mandatory because the slice touches `@420ai/db` + `apps/ingest`; a plain `repo-health` PASS with the
  int layer skipped is **not** evidence the export/redaction/decrypt paths work.

### Level 4: Manual Validation
- With the server running (`ADMIN_TOKEN`/`INGEST_URL` set), download each format and confirm the bytes:
  - `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$INGEST_URL/v1/exports/events?format=csv&projectId=<id>" -D -`
    → headers show `content-type: text/csv`, `content-disposition: attachment`, `x-export-row-count`,
    `x-export-redaction-version: m8-redact-v1`; body is valid CSV.
  - `… ?format=jsonl …` → `application/x-ndjson`; `jq -c . <<< "$(…)"` parses every line.
  - `curl … "/v1/sessions/<sid>/transcript/export?format=md"` → `text/markdown`; `grep -c 'sk-ant-' ` on
    the body is **0** while `grep -c 'REDACTED' ` is > 0 (decrypt-for-render redacted).
  - `grep -c "$ADMIN_TOKEN"` on any export body == 0 (the token never appears in output).
- Bad-format / auth checks: `… ?format=parquet` → HTTP 400; no `Authorization` header → 401.

### Level 5: Additional Validation (Optional)
- N/A (no MCP/CLI surface this slice).

---

## ACCEPTANCE CRITERIA

- [ ] Three admin-gated export routes exist; all return 401 without the admin bearer.
- [ ] Events export is scoped by any combination of project / session / connector / time range and
      returns the four §22-relevant formats for its subject (json/jsonl/csv) with correct content-types
      and an `attachment` content-disposition.
- [ ] Report export returns md + json; transcript export returns md + json + jsonl. All four §22 formats
      (MD/JSON/JSONL/CSV) are delivered across the feature.
- [ ] **Nothing leaves un-redacted**: every export payload passes through `redactJson`/`redact`; an
      integration test proves a home-path username (events) and a transcript secret are masked, and that
      no raw secret appears anywhere in a response body.
- [ ] **Decrypt-for-render is isolated**: only the transcript route decrypts (via `sessionTranscript`);
      the events export selects no ciphertext columns.
- [ ] Each export carries a manifest / `X-Export-*` headers stamping `REDACTION_VERSION`, row count, and
      a non-silent `truncated` flag.
- [ ] Bad/missing `format` → 400; malformed id → 404; well-formed-unknown project id → 200 empty.
- [ ] No schema change, no migration, no new dependency.
- [ ] `npm run typecheck` exits 0; unit tests pass; `npm run repo-health -- --require-db` passes with the
      int layer actually run (0 skipped).

---

## COMPLETION CHECKLIST

- [ ] Both PRE-FLIGHT spikes ran and held (or `redaction.ts` was fixed for Windows home paths first).
- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] `npm run typecheck` (root `tsc -b`) = 0 errors.
- [ ] Unit + integration suites pass; `--require-db` confirms the int layer ran (0 skipped).
- [ ] Manual curl checks confirm content-types, headers, and **0 occurrences** of the admin token / a
      seeded secret in any export body.
- [ ] Acceptance criteria all met; no stray emitted artifacts; nothing committed outside the feature
      branch `m10-slice3a-exports`.

---

## NOTES

**Design decisions & trade-offs**
- **Why a generalized `redactJson` rather than ad-hoc per-route redaction:** §18 says *everything* that
  leaves is redacted. A single deep gate makes that structurally true (and testable) instead of relying
  on each future export remembering to redact each field — the M9 leak-window lesson applied to data
  egress.
- **Why no streaming in v1:** streaming via `reply.hijack()` reintroduces the teardown-before-await leak
  class CLAUDE.md calls out and bypasses the global error handler. A generous in-memory cap with an
  honest `truncated` signal is simpler and safe; true streaming export is a documented follow-up if real
  archives exceed `EXPORT_MAX_ROWS`.
- **Why the events export is the "archive data" unit:** project/time/session/connector are all just WHERE
  filters over the event log, so one scoped event-row export covers four of the six §22 scopes cleanly;
  "report" gets its own artifact route; "work session" maps to `session_id` (no separate entity).
- **Deferred (out of scope, per SUMMARY/PRD):** Parquet, the full restore-UI, a collector-side CLI
  export, true row streaming, and any "work session" grouping distinct from `session_id`.

**Conflict resolution (so the executor never guesses):**
- "Redact before anything leaves" **AND** "decrypt-for-render only when scope includes raw content" →
  **both hold and do not conflict**: only the transcript route decrypts, and it *also* redacts before
  serializing. The events/report routes never decrypt. If you ever find yourself selecting a `payload*`
  ciphertext column on the events route, you have violated this — stop.
- The events read is user-scoped via the project join when `projectId` is present, otherwise via the
  `machines.userId` join. These are the same two scoping mechanisms M6 already uses; do **not** invent a
  third (there is no `userId` column on `events`).

**Spikes actually run during planning (evidence for the confidence score):**
- **Spike 2 (redaction surface) — RUN & PASSED.** Executed a throwaway vitest proving `redact()` masks a
  Windows `C:\Users\seanr\…` username + a `sk-ant-…` key and is idempotent (3/3 assertions passed; file
  deleted). ⇒ no `redaction.ts` change needed; the events-export PII surface is covered.
- **Spike 1 (ts ISO on plain select) — CONFIRMED by precedent.** `transcript.ts:75` + the
  `connectorHealth` int assertion (app.int.test.ts:565) prove a direct `events.ts` column select is ISO.
  ⇒ `exportEvents` does not coerce `ts`.
- **Symbols verified by reading source:** `redact`/`REDACTION_VERSION` (`redaction.ts:18,196`),
  `getReportArtifact`/`listReportArtifacts`/`ReportArtifactRow` (`reports.ts`), `sessionTranscript`/
  `TranscriptEntry` (`transcript.ts:67`), the projection joins (`projections.ts`), the `@420ai/db` /
  `@420ai/shared` barrels, the `events`/`raw_source_records` columns (`schema.ts`), and the route/auth
  pattern (`routes/reports.ts`, `auth.ts`, `app.ts`).
- **Harness confirmed, not assumed:** the int test reuses `discoverIngestAndGetProject` (499–521),
  `projectionBatch` (448–497, `projectPath="/home/a/420ai"`), the `stubProvider`, and the AI-session
  secret seed — all cited by file:line, with the exact redaction assertion target
  (`/home/[REDACTED:home_user_path]/420ai`) derived from the real seed.

**Confidence: 9.4/10** for one-pass success. Every design-gating unknown was retired *at plan time* (both
spikes run/confirmed, every imported symbol read from source, the int-test harness + seed block located
and cited with concrete assertion values). The blast radius is almost entirely additive (3 new files +
one pure function added to `redaction.ts` + barrel/registration one-liners); the only edits to
load-bearing code are import/registration lines. Residual −0.6: the two genuinely new bits of logic are
`toCsv` RFC-4180 quoting and the jsonb token/cost CSV-flattening — both pure, fully unit-tested, and not
on any data-loss path (a quoting bug fails a unit test, it does not corrupt the archive).
