# Feature: Replay Metadata — catalog/report/analysis version stamping (V1 close-out Slice 3B — PRD §23)

The following plan should be complete, but it is important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files (`.js` specifiers, `import type`).

> **Conventions are NOT re-pasted here.** [`CLAUDE.md`](../../CLAUDE.md) (repo root) is the source of
> truth for module/TS/naming rules, the library-no-logging boundary, the testing layers, the validation
> GATE (incl. `--require-db`), and the **Drizzle/SQL gotchas**. Read it first. This plan links to it
> rather than duplicating it — do not let a snippet here drift from `CLAUDE.md`.

> **Scope note — this is sub-slice 3B of the M10 hardening bundle, sequenced FIRST.** Per the V1
> close-out roadmap in [`SUMMARY.md`](../../SUMMARY.md) the M10 bundle is four sub-slices with recommended
> order **3b → 3a → 3c → 3d**. 3B is "stamp catalog/report/analysis versions alongside the stored
> `parser_version` + a re-derive path" and is done first because it **de-risks every later re-parse**.
> The other sub-slices — **3a exports (§22)**, **3c persisted alert engine**, **3d catalog signing
> (§10.4)** — are OUT OF SCOPE here and get their own plans.

> **Scope boundary confirmed with the user (2026-06-19):**
> 1. **Substrate only.** This slice adds the version columns + constants + stamp-through the EXISTING
>    ingest path, and proves that re-running ingest over the same raw input upserts in place and
>    re-stamps versions (no duplicates, fingerprint unchanged). It does **NOT** build a server route or
>    CLI that reads stored *encrypted* raw records, decrypts, re-parses, and re-posts — that
>    archive-replay engine is deferred to its own slice.
> 2. **Include `report_artifacts`.** Beyond `events`, this slice also stamps the pricing-catalog and
>    AI-analysis versions onto stored report artifacts, completing §23's "track report/analysis version"
>    on the artifact itself.

---

## Feature Description

Complete the **PRD §23 "Replay And Versioning"** version-tracking contract. §23 requires every stored
record to carry the versions of the inputs that produced it, so historical metrics can be honestly
re-derived later with improved parsers, **updated pricing catalogs**, and improved analysis logic. The
governing principle (§23, verbatim — this becomes the module docstring):

> *"Raw source records are sacred and permanent; normalized events are disposable, derived, and
> re-buildable at any time. Re-parsing a raw record with an improved parser regenerates events with the
> *same* deterministic fingerprints (§12); those events **replace** the prior ones (upsert), each stamped
> with the `parser_version` that produced it. This is idempotent and simple."*

Today the system stamps **`parser_version`** on every event (`events.parser_version`, NOT NULL) and a
single overloaded **`report_version`** on every report artifact. The two §23 versions that are **not yet
persisted** are:

1. **`catalog_version`** — the pricing-catalog identity used when an event's `cost` was computed (and
   when a report's cost metrics were rendered). Today the catalog is versioned only implicitly by an
   *unexported* `AS_OF = "2026-06-13"` date string in `pricing.ts`; there is no `mNN-catalog-vN` constant
   and no queryable column.
2. **`analysis_version`** — the AI-interpretation pipeline identity on AI report artifacts. It exists as
   the shared constant `AI_REPORT_VERSION` but is currently written into the **same** `report_version`
   column as the deterministic renderer version, so an AI artifact records its analysis version but loses
   the deterministic renderer version, and neither records the catalog version.

This slice introduces a `PRICING_CATALOG_VERSION` constant, adds **nullable, additive** `catalog_version`
(on `events` and `report_artifacts`) and `analysis_version` (on `report_artifacts`) columns, and stamps
them through the existing ingest and report-generation write paths. Because every new column is **excluded
from the event fingerprint** (§12), the dedup/idempotency key is untouched and replay upserts in place.

## User Story

```
As a self-hosting developer who will one day re-price or re-parse my historical archive
I want every stored event and report to record the parser, pricing-catalog, and analysis versions that produced it
So that a future replay can honestly tell which records were computed under an old catalog/parser/pipeline — and re-derive them in place without creating duplicates
```

## Problem Statement

PRD §23 enumerates three versions to track on stored data: `parser_version` (✅ persisted on `events`),
`catalog_version` (❌ not persisted anywhere), and `report/analysis_version` (⚠️ only a single overloaded
`report_version` on `report_artifacts`). Without `catalog_version`, there is **no way to know which
pricing rates a historical cost was computed under**, so a future pricing update cannot safely identify
which events/reports are stale and need re-pricing — defeating the core §23 promise. Without a distinct
`analysis_version`, an AI artifact cannot record both the deterministic bundle renderer and the AI
pipeline that produced it. The `parser_version` re-stamp-on-replay mechanism already exists
(`ingest.ts` `onConflictDoUpdate`), but `catalog_version` is not part of it, so even a manual re-ingest
would not record the catalog the re-parse used.

## Solution Statement

Mirror the **already-shipped `parser_version` mechanism** exactly, adding two metadata columns rather than
inventing machinery:

1. **One new shared constant** `PRICING_CATALOG_VERSION = "m10-catalog-v1"` in `pricing.ts`, following the
   established `mNN-xxx-vN` version-stamp convention (siblings: `REPORT_VERSION="m7-report-v1"`,
   `AI_REPORT_VERSION="m8-ai-v1"`, `MONITOR_VERSION="m10-monitor-v1"`).
2. **Additive, nullable columns** (one migration): `events.catalog_version`,
   `report_artifacts.catalog_version`, `report_artifacts.analysis_version`. Nullable so the migration is
   non-destructive on a populated table and NULL honestly marks "captured before replay-metadata existed"
   — no backfill guess (consistent with the repo's honest-fidelity value).
3. **Stamp-through the existing write paths.** The collector connectors stamp `catalog_version` on each
   event next to where they already stamp `parser_version` (parser-time sibling); it rides the existing
   `EventPayload` wire type → `ingestBatch` insert **and `onConflictDoUpdate` set** (so a replay re-stamps
   it, exactly like `parser_version`). The two report generators stamp `catalog_version` (and the AI ones
   `analysis_version`) into the new `report_artifacts` columns.
4. **Prove the §23 replay contract** with an integration test: re-ingesting the same raw input with a
   bumped catalog/parser version upserts the SAME fingerprints in place (row count unchanged, no dupes)
   and updates the version columns — the de-risking proof this sub-slice exists to provide.

**Zero fingerprint change, raw records untouched, no new event type, no new table.** This deliberately
mirrors the discipline already proven by the per-connector `PARSER_VERSION` stamp.

## Feature Metadata

**Feature Type**: Enhancement (completes PRD §23 version tracking)
**Estimated Complexity**: **Small–Medium** (one shared constant + 3 nullable columns + 1 generated
migration + stamp-through wiring; no new table, no server route, no new dependency)
**Primary Systems Affected**: `packages/shared` (new constant + two additive optional wire fields),
`packages/db` (3 additive columns + 1 migration + the ingest/reports repositories),
`apps/ingest` (event body schema + the two report generators), `apps/collector` (connectors stamp the
catalog version)
**Dependencies**: **None new.** Uses `drizzle-kit generate` (already the migration workflow).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Shared — the version constants + wire types (the pattern to mirror)**
- `packages/shared/src/pricing.ts` (whole, 98 lines) — the pricing catalog. `AS_OF = "2026-06-13"`
  (line 31, **unexported**) is the only catalog versioning today; each model carries `asOf: AS_OF`. You
  ADD `export const PRICING_CATALOG_VERSION = "m10-catalog-v1" as const;` next to `AS_OF`. Read the
  file-level doc comment (lines 1–14) — it already cites replay/§23, so the new constant belongs here.
- `packages/shared/src/cost.ts` (whole, 85 lines) — `CostResult` carries `pricingAsOf?` (line 25),
  populated from `pricing.asOf` (line 83) in `computeCost`. Read to understand that cost is computed at
  **parse time** (the connector calls `computeCost`), which is why `catalog_version` is a **parser-time
  stamp** on the event, a sibling of `parser_version`. **Do NOT change `CostResult`** — `pricingAsOf`
  stays; `catalog_version` is the new top-level event field, not a cost sub-field.
- `packages/shared/src/events.ts` (lines 53–72, `NormalizedEvent`) — add `catalogVersion?: string;`
  (optional) right after `parserVersion` (line 60). Read the raw-sacred doc comment (lines 41–55).
- `packages/shared/src/ingest.ts` (whole, 119 lines) — the wire contract. `EventPayload` (lines 26–41)
  gains `catalogVersion?: string;` after `parserVersion` (line 29); `toEventPayload` (lines 101–118)
  carries it (after line 105). The file doc comment (lines 5–13) states the fingerprint is the server's
  upsert key — confirm the new field does NOT feed it.
- `packages/shared/src/fingerprint.ts` (whole) — **READ, DO NOT TOUCH.** `eventFingerprint(sourceConnector,
  rawRecordId, eventIndex, eventType)` hashes ONLY those four fields with a `|` delimiter. The header
  comment is explicit: *"do NOT reorder fields or change the delimiter, or dedup silently breaks across
  parser versions."* Adding metadata columns is orthogonal — this is the load-bearing invariant.

**DB schema + repositories (the additive columns + stamp-through)**
- `packages/db/src/schema.ts` (lines 106–139, `events`) — add
  `catalogVersion: text("catalog_version"),` (NULLABLE — no `.notNull()`) after `parserVersion` (line
  113). Note the existing comment block (lines 109–110) about the machine-independent fingerprint: your
  column is metadata, NOT part of the PK/fingerprint.
- `packages/db/src/schema.ts` (lines 234–263, `report_artifacts`) — add
  `catalogVersion: text("catalog_version"),` and `analysisVersion: text("analysis_version"),`
  (both NULLABLE) after `reportVersion` (line 247). Read the table doc comment (lines 222–232): artifacts
  are versioned/plaintext; this is purely additive (no index change).
- `packages/db/src/repositories/ingest.ts` (whole, 91 lines) — **THE event upsert.** Add
  `catalogVersion: e.catalogVersion,` to the `.values({...})` insert (after `parserVersion`, line 57)
  AND to the `onConflictDoUpdate({ set: {...} })` block (after `parserVersion`, line 76). The set block is
  the **§23 replay re-stamp** — `parser_version` is already there; `catalog_version` joins it.
- `packages/db/src/repositories/reports.ts` (whole, 93 lines) — `ReportArtifactRow` (lines 14–27) gains
  `catalogVersion: string | null;` and `analysisVersion: string | null;` (after `reportVersion`, line
  22). `insertReportArtifact` takes `Omit<ReportArtifactRow, "id" | "version" | "generatedAt">` (line 38),
  so the two new fields become **required in the insert arg** — every call site (4 of them, all in this
  slice's files) must pass them. `{ ...a, version }` (line 54) already spreads them into the insert.

**Migration workflow**
- `packages/db/drizzle/` — migrations `0000`…`0004` + `meta/_journal.json` + `meta/000N_snapshot.json`.
  Latest is `0004_bouncy_romulus.sql`. You run `npm run db:generate` (drizzle-kit) to emit
  `0005_*.sql` + its snapshot from the `schema.ts` diff — **do NOT hand-write the SQL** (the snapshot must
  stay in sync; hand-edits drift). Read `0002_certain_stark_industries.sql` (the `report_artifacts`
  create) as the column-style reference.
- `packages/db/drizzle.config.ts` + root `package.json` scripts `db:generate`
  (`drizzle-kit generate`), `db:migrate` (`tsx src/migrate-cli.ts`), `db:up` (docker compose).

**The stamp sites (collectors + report generators)**
- `apps/collector/src/connectors/claude-code.ts` (line 162 `parserVersion: PARSER_VERSION,` inside the
  `makeEvent` helper; line 228 `computeCost(...)`) — add `catalogVersion: PRICING_CATALOG_VERSION,` next to
  line 162. Import `PRICING_CATALOG_VERSION` from `@420ai/shared` (the file already imports `computeCost`
  from it, line 5).
- `apps/collector/src/connectors/codex-cli.ts` (line 166 `parserVersion: PARSER_VERSION,`; cost at 215) —
  same add.
- `apps/collector/src/connectors/gemini-cli.ts` (line 126 `parserVersion: PARSER_VERSION,`; cost at 168) —
  same add.
- `apps/collector/src/connectors/custom-connector.ts` (line 282 `parserVersion:
  CUSTOM_CONNECTOR_CONFIG_VERSION,`; `cost: "none"` at 305) — **leave `catalogVersion` UNSET** (a custom
  connector prices nothing → its `catalog_version` is honestly NULL). State this; do not stamp it here.
- `apps/ingest/src/reports/generate-report.ts` (lines 51–61 + 77–87, two `insertReportArtifact` calls;
  imports `REPORT_VERSION` line 14) — add `catalogVersion: PRICING_CATALOG_VERSION, analysisVersion:
  null,` to both. Import `PRICING_CATALOG_VERSION` from `@420ai/shared`.
- `apps/ingest/src/analysis/generate-interpretation.ts` (lines 85–104 + 139–…, two `insertReportArtifact`
  calls; imports `AI_REPORT_VERSION` line 15) — add `catalogVersion: PRICING_CATALOG_VERSION,
  analysisVersion: AI_REPORT_VERSION,` to both. **Leave the existing `reportVersion: AI_REPORT_VERSION`
  UNCHANGED** (D3). Import `PRICING_CATALOG_VERSION`.
- `apps/ingest/src/schemas.ts` (lines 48–77, `eventSchema`) — add `catalogVersion: { type: "string" }` to
  `properties` (NOT to `required` — optional). This is the Fastify body validator for `POST /v1/ingest`.

**Tests to read + extend**
- `packages/shared/src/fingerprint.test.ts` (if present) — confirm/add a **pinned-value** regression
  asserting `eventFingerprint` for a known input equals a fixed hash (proves no drift). If no such test
  exists, add one.
- `packages/db/src/repositories/ingest.int.test.ts` (or the M2 ingest int test — locate with
  `rg -l "ingestBatch" packages/db/src apps/ingest/src`) — extend with the **replay re-stamp** assertion.
- `packages/db/src/repositories/reports.int.test.ts` — already inserts artifacts; its fixtures must pass
  the two new fields and it should assert they round-trip. **GOTCHA: this is the file that will go red on
  the `Omit` type change if not updated.**
- `apps/ingest/src/app.int.test.ts` — the end-to-end ingest + report round-trips; check whether any
  assertion enumerates `report_artifacts`/event columns and needs the new fields.

### New Files to Create

- *(none required.)* This slice is additive columns + stamp-through over existing files. New **test
  cases** are added to existing test files (see Tasks). Optionally add a focused
  `packages/db/src/repositories/replay-metadata.int.test.ts` if folding the replay-re-stamp proof into the
  existing ingest int test would bloat it — author's discretion (Task 9).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) — **§23** (Replay And Versioning — the governing contract +
  the list "track parser version / track catalog version / track report/analysis version"), **§12**
  (Event Fingerprint = `hash(source_connector + raw_record_id + event_index_within_record + event_type)` —
  the invariant your columns must not touch), **§10.4** (catalog updates ship independently of app
  releases — why a `catalog_version` distinct from `parser_version` is meaningful), **§13.1–§13.2**
  (pricing lives in the catalog; `model → {rates, source, as-of}`), **§15/§16** (versioned report
  artifacts + the AI interpretation pipeline).
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — glossary. Name code after existing terms: **"Replay
  Support"** (§155), **"Parser Version"** (§151), **"Event Fingerprint"** (§187), **"Connector Catalog"**
  (§99) / **"Catalog Update"** (§103), **"Report Artifact"** (§287, which explicitly lists "analysis
  version" as artifact metadata), **"AI Interpretation Pipeline"** (§299). **GAP (Task 11):** there is no
  glossary entry for **"Catalog Version"** or **"Analysis Version"** — add short entries so the new columns
  are named after a documented term, not an invented one.
- [`SUMMARY.md`](../../SUMMARY.md) — the V1 close-out roadmap (sub-slice 3b definition + recommended
  order) and "Replay reconciliation (Q5) — upsert-by-fingerprint". Update its status line (Task 12).
- Drizzle Kit [`generate`](https://orm.drizzle.team/docs/drizzle-kit-generate) — additive
  `ALTER TABLE ... ADD COLUMN` migrations from a `schema.ts` diff.

### Patterns to Follow

Follow `CLAUDE.md` (source of truth). The repo-specific ones that bite here:

**Version-stamp constant convention** — schema/artifact versions use `"mNN-xxx-vN"`
(`REPORT_VERSION="m7-report-v1"`, `AI_REPORT_VERSION="m8-ai-v1"`, `MONITOR_VERSION="m10-monitor-v1"`,
`CUSTOM_CONNECTOR_CONFIG_VERSION="m10-custom-v1"`). The new constant is
`PRICING_CATALOG_VERSION = "m10-catalog-v1" as const;`. (The per-connector `PARSER_VERSION="2.0.0"`
semantic style is reserved for parsers — do NOT use it for the catalog.)

**Additive nullable column on a populated table** — new columns are NULLABLE (no `.notNull()`, no
default). The migration is a pure `ALTER TABLE ... ADD COLUMN ... ` (no rewrite). NULL = "produced before
this version was tracked" (honest, no backfill). Mirror how `events_by_project_path` (schema.ts:137) was
added additively without touching the fingerprint.

**Drizzle/SQL gotchas (`CLAUDE.md`)** — these new columns are plain `text` (semantic version strings), so
**none of the timestamp/`numeric` gotchas apply**: there is no aggregate `min/max(ts)`/`date_trunc` (no
ISO-normalize needed), no `numeric` (no `Number()` wrap), no closed-set SQL keyword (no `sql.raw`). Stated
explicitly to satisfy the plan-quality checklist: this slice's illustrative DB code touches no gotcha it
could violate. The one existing aggregate it sits beside — `coalesce(max(version),0)::int` in
`reports.ts:42` — is an `::int` count (a JS number, correct as-is); **do not touch it.**

**Library files never log/exit (`CLAUDE.md`)** — none of the touched repos/connectors log. The connectors
stamp a constant; the repos throw at most.

**Stamp-through symmetry** — `catalog_version` follows `parser_version` at EVERY hop: connector event
construction → `NormalizedEvent` → `toEventPayload`/`EventPayload` → `ingestBodySchema` → `ingestBatch`
`.values` **and** `onConflictDoUpdate.set`. Miss the `set` block and replay silently fails to re-stamp.

> **Spike-snippet fidelity:** the only "spike" here is a **migration-generation check** (Task 1) — run
> `db:generate` and confirm the emitted `0005_*.sql` is purely additive `ADD COLUMN` (no `DROP`, no
> `ALTER COLUMN`). There is no behavioral spike because every mechanism (additive column, `EventPayload`
> stamp-through, `onConflictDoUpdate` re-stamp) is a direct clone of the shipped `parser_version` path.

---

## DESIGN DECISIONS (resolve conflicts up front)

- **D1 — `catalog_version` is metadata, NEVER a fingerprint input.** The fingerprint hashes only
  `source_connector | raw_record_id | event_index | event_type` (`fingerprint.ts`). The new columns are
  excluded by construction (the function signature is untouched). If any version string fed the
  fingerprint, a catalog bump would change the fingerprint → break idempotent upsert → duplicate every
  event on replay. This is the central invariant; a pinned-value fingerprint test guards it (Task 8).
- **D2 — `catalog_version` is a PARSER-TIME stamp (sibling of `parser_version`), set by the collector.**
  Cost is computed at parse time (`computeCost` in the connectors), so the connector stamps
  `PRICING_CATALOG_VERSION` on every event it emits — the catalog version it was built against — exactly
  where it stamps `parser_version`. It is NOT recomputed server-side (the server trusts the wire value,
  same as `parser_version`; `ingest.ts` doc comment: "do not recompute it server-side"). The custom
  connector prices nothing → it leaves `catalog_version` NULL (honest).
- **D3 — Do NOT change the existing `report_version` semantics; ADD `analysis_version` beside it.**
  `report_version` today holds `REPORT_VERSION` for M7 deterministic reports and `AI_REPORT_VERSION` for
  M8 AI artifacts (an overload). **Resolving the overload by rewriting M8 to set
  `report_version = REPORT_VERSION` would change the meaning of already-shipped artifact rows** — out of
  scope and risky. Instead: leave every existing `reportVersion:` assignment UNTOUCHED, and add a NEW
  nullable `analysis_version` column that the AI generators set to `AI_REPORT_VERSION` (deterministic
  generators leave it NULL). The cosmetic redundancy (`reportVersion === analysisVersion` for AI artifacts)
  is acceptable and documented; `analysis_version` is the new authoritative, normalized §23 field.
- **D4 — `report_artifacts.catalog_version` is set whenever cost is in the metrics.** Both the M7 cost
  reports and the M8 interpretations render cost-bearing metrics, so both stamp `PRICING_CATALOG_VERSION`.
  (If a future report type carries no cost, it may pass `catalogVersion: null` — the column is nullable.)
- **D5 — Nullable columns, no backfill.** Existing `events`/`report_artifacts` rows keep NULL for the new
  columns. NULL is the honest "pre-replay-metadata" marker; a backfill would fabricate a catalog version
  those rows were never actually priced under. A future archive-replay slice (deferred) can re-derive and
  populate them.
- **D6 — Generated migration only.** `0005_*.sql` is produced by `drizzle-kit generate` from the
  `schema.ts` diff, never hand-written, so `meta/0005_snapshot.json` + `_journal.json` stay consistent
  (a hand-edited migration that drifts from the snapshot is the classic drizzle footgun).

### Resolved conflicting guidance (do not reconcile by guesswork at implement time)
- **"Mirror `parser_version` exactly" vs. "custom connector has no semantic version":** built-in
  connectors stamp `PRICING_CATALOG_VERSION` (they price via the catalog); the **custom** connector leaves
  `catalog_version` NULL (it maps no cost — `cost: "none"`). Mirror the parser-version *mechanism*
  (stamp-through + `onConflictDoUpdate.set`), not a blanket "every connector must set it."
- **"Stamp report/analysis version" vs. "don't churn shipped data":** add `analysis_version` as a NEW
  column (D3); do NOT repurpose or rewrite `report_version`. The §23 requirement is satisfied by recording
  the analysis version *somewhere queryable and normalized* — the new column — not by mutating the old one.

---

## IMPLEMENTATION PLAN

### Phase 0: Migration-generation check (lightweight — not a behavioral spike)
Edit `schema.ts` (the 3 columns), run `npm run db:generate`, and CONFIRM the emitted `0005_*.sql` is
purely additive (`ADD COLUMN`, no `DROP`/`ALTER COLUMN`). This de-risks the only non-clone step.

### Phase 1: Foundation (shared constant + wire/types)
`PRICING_CATALOG_VERSION` in `pricing.ts`; `catalogVersion?` on `NormalizedEvent` + `EventPayload` +
`toEventPayload`; `catalogVersion` property on the ingest body schema.

### Phase 2: Schema + migration
Add the 3 nullable columns to `schema.ts`; generate `0005_*.sql`.

### Phase 3: Stamp-through (collectors + repositories + report generators)
Connectors stamp `catalog_version`; `ingestBatch` inserts + re-stamps it; `reports.ts` Row/Omit gain the
two fields; the two report generators set them.

### Phase 4: Testing & validation + docs
Fingerprint pinned-value regression; the §23 replay re-stamp int test; report-artifact stamp int
assertions; glossary + SUMMARY updates; full `repo-health -- --require-db`.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently validatable.

### 1. ADD `PRICING_CATALOG_VERSION` — `packages/shared/src/pricing.ts`
- **IMPLEMENT**: add `export const PRICING_CATALOG_VERSION = "m10-catalog-v1" as const;` directly below
  `const AS_OF = "2026-06-13";` (line 31), with a one-line JSDoc citing PRD §23/§10.4: *"Pricing-catalog
  identity stamped on events + report artifacts (PRD §23). Bump when `PRICING_CATALOG` rates change so a
  replay can distinguish records priced under an older catalog. Independent of `AS_OF` (the human date)
  and of the event fingerprint."*
- **PATTERN**: the sibling stamp constants `REPORT_VERSION` (`reports.ts:36`), `AI_REPORT_VERSION`
  (`analysis.ts:30`) — same `"mNN-xxx-vN" as const` shape + replay JSDoc.
- **GOTCHA**: export it from the shared barrel if `pricing.ts` symbols are re-exported individually — check
  `packages/shared/src/index.ts` (`AS_OF` is unexported but `PRICING_CATALOG`/`getPricing` are). Ensure
  `PRICING_CATALOG_VERSION` is reachable as `import { PRICING_CATALOG_VERSION } from "@420ai/shared"`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 2. ADD `catalogVersion?` to the event type + wire type — `packages/shared/src/events.ts`, `ingest.ts`
- **IMPLEMENT**: (a) `events.ts` `NormalizedEvent` (after `parserVersion`, line 60): `catalogVersion?:
  string;` with a comment *"pricing-catalog version (PRD §23); NOT a fingerprint input."* (b) `ingest.ts`
  `EventPayload` (after `parserVersion`, line 29): `catalogVersion?: string;`. (c) `ingest.ts`
  `toEventPayload` (after `parserVersion`, line 105): `catalogVersion: e.catalogVersion,`.
- **PATTERN**: the existing optional fields (`projectPath?`, `model?`) in both interfaces.
- **GOTCHA**: optional (`?`) so existing event producers/fixtures still typecheck. `import type` only — no
  runtime import added.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 3. ADD `catalogVersion` to the ingest body schema — `apps/ingest/src/schemas.ts`
- **IMPLEMENT**: in `eventSchema.properties` (lines 60–76), add `catalogVersion: { type: "string" },`.
  Do **NOT** add it to `required` (lines 50–59) — it is optional/back-compat.
- **PATTERN**: the sibling optional properties `model`, `gitBranch` in the same object.
- **GOTCHA**: `additionalProperties` is not set on `eventSchema` (it defaults to allowed), but add the
  property explicitly so Fastify coerces/validates it as a string rather than silently passing it.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 4. ADD the 3 nullable columns — `packages/db/src/schema.ts`
- **IMPLEMENT**: (a) `events` (after `parserVersion`, line 113): `catalogVersion:
  text("catalog_version"),` (NULLABLE — no `.notNull()`). (b) `report_artifacts` (after `reportVersion`,
  line 247): `catalogVersion: text("catalog_version"),` and `analysisVersion: text("analysis_version"),`.
- **PATTERN**: existing nullable `text(...)` columns (`projectPath: text("project_path")`, schema.ts:120;
  `params: jsonb("params")`, schema.ts:248).
- **GOTCHA**: snake_case SQL column names (`catalog_version`, `analysis_version`); camelCase TS keys. Do
  NOT add `.notNull()` (would fail the migration on existing rows). Do NOT add to any index/unique
  constraint — the fingerprint PK and the `report_artifacts_scope_version` unique index are untouched.
- **VALIDATE**: `npm run typecheck` (exit 0) — note `reports.ts` will go red until Task 6; that's expected.

### 5. GENERATE the migration — `packages/db/drizzle/0005_*.sql`
- **IMPLEMENT**: from the repo root, `npm run db:generate`. This emits `packages/db/drizzle/0005_<name>.sql`
  + `meta/0005_snapshot.json` + a `_journal.json` entry from the `schema.ts` diff.
- **PATTERN**: prior generated migrations (`0002`, `0004`). Commit the generated SQL + snapshot + journal
  together.
- **GOTCHA**: **CONFIRM the emitted SQL is purely additive** — exactly three `ALTER TABLE ... ADD COLUMN
  ... text;` statements (events.catalog_version, report_artifacts.catalog_version,
  report_artifacts.analysis_version), with **no `DROP`, no `ALTER COLUMN`, no `NOT NULL`**. If drizzle-kit
  prompts interactively, it usually means a rename was inferred — abort and re-check the schema edit
  (additive columns should never prompt). Do NOT hand-edit the SQL afterward.
- **VALIDATE**: open `0005_*.sql` and verify the three `ADD COLUMN` lines; `npm run db:up && npm run
  db:migrate` applies cleanly (exit 0).

### 6. STAMP-THROUGH the event upsert — `packages/db/src/repositories/ingest.ts`
- **IMPLEMENT**: (a) in `.values({...})` (after `parserVersion`, line 57): `catalogVersion:
  e.catalogVersion,`. (b) in `onConflictDoUpdate({ set: {...} })` (after `parserVersion`, line 76):
  `catalogVersion: e.catalogVersion ?? null,`.
- **PATTERN**: the existing `parserVersion` handling in BOTH the insert and the `set` block — copy it
  verbatim for `catalogVersion`.
- **GOTCHA**: the `set` block is the **§23 replay re-stamp** — omitting `catalogVersion` there means a
  re-ingest updates `parser_version` but silently leaves a stale `catalog_version`. Both must be present.
  Use `?? null` in `set` to mirror the `tokens`/`cost` nulling idiom (line 78–79).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 7. EXTEND the report-artifact repository + stamp sites
- **IMPLEMENT**: (a) `packages/db/src/repositories/reports.ts` `ReportArtifactRow` (after `reportVersion`,
  line 22): `catalogVersion: string | null;` and `analysisVersion: string | null;`. No change to
  `insertReportArtifact` body (`{ ...a, version }` already forwards them). (b)
  `apps/ingest/src/reports/generate-report.ts` — both `insertReportArtifact` calls (lines 51–61, 77–87):
  add `catalogVersion: PRICING_CATALOG_VERSION, analysisVersion: null,`; import `PRICING_CATALOG_VERSION`
  from `@420ai/shared`. (c) `apps/ingest/src/analysis/generate-interpretation.ts` — both calls (lines
  85–104, 139–…): add `catalogVersion: PRICING_CATALOG_VERSION, analysisVersion: AI_REPORT_VERSION,`
  (leave `reportVersion: AI_REPORT_VERSION` unchanged — D3); import `PRICING_CATALOG_VERSION`.
- **PATTERN**: the existing `reportVersion:` line in each call site.
- **GOTCHA**: `insertReportArtifact`'s arg is `Omit<ReportArtifactRow,"id"|"version"|"generatedAt">`, so
  once the Row has the two new fields they are **required** in every call — the compiler will flag any
  call site you miss (good). The 4 generator calls are the only production callers; **also update any test
  fixtures** that build the insert arg (Task 10). The custom connector / events path is unaffected here.
- **VALIDATE**: `npm run typecheck` (exit 0 now — the Row + all call sites agree).

### 8. STAMP `catalog_version` on built-in connector events + fingerprint regression
- **IMPLEMENT**: (a) `claude-code.ts` (line 162), `codex-cli.ts` (line 166), `gemini-cli.ts` (line 126):
  add `catalogVersion: PRICING_CATALOG_VERSION,` next to `parserVersion: PARSER_VERSION,` in each
  `makeEvent`-style helper; add `PRICING_CATALOG_VERSION` to the existing `@420ai/shared` import (each file
  already imports `computeCost` from it). (b) `custom-connector.ts` (line 282): **leave unset** (D2) — add
  a one-line comment *"catalogVersion intentionally NULL — a custom connector prices nothing (cost:none)."*
  (c) Add/confirm a **pinned-value fingerprint test** in `packages/shared/src/fingerprint.test.ts`:
  `expect(eventFingerprint("claude-code","sess:0",0,"message.assistant")).toBe("<hash>")` (compute the
  hash once and pin it) — proving the new columns did not perturb the fingerprint.
- **PATTERN**: the `parserVersion: PARSER_VERSION` stamp in each connector; `fingerprint.test.ts` existing
  cases (or `monitor.test.ts` style if no fingerprint test exists yet).
- **GOTCHA**: do NOT stamp `catalogVersion` on the custom connector (honest NULL). The pinned hash must be
  computed from the REAL `eventFingerprint` (run it once in a scratch test/REPL and paste the value) — do
  not guess it.
- **VALIDATE**: `npx vitest run packages/shared apps/collector/src/connectors` (all pass).

### 9. ADD the §23 replay re-stamp integration test — `packages/db/src/repositories/ingest.int.test.ts`
- **IMPLEMENT**: a `describe.skipIf(!process.env.DATABASE_URL_TEST)` case: (1) `ingestBatch` a batch of
  N events stamped `parserVersion:"X"`, `catalogVersion:"m10-catalog-v1"`; assert each `events` row's
  `catalog_version` equals the stamped value. (2) Re-`ingestBatch` the SAME events (same fingerprints) but
  with `parserVersion:"Y"`, `catalogVersion:"m10-catalog-v2"`; assert: the total `events` row COUNT is
  UNCHANGED (no duplicates — upsert in place), and each row's `parser_version` AND `catalog_version` were
  UPDATED to the new values (the §23 re-stamp). (3) Assert the `fingerprint` PKs are identical across both
  ingests (the dedup key never moved).
- **PATTERN**: the existing `ingestBatch` int test (locate via `rg -l "ingestBatch"`); the
  `TRUNCATE ... RESTART IDENTITY CASCADE` seed idiom from `monitor.int.test.ts`.
- **GOTCHA**: this is a `*.int.test.ts` — excluded from `tsc -b`, type-stripped by vitest, and it
  SELF-SKIPS without `DATABASE_URL_TEST`. It only proves anything under `--require-db`. If folding into the
  existing ingest int test bloats it, create `replay-metadata.int.test.ts` instead (same skipIf idiom).
- **VALIDATE**: `npm run repo-health -- --require-db` (this case runs, 0 skipped).

### 10. EXTEND the report-artifact integration test — `packages/db/src/repositories/reports.int.test.ts`
- **IMPLEMENT**: update existing `insertReportArtifact` fixtures to pass `catalogVersion` +
  `analysisVersion` (required now), and ADD assertions: a deterministic report row has
  `catalog_version = "m10-catalog-v1"` and `analysis_version = null`; an AI-interpretation row has both
  `analysis_version = "m8-ai-v1"` and `catalog_version = "m10-catalog-v1"`. If the int test only exercises
  the repo (not the generators), assert the round-trip of the two columns directly.
- **PATTERN**: the existing `reports.int.test.ts` insert/list assertions.
- **GOTCHA**: this file **fails to typecheck/strip** until its fixtures pass the two new required fields —
  it is the most likely red after Task 7. Also scan `apps/ingest/src/app.int.test.ts` for any
  report-artifact/event column enumeration that needs the new fields.
- **VALIDATE**: `npm run repo-health -- --require-db` (the int layer runs, 0 skipped).

### 11. ADD glossary entries — `docs/CONTEXT.md`
- **IMPLEMENT**: add two short entries near "Parser Version" (§151) / "Report Artifact" (§287):
  **"Catalog Version"** — *"The identity of the pricing/connector-catalog snapshot used to compute an
  event's or report's cost metrics. Stamped on Normalized Events and Report Artifacts (PRD §23) so a
  replay can re-price records produced under an older catalog."* **"Analysis Version"** — *"The identity of
  the AI Interpretation Pipeline that produced a Report Artifact, stamped alongside the deterministic
  renderer version (PRD §23)."*
- **PATTERN**: the existing terse glossary entry style (one sentence, no code).
- **GOTCHA**: docs only — no code impact, but the NUL/artifact scan in `repo-health` covers it (no broken
  relative links, no stray NULs).
- **VALIDATE**: `npm run repo-health` (docs scanned).

### 12. UPDATE `SUMMARY.md` (status + roadmap)
- **IMPLEMENT**: mark sub-slice **3b — Replay metadata** as in-progress/done in the V1 close-out roadmap;
  note it shipped the `catalog_version` (events + report_artifacts) and `analysis_version`
  (report_artifacts) columns + `PRICING_CATALOG_VERSION`, that the fingerprint is unchanged and replay
  re-stamps in place, and that the archive-replay engine remains deferred. Note 3a/3c/3d still remain.
- **PATTERN**: the existing SUMMARY status prose + the sub-slice list (from commit `cd4f0b9`).
- **VALIDATE**: `npm run repo-health` (docs scanned).

### 13. GATE — full `repo-health -- --require-db`
- **IMPLEMENT**: nothing new; run the gate with the test DB up.
- **GOTCHA**: this slice touches `@420ai/db` (schema + 2 repos + migration) AND `apps/ingest` (schema +
  generators), so the integration layer MUST actually run — a plain `repo-health` PASS (int self-skipped)
  is NOT sufficient (`CLAUDE.md` "Validation is a GATE"; skipped ≠ passed). This is the sign-off gate.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS, int
  layer ran, 0 skipped.

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, always run — no infra)
- `packages/shared/src/fingerprint.test.ts` — **pinned-value** regression proving `eventFingerprint` is
  unchanged by the new columns (D1 guard). The single most important unit assertion in this slice.
- `packages/shared` / connector unit tests — events emitted by the built-in connectors carry
  `catalogVersion === "m10-catalog-v1"`; a custom-connector event carries `catalogVersion === undefined`.
- Optionally assert `PRICING_CATALOG_VERSION` matches the `mNN-xxx-vN` shape.

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST` — run under `--require-db`)
- `ingest.int.test.ts` (or `replay-metadata.int.test.ts`) — the **§23 replay re-stamp**: re-ingesting the
  same fingerprints with bumped parser/catalog versions upserts in place (row count unchanged) and updates
  both version columns; fingerprints identical across ingests.
- `reports.int.test.ts` — deterministic report row stamps `catalog_version` + NULL `analysis_version`; AI
  interpretation row stamps both `analysis_version` + `catalog_version`.

### Edge Cases (must be covered)
- Re-ingest with the SAME catalog/parser version → upsert is a no-op-equivalent (no dupes, columns
  unchanged).
- Event with no `catalogVersion` on the wire (back-compat / custom connector) → column is NULL, no error.
- Existing pre-migration rows → NULL `catalog_version`/`analysis_version`, queries still work.
- Fingerprint for a fixed input is byte-identical before and after the slice (the pinned-value test).
- A report with no cost metrics could pass `catalogVersion: null` (column nullable) without error.

---

## VALIDATION COMMANDS

All commands run from the **repo root**. Each is a GATE.

### Level 1: Syntax & Types (repo-root build — catches cross-project/test-only imports)
- `npm run typecheck` → **exit 0** (root `tsc -b`; the four backend workspaces). The `report_artifacts`
  `Omit` change makes the compiler enumerate every missed insert call site — fix until green.

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/fingerprint.test.ts` → the pinned-value fingerprint regression passes.
- `npm test` → full `vitest run`; units always run, int self-skips. **Must be green.**

### Level 3: Integration Tests (the DB-backed layer must ACTUALLY run)
- `npm run db:up && npm run db:migrate` → applies `0005_*.sql` cleanly (exit 0).
- `npm run repo-health -- --require-db` → **PASS, and the `*.int.test.ts` layer ran with 0 skipped.** This
  slice touches `@420ai/db` + `apps/ingest`, so a plain `repo-health` PASS is NOT sufficient (skipped ≠
  passed). **Milestone sign-off gate.**

### Level 4: Manual Validation
1. `npm run db:up && npm run db:migrate`; start ingest (`npm run ingest:dev`). Pair a collector and
   `collector push` a real Claude/Codex session (or POST a crafted `IngestBatch` with
   `catalogVersion:"m10-catalog-v1"`).
2. `psql $DATABASE_URL -c "select fingerprint, parser_version, catalog_version from events limit 5;"` →
   `catalog_version` is populated for built-in-connector events.
3. Re-`collector push` the same file → row count unchanged; `catalog_version`/`parser_version` reflect the
   current constants (re-stamp).
4. Generate a project cost report and a session AI interpretation; `select report_type, report_version,
   analysis_version, catalog_version from report_artifacts;` → deterministic rows have
   `catalog_version` set + `analysis_version` NULL; AI rows have both set.

### Level 5: Code-review gate (separate layer)
- `npm run repo-health -- --require-db` green AND run `/lril:code-review` before commit. This slice adds no
  long-lived resource (no timer/stream), so the M9 SSE-leak class does not apply; review focuses on the
  stamp-through completeness (especially the `onConflictDoUpdate.set` re-stamp) and the migration being
  purely additive.

---

## ACCEPTANCE CRITERIA

- [ ] `PRICING_CATALOG_VERSION = "m10-catalog-v1"` exists in `pricing.ts`, exported via `@420ai/shared`,
      following the `mNN-xxx-vN` convention.
- [ ] `events.catalog_version` (nullable) is populated by built-in-connector events through the existing
      ingest path; the custom connector leaves it NULL.
- [ ] `report_artifacts.catalog_version` + `analysis_version` (nullable) are stamped by the M7/M8
      generators per D3/D4 (deterministic: catalog only; AI: both; `report_version` unchanged).
- [ ] The event fingerprint is byte-identical before/after the slice (pinned-value test passes) — no
      fingerprint, no raw-record change, no new event type, no new table.
- [ ] Re-ingesting the same fingerprints with bumped versions upserts in place (0 duplicates) and
      re-stamps both `parser_version` and `catalog_version` (proven by an int test under `--require-db`).
- [ ] `0005_*.sql` is purely additive (`ADD COLUMN` ×3, no DROP/NOT NULL), generated (not hand-written),
      with its snapshot + journal committed; `db:migrate` applies cleanly.
- [ ] `npm run typecheck`, `npm test` exit 0; `npm run repo-health -- --require-db` PASSES with the int
      layer run, **0 skipped**.
- [ ] `docs/CONTEXT.md` defines "Catalog Version" + "Analysis Version"; `SUMMARY.md` marks 3b done.
- [ ] `/lril:code-review` run before commit; findings addressed.

## COMPLETION CHECKLIST

- [ ] Phase-0 migration-generation check done (emitted SQL purely additive).
- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] Root `tsc -b` exits 0; full `vitest run` green; new units present and passing.
- [ ] `repo-health -- --require-db` PASS (int layer exercised, 0 skipped).
- [ ] Migration + snapshot + journal committed together; `db:migrate` clean.
- [ ] Fingerprint pinned-value regression holds.
- [ ] Glossary + SUMMARY updated; deferred archive-replay engine named (not implied as covered).

---

## NOTES

**Why this is the FIRST sub-slice.** 3B lays the versioning substrate (columns + constants + re-stamp
mechanism) that the later sub-slices lean on: 3a exports must record which catalog/analysis versions a
scoped export was computed under, and 3c's persisted alert/replay history needs the columns to exist.
Doing it first de-risks every later re-parse, per the roadmap.

**What is deliberately deferred (name in the PR, do NOT build here):**
- **The archive-replay engine** — a server route / CLI that reads stored *encrypted* `raw_source_records`,
  decrypts (decrypt-for-render), re-parses with the current parser, and upserts re-derived events. The
  *infrastructure* exists (immutable encrypted raw records + idempotent upsert + the version columns this
  slice adds), but the read-back-and-re-emit path is its own slice. This slice's "re-derive path" is the
  EXISTING ingest upsert proven to re-stamp versions (re-running `collector push`/`watch` over the same
  source re-derives in place).
- **Backfill** of NULL `catalog_version`/`analysis_version` on pre-migration rows (D5 — NULL is honest;
  the replay engine can populate them later).
- **Resolving the `report_version` overload** by normalizing M8 to record the deterministic renderer
  version separately (D3 — would churn shipped artifact semantics; out of scope).
- **Per-event vs. per-catalog independence at runtime** — V1's catalog is a bundled constant
  (`PRICING_CATALOG` + `AS_OF`), so `catalog_version` is currently a build-time constant. Independent
  remote catalog updates (PRD §10.4) that would make it vary at runtime are the **3d catalog-signing**
  slice's concern.

**Replay correctness restated (PRD §23):** events stamp `parser_version` + `catalog_version`; both are
re-stamped on upsert (`onConflictDoUpdate.set`); the fingerprint is independent of both, so re-deriving on
a version bump upserts in place — identical to the discipline the built-in `PARSER_VERSION` already
follows.

---

## Confidence Score

**9/10** for one-pass success. This slice is a direct clone of the already-shipped `parser_version`
mechanism (constant → `NormalizedEvent`/`EventPayload` → body schema → `ingestBatch` insert +
`onConflictDoUpdate` re-stamp), plus two additive nullable columns generated by the standard drizzle-kit
workflow. There is no new dependency, no new table, no server route, no fingerprint change, and the DB
columns touch none of the timestamp/`numeric` Drizzle gotchas (plain `text`).

The **−1** is concentrated in two named, test-gated ripples: (1) the `report_artifacts` `Omit`-input type
change makes the two new fields **required** in every `insertReportArtifact` call, so the executor must
update all production call sites AND the `reports.int.test.ts` fixtures (the compiler enumerates the
misses, and Task 10 calls it out); (2) the migration must be **generated** (not hand-written) so the
drizzle snapshot/journal stay in sync — a hand-edited `0005_*.sql` is the classic footgun, mitigated by
the Phase-0 check. Both are caught by `tsc -b` + `repo-health -- --require-db`.
