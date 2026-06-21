# Feature: M12 Slice 12.5 — Archive-Replay Engine (Retroactive Re-Pricing)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files (relative imports end in `.js`; `import type` for
type-only imports). **Project conventions are the source of truth — read [`CLAUDE.md`](../../CLAUDE.md)
and [`SUMMARY.md`](../../SUMMARY.md); do not re-derive them here.**

> **Scope decision (made during planning, 2026-06-20).** PRD §25 frames Slice 12.5 as a
> "read-back → decrypt → re-parse path … so a newer parser **OR** an approved pricing catalog can
> retroactively re-derive/re-price." Those are two mechanisms with very different risk:
> - **Re-PRICE** (this plan, **12.5a**) — a pure server-side pass over the `events` table that recomputes
>   `cost` under the active catalog and re-stamps `catalog_version`. No decrypt, no parser, no file
>   reassembly. **Closes the concrete, named gap** ("today catalog signing re-prices *going forward
>   only*" — SUMMARY §0, PRD §25 12.5).
> - **Re-PARSE** (**deferred → its own plan, 12.5b**) — requires relocating the fingerprint-bearing
>   parsers out of `apps/collector` into `packages/shared` (the ingest server cannot import the
>   collector), server-side decrypt of raw records, and reassembling the original file *in line order*
>   from per-line raw records (Codex/custom/Gemini-fallback key `rawId` on `${session}:${lineIndex}`, and
>   `raw_source_records` stores no sequence column). Large, fingerprint-touching, lower one-pass
>   confidence. **See "Deferred → 12.5b" in NOTES for the full design sketch so the follow-up plan starts
>   from this analysis.**
>
> This plan delivers **12.5a only**. It is independently valuable and green on its own.

## Feature Description

Today an approved pricing catalog (M10 3d) only re-prices events **as they are (re-)ingested**: the
ingest route fetches the active catalog and passes it to `ingestBatch`, which recomputes `cost` and
stamps `catalog_version` for cost-bearing events in that batch (`apps/ingest/src/routes/ingest.ts:19`,
`packages/db/src/repositories/ingest.ts:62-68`). Events already in the archive keep whatever cost they
were priced under at capture time. Approving a corrected catalog therefore does **nothing** to historical
rows — the "retroactive re-pricing" half of PRD §23 is unimplemented.

12.5a adds the retroactive pass:

- **`repriceAll(db, catalog)`** — a `@420ai/db` repository function that walks every **cost-bearing**
  event (`cost`, `tokens`, `model` all present — exactly `ingestBatch`'s re-price predicate) and, in
  batches, recomputes `cost = computeCost(model, tokens, catalog.rates)` and re-stamps
  `catalog_version = catalog.version`. Idempotent and re-runnable. Mirrors the proven batched
  select→update loop of `reencryptAll` (`packages/db/src/repositories/key-rotation.ts`).
- **`POST /v1/replay/reprice`** — an admin-gated ingest route that fetches the active catalog
  (`getActiveCatalog`) and runs `repriceAll` under it; `409` when no catalog is active.
- **`db:reprice` CLI** (`packages/db/src/reprice-cli.ts`) — an ops entrypoint mirroring
  `rotate-key-cli.ts`, for cron/manual runs without going through the API.
- **Runbook section** in `docs/guide/operations.md` (created in 12.4) documenting the procedure and the
  "back up first" + "incomplete catalog zeroes un-listed models" caveats.

**The fingerprint is untouched, there is no schema migration, and no existing call site changes.** This
is a purely additive capability.

## User Story

As the **self-hosting single admin** of my 420AI archive,
I want to **apply a newly-approved pricing catalog to the events already in my archive**,
So that **historical cost reports reflect corrected pricing** — not just sessions captured after the
catalog was approved — making the "raw sacred, projections disposable / re-derivable" promise real for
cost, the projection most likely to need correcting.

## Problem Statement

1. **Retroactive re-pricing does not exist.** Catalog approval (`approveCatalog`) flips the active row;
   re-pricing only happens at ingest time. A corrected catalog never reaches historical events. (SUMMARY
   §0 and PRD §25 12.5 both call this out explicitly: "re-prices going forward only".)
2. **No way to re-derive cost on demand.** There is no endpoint, repo function, or CLI to recompute the
   `cost` projection from the (immutable, already-stored) `tokens` + `model` columns.

## Solution Statement

A pure, additive re-derivation pass over `events` that **mirrors the going-forward re-price semantics
exactly** so the two paths can never diverge:

- The selection predicate is byte-for-byte the `ingestBatch` D2 guard — `cost IS NOT NULL AND tokens IS
  NOT NULL AND model IS NOT NULL` — so re-pricing is **shape-preserving** (it never *adds* a cost to a
  `usage.reported`/`message.*` event; it only recomputes one that already exists).
- The cost is recomputed with the **same call** the ingest path uses:
  `computeCost(model, tokens, catalog.rates)` (`packages/shared/src/cost.ts:60`).
- The batched loop reuses the **proven shape** of `reencryptAll` (`key-rotation.ts`): id/key-ordered
  `select … limit BATCH` in a transaction, where each update changes the WHERE-predicate so the same rows
  are not re-selected and the loop terminates.
- Idempotency + the "advance the loop" mechanism both come from a `catalog_version IS DISTINCT FROM
  <version>` filter. **`IS DISTINCT FROM` (not `<>`) is required** so events with a NULL `catalog_version`
  — captured before replay-metadata existed (`schema.ts:132-134`) — are included (`<> 'v'` evaluates to
  NULL → excluded for those rows). **This exact behavior was spike-proven during planning** (see NOTES).

The repo function is library code (throws, never logs — CLAUDE.md "Logging / process boundaries"); the
route and the CLI are the only loggers/entrypoints.

## Feature Metadata

**Feature Type**: New Capability (completes the §23 replay promise) — additive only.
**Estimated Complexity**: **Low–Medium.** One repo function (≈40 lines, mirrors an existing one), one
route (≈15 lines), one CLI (≈20 lines), two int tests, barrel + `app.ts` + npm-script wiring, docs. The
one subtle correctness point (the NULL-`catalog_version` predicate) is spike-proven.
**Primary Systems Affected**: `packages/db` (new repo fn + CLI + barrel), `apps/ingest` (new route +
registration), `docs/guide/operations.md`, `package.json` scripts. **No schema change. Fingerprint
untouched.**
**Dependencies**: **None new.** Uses `computeCost`/`ModelPricing` (`@420ai/shared`, present),
`getActiveCatalog` (`@420ai/db`, present), `drizzle-orm` (present), `tsx` (present).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The going-forward re-price path to mirror EXACTLY (the source of truth for semantics):**
- `packages/db/src/repositories/ingest.ts` (lines 62-68 the D2 re-price block; 91-106 the upsert `set`)
  — the predicate `repricing && e.cost !== undefined && e.tokens && e.model`, the `computeCost(e.model,
  e.tokens, repricing.rates)` call, and the `catalogVersion = repricing.version` stamp. **`repriceAll`
  must reproduce these semantics for rows already in the table.**
- `apps/ingest/src/routes/ingest.ts` (whole file, 24 lines) — how the route fetches `getActiveCatalog`
  and passes `{version, rates}` as `repricing`. **MIRROR the active-catalog fetch in the new route.**

**The batched select→update loop pattern to mirror (structure):**
- `packages/db/src/repositories/key-rotation.ts` (whole file, ~142 lines) — `reencryptAll` + the
  `rotateTable` helper: `db.transaction` → `for(;;){ select … where <not-done-predicate> order by key
  limit BATCH; if empty break; update each }`. **`repriceAll` is the same shape over `events`**, with the
  "not-done" predicate being `catalog_version IS DISTINCT FROM <version>` instead of `NOT LIKE prefix`.
  `BATCH = 500`.

**Cost computation + catalog access:**
- `packages/shared/src/cost.ts` (lines 60-86) — `computeCost(model, tokens, catalog?)` → `CostResult`.
  **GOTCHA (verified by reading `pricing.ts:108-113`):** when a `catalog` is passed, `getPricing` looks
  up **only** that catalog (`return catalog[model]`) — it does **NOT** fall back to the bundled
  `PRICING_CATALOG`. So re-pricing under an active catalog that omits a model yields
  `{usd: 0, confidence: "estimated-model-unknown", model}`. This is **identical** to the going-forward
  ingest behavior (same call), so the two paths stay consistent — but document it in the runbook (an
  incomplete uploaded catalog zeroes the cost of any model it doesn't list).
- `packages/shared/src/pricing.ts` (lines 102-113) — `getPricing`; (15-26) `ModelPricing`.
- `packages/db/src/repositories/pricing-catalogs.ts` (lines 82-91) — `getActiveCatalog(db) →
  { version, rates } | undefined`. **Exactly the `{version, rates}` shape `repriceAll` takes.** Already
  barrel-exported (`index.ts:105`).

**Schema (read-only — no change):**
- `packages/db/src/schema.ts` (lines 124-160 `events`) — `fingerprint` (PK), `model text` (nullable),
  `catalogVersion text` (**nullable** — lines 132-134, the NULL case the predicate must include),
  `tokens jsonb $type<NormalizedTokens>` (nullable), `cost jsonb $type<CostResult>` (nullable).

**Route + registration + admin gate to mirror:**
- `apps/ingest/src/routes/metrics.ts` (whole file) — the **no-body, admin-gated route** to MIRROR
  (`adminAuthorized(app, request)` → 401 else proceed).
- `apps/ingest/src/routes/catalog.ts` (lines 50-55) — the admin-gated no-body GET pattern + how it calls
  a `@420ai/db` repo fn with `app.db`.
- `apps/ingest/src/auth.ts` — `adminAuthorized(app, request)` (the sync hybrid gate; imported by routes).
- `apps/ingest/src/app.ts` (lines 132-149 the `app.register(...)` block; 24 `import catalogRoutes`) —
  **add `import replayRoutes` + `app.register(replayRoutes)` here** (after `catalogRoutes`).

**CLI + barrel + scripts to mirror:**
- `packages/db/src/rotate-key-cli.ts` (whole file, 27 lines) — the entrypoint MIRROR for `reprice-cli.ts`
  (load repo-root `.env`, read `DATABASE_URL`, `createDb`, run, log, `pool.end()` in `finally`).
- `packages/db/src/migrate-cli.ts` — secondary reference (top-level `await`, the `.env` path resolution).
- `packages/db/src/index.ts` (lines 47, 104-117) — the barrel. **Add the `repriceAll` export + its result
  type next to `reencryptAll` (line 116-117).** `getActiveCatalog` is already exported (105).
- `packages/db/package.json` (scripts: `db:rotate-key` = `tsx src/rotate-key-cli.ts`) — **add `db:reprice`.**
- `package.json` (root; `db:rotate-key` = `npm run -w @420ai/db db:rotate-key`) — **add the `db:reprice`
  forwarder.**

**Test harness to mirror:**
- `packages/db/src/repositories/pricing-catalogs.int.test.ts` (whole file, 173 lines) — **the near-exact
  mirror** for the new repo int test: it already has `costBatch()` (a `cost.estimated` event with
  cost+tokens+model **plus** a `usage.reported` event with tokens-but-no-cost), the
  `insertPendingCatalog`+`approveCatalog` seeding, the `TRUNCATE … RESTART IDENTITY CASCADE` `beforeEach`,
  and the `(cost->>'usd')::float` assertion query. **Copy its scaffold; add `repriceAll` cases.** Verified
  passing 8/8, 0 skipped, against the live test DB during planning.
- `apps/ingest/src/app.int.test.ts` (lines 47-94) — the route int-test scaffold (`TEST_URL`,
  `describe.skipIf`, `buildApp({db, adminToken: ADMIN, analysisProvider: stubProvider, logger: false})`,
  `app.ready()`, `app.inject({method,url,headers})`). **MIRROR for the route int test** (seed an active
  catalog via the `@420ai/db` repo fns + a cost-bearing event via `ingestBatch`, then inject the POST).

### New Files to Create

- `packages/db/src/repositories/reprice.ts` — `repriceAll(db, catalog)` + `RepriceResult`. (Task 1)
- `packages/db/src/reprice-cli.ts` — the `db:reprice` entrypoint (MIRROR `rotate-key-cli.ts`). (Task 5)
- `packages/db/src/repositories/reprice.int.test.ts` — repo int test (the spike, productionized). (Task 3)
- `apps/ingest/src/routes/replay.ts` — admin-gated `POST /v1/replay/reprice`. (Task 6)
- `apps/ingest/src/replay.int.test.ts` — route int test (401 / 409 / 200 + cost actually changed). (Task 8)

### Relevant Documentation — READ THESE BEFORE IMPLEMENTING

- PostgreSQL `IS DISTINCT FROM` — <https://www.postgresql.org/docs/17/functions-comparison.html>
  - Why: the NULL-safe inequality that makes NULL-`catalog_version` rows eligible for re-pricing. `<>`
    would silently skip them. (Spike-proven — see NOTES.)
- Drizzle `sql` template — <https://orm.drizzle.team/docs/sql> — composing a raw predicate inside `and(…)`
  (`sql\`${events.catalogVersion} IS DISTINCT FROM ${catalog.version}\``). The repo already does this
  (`pricing-catalogs.ts:1` imports `sql`; `key-rotation.ts` uses `and`/`not`/`like`).

### Patterns to Follow

**`repriceAll` (`packages/db/src/repositories/reprice.ts`) — spike-proven loop + predicate:**
```ts
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { computeCost, type ModelPricing } from "@420ai/shared";
import type { Db } from "../client.js";
import { events } from "../schema.js";

/** Batch size for the select→update sweep (mirrors key-rotation.ts BATCH). */
const BATCH = 500;

export interface RepriceResult {
  repriced: number;
  catalogVersion: string;
}

/**
 * M12 12.5a — retroactively re-price every cost-bearing event under `catalog`. The
 * going-forward path (ingestBatch D2) only reprices events as they (re-)ingest; this
 * applies an approved catalog to the EXISTING archive. Pure data pass over `events`:
 * no decrypt, no re-parse, fingerprint untouched, no schema change.
 *
 * Predicate MIRRORS ingestBatch's D2 guard exactly (cost+tokens+model present → recompute;
 * never ADDS a cost — usage.reported/message.* pass through). The `catalog_version IS
 * DISTINCT FROM` skip makes it idempotent AND advances the batched loop (an updated row
 * stamps the active version → no longer matches → not re-selected → loop terminates).
 * IS DISTINCT FROM (NOT `<>`) is REQUIRED so rows with NULL catalog_version — events
 * captured before replay-metadata existed — are INCLUDED. Spike-proven (see plan NOTES).
 */
export async function repriceAll(
  db: Db,
  catalog: { version: string; rates: Record<string, ModelPricing> },
): Promise<RepriceResult> {
  const repriced = await db.transaction(async (tx) => {
    let count = 0;
    for (;;) {
      const rows = await tx
        .select({ fingerprint: events.fingerprint, model: events.model, tokens: events.tokens })
        .from(events)
        .where(
          and(
            isNotNull(events.cost),
            isNotNull(events.tokens),
            isNotNull(events.model),
            sql`${events.catalogVersion} IS DISTINCT FROM ${catalog.version}`,
          ),
        )
        .orderBy(asc(events.fingerprint))
        .limit(BATCH);
      if (rows.length === 0) break;
      for (const r of rows) {
        // WHERE guards non-null tokens/model; `!` / `?? undefined` narrow for TS.
        const cost = computeCost(r.model ?? undefined, r.tokens!, catalog.rates);
        await tx
          .update(events)
          .set({ cost, catalogVersion: catalog.version })
          .where(eq(events.fingerprint, r.fingerprint));
        count += 1;
      }
    }
    return count;
  });
  return { repriced, catalogVersion: catalog.version };
}
```
> **Spike assertions folded in (proven against the live test DB during planning, then deleted):** with a
> tiny `BATCH=2`, four seeded events — `a` (NULL catalog_version, cost-bearing), `b` (old version,
> cost-bearing), `c` (already at active version), `d` (`usage.reported`, tokens but no cost) — yield
> `repriced === 2` (`a`+`b` only); `a` and `b` recompute to `1000 × 10e-6 = 0.01` and stamp the active
> version; `c` is untouched (`0.005`); `d` stays `cost = NULL`, `catalog_version = NULL`; a second run
> returns `0` (idempotent, loop terminates). **`<>` instead of `IS DISTINCT FROM` would have excluded
> `a`** — that is the trap this snippet encodes.

**Route (`apps/ingest/src/routes/replay.ts`) — MIRROR `metrics.ts` + `ingest.ts`'s active-catalog fetch:**
```ts
import type { FastifyInstance } from "fastify";
import { getActiveCatalog, repriceAll } from "@420ai/db";
import { adminAuthorized } from "../auth.js";

/**
 * M12 12.5a archive-replay (re-price). Admin-gated. Retroactively re-prices every
 * cost-bearing event under the ACTIVE uploaded catalog (the going-forward ingest path only
 * reprices on re-ingest). No body. 409 when no catalog is active (nothing to apply).
 *
 * POST /v1/replay/reprice → { repriced, catalogVersion }
 */
export default async function replayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/replay/reprice", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const active = await getActiveCatalog(app.db);
    if (!active) {
      return reply.code(409).send({ error: "no active catalog to re-price under" });
    }
    return reply.code(200).send(await repriceAll(app.db, active));
  });
}
```
> **GOTCHA:** no body schema is needed (no body) — do NOT add a `schema.body` (an empty/absent body must
> not 400). Mirror `metrics.ts`, which registers a bare admin-gated handler. The `/v1/replay/*` namespace
> is forward-looking (12.5b re-parse would add `POST /v1/replay/reparse` here).

**CLI (`packages/db/src/reprice-cli.ts`) — MIRROR `rotate-key-cli.ts`:**
```ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { getActiveCatalog } from "./repositories/pricing-catalogs.js";
import { repriceAll } from "./repositories/reprice.js";

// M12 12.5a — retroactively re-price the archive under the ACTIVE catalog. Entrypoint MIRROR
// of rotate-key-cli.ts. Back up first (docs/guide/operations.md). Requires an active catalog.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const { db, pool } = createDb(url);
let message: string;
try {
  const active = await getActiveCatalog(db);
  if (!active) {
    throw new Error("no active catalog to re-price under (approve one first)");
  }
  const { repriced, catalogVersion } = await repriceAll(db, active);
  message = `re-priced ${repriced} events under catalog ${catalogVersion}`;
} finally {
  await pool.end();
}
console.log(message);
```
> **GOTCHA:** do NOT `process.exit()` before `pool.end()` (it would skip the `finally`); throw on the
> no-active case (top-level await → non-zero exit + the `finally` still closes the pool — mirrors
> `migrate-cli.ts` throwing on a missing `DATABASE_URL`).

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (the re-derivation engine)
The `repriceAll` repo function + its barrel export — the load-bearing piece, validated by a repo int test.

### Phase 2: Surfaces (route + CLI)
The admin-gated `POST /v1/replay/reprice` route (registered in `app.ts`) and the `db:reprice` CLI +
npm-script forwarders.

### Phase 3: Validation & docs
Repo int test + route int test (both must run, 0-skipped, against the test DB), then the
`docs/guide/operations.md` runbook section. Mark SUMMARY §6 12.5 / PRD §25 12.5 done at sign-off.

---

## STEP-BY-STEP TASKS

> Execute in order; run each task's VALIDATE before moving on. `npx tsc -b` = the repo-root backend
> typecheck (4 backend workspaces). The dashboard is untouched in this slice.

### Task 1 — CREATE `packages/db/src/repositories/reprice.ts`
- **IMPLEMENT**: `repriceAll(db, catalog)` + `RepriceResult` exactly per the Patterns snippet.
- **PATTERN**: `packages/db/src/repositories/key-rotation.ts` (the `db.transaction` + `for(;;)` batched
  loop); predicate semantics from `ingest.ts:62-68`.
- **IMPORTS**: `{ and, asc, eq, isNotNull, sql } from "drizzle-orm"`; `{ computeCost, type ModelPricing }
  from "@420ai/shared"`; `type { Db } from "../client.js"`; `{ events } from "../schema.js"`.
- **GOTCHA**: use `sql\`${events.catalogVersion} IS DISTINCT FROM ${catalog.version}\`` — NOT `ne(...)` /
  `<>` (excludes NULL `catalog_version` rows). `r.tokens!` (WHERE-guarded non-null); `r.model ?? undefined`
  (column is `string | null`; `computeCost` takes `string | undefined`).
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 2 — UPDATE `packages/db/src/index.ts` (barrel export)
- **IMPLEMENT**: after the `reencryptAll` exports (lines 116-117) add
  `export { repriceAll } from "./repositories/reprice.js";` and
  `export type { RepriceResult } from "./repositories/reprice.js";`.
- **VALIDATE**: `npx tsc -b` exits 0; `node -e "import('@420ai/db').then(m=>console.log(typeof m.repriceAll))"`
  prints `function` (after a build) — or just rely on the int test in Task 3.

### Task 3 — CREATE `packages/db/src/repositories/reprice.int.test.ts`
- **IMPLEMENT**: MIRROR `pricing-catalogs.int.test.ts` scaffold (`TEST_URL`, `describe.skipIf(!TEST_URL)`,
  `beforeAll createDb`, `afterAll pool.end`, `beforeEach TRUNCATE … RESTART IDENTITY CASCADE` + seed a
  user + machine). Seed events via `ingestBatch(dbh.db, machineId, batch)` **with no repricing arg** so
  they store verbatim. Use a batch of four events (copy the spike): `a` NULL `catalogVersion` cost-bearing,
  `b` `"m10-catalog-v1"` cost-bearing, `c` already-active-version cost-bearing, `d` `usage.reported`
  (tokens, no cost). Define `ACTIVE = { version: "v-new", rates: { "claude-opus-4-8": rate({ input: 10e-6 }) } }`.
  Cases:
  1. `repriceAll(dbh.db, ACTIVE)` → `{ repriced: 2, catalogVersion: "v-new" }`; `a` and `b` now
     `(cost->>'usd')::float ≈ 0.01` (1000 input × 10e-6) and `catalog_version = "v-new"`.
  2. `c` (already at `v-new`) is **untouched** (`usd` unchanged, e.g. `0.005`).
  3. `d` (`usage.reported`) still has `cost = NULL`, `catalog_version = NULL` (re-pricing never adds a cost).
  4. A second `repriceAll(dbh.db, ACTIVE)` → `{ repriced: 0, … }` (idempotent; loop terminates).
- **PATTERN**: the `(cost->>'usd')::float` raw-SQL assertion + `costBatch()` shape from
  `pricing-catalogs.int.test.ts:147-172`.
- **GOTCHA**: to seed `a` with a NULL `catalog_version`, OMIT `catalogVersion` on that `EventPayload`
  (ingestBatch with no repricing stores it as-is → NULL). To seed `c` at the active version, set its
  `catalogVersion: "v-new"` on the wire event.
- **VALIDATE**: with the test DB up — `npx vitest run packages/db/src/repositories/reprice.int.test.ts`
  → all pass, **0 skipped**. (`DATABASE_URL_TEST` is auto-injected from `.env` by vitest; confirmed during
  planning. If it skips, the test DB isn't migrated — see the memory note "Test DB not migrated by
  db:migrate".)

### Task 4 — ADD `db:reprice` npm scripts
- **IMPLEMENT**: `packages/db/package.json` scripts → add `"db:reprice": "tsx src/reprice-cli.ts"` (next
  to `db:rotate-key`). Root `package.json` scripts → add
  `"db:reprice": "npm run -w @420ai/db db:reprice"` (next to the `db:rotate-key` forwarder).
- **VALIDATE**: `git diff package.json packages/db/package.json` shows the two additions; `npm run db:reprice`
  is resolvable (it will throw "no active catalog" if none is active — that's the Task-5 path, expected).

### Task 5 — CREATE `packages/db/src/reprice-cli.ts`
- **IMPLEMENT**: per the Patterns snippet (MIRROR `rotate-key-cli.ts`).
- **IMPORTS**: `{ config } from "dotenv"`; `{ fileURLToPath } from "node:url"`; `{ createDb } from
  "./client.js"`; `{ getActiveCatalog } from "./repositories/pricing-catalogs.js"`; `{ repriceAll } from
  "./repositories/reprice.js"`.
- **GOTCHA**: throw (don't `process.exit`) before `pool.end()`; `await` is top-level (ESM module). This is
  an entrypoint — logging/argv/exit are allowed here (CLAUDE.md).
- **VALIDATE**: `npx tsc -b` exits 0. Functional check in Task 9.

### Task 6 — CREATE `apps/ingest/src/routes/replay.ts`
- **IMPLEMENT**: admin-gated `POST /v1/replay/reprice` per the Patterns snippet.
- **IMPORTS**: `{ getActiveCatalog, repriceAll } from "@420ai/db"`; `{ adminAuthorized } from "../auth.js"`.
- **GOTCHA**: no `schema.body` (no body). 401 when not admin; 409 when `getActiveCatalog` is `undefined`.
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 7 — UPDATE `apps/ingest/src/app.ts` (register the route)
- **IMPLEMENT**: add `import replayRoutes from "./routes/replay.js";` (next to line 24
  `import catalogRoutes`) and `app.register(replayRoutes);` (right after `app.register(catalogRoutes);`,
  line 148).
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 8 — CREATE `apps/ingest/src/replay.int.test.ts`
- **IMPLEMENT**: MIRROR `app.int.test.ts` scaffold (`buildApp({ db, adminToken: ADMIN, analysisProvider:
  stubProvider, logger: false })`, `app.ready()`, `TRUNCATE` in `beforeEach`). Cases:
  1. `POST /v1/replay/reprice` with no auth → **401**.
  2. With `Bearer ADMIN` but **no active catalog** → **409** `{error:"no active catalog to re-price under"}`.
  3. Seed an active catalog (`insertPendingCatalog` + `approveCatalog` from `@420ai/db`) with a rate that
     differs from the wire cost, ingest a cost-bearing event (`ingestBatch`, no repricing → wire cost
     stored), then `POST /v1/replay/reprice` with `Bearer ADMIN` → **200** `{ repriced: 1, catalogVersion }`,
     and a follow-up read (`GET` a projection, or query the DB directly in-test) confirms the event's
     `cost.usd` changed to the catalog rate.
- **PATTERN**: `app.int.test.ts` (inject + headers); catalog seeding from `pricing-catalogs.int.test.ts`.
- **GOTCHA**: this is a NEW `buildApp` caller but uses only existing options — no opts change. The admin
  bearer goes in the `authorization` header (`Bearer ${ADMIN}`), matching `adminAuthorized`.
- **VALIDATE**: with the test DB up — `npx vitest run apps/ingest/src/replay.int.test.ts` → all pass,
  **0 skipped**.

### Task 9 — DOCUMENT in `docs/guide/operations.md`
- **IMPLEMENT**: add a "Retroactive re-pricing (archive replay)" section: what it does (apply the active
  catalog to existing events), how to run it (`npm run db:reprice`, or `POST /v1/replay/reprice`), and the
  caveats — **back up first** (`npm run backup`, 12.4d); it only re-prices when a catalog is **active**;
  an **incomplete uploaded catalog zeroes** the cost of any model it omits (same as going-forward ingest);
  it is **idempotent** (safe to re-run). Note that re-pricing touches only the re-derivable `cost`/
  `catalog_version` projection — **raw records and the fingerprint are untouched**.
- **VALIDATE**: `rg "Retroactive re-pricing|db:reprice|back up first" docs/guide/operations.md` → ≥1.

### Task 10 — Sign-off updates (do at the END, after the gate is green)
- **IMPLEMENT**: SUMMARY.md §6 — mark 12.5 done (mirror the 12.4 done-bullet style; note re-parse 12.5b
  deferred). Optionally annotate PRD §25 12.5 as "12.5a re-price DONE; 12.5b re-parse deferred".
- **VALIDATE**: `rg "12.5" SUMMARY.md` shows the updated status.

---

## TESTING STRATEGY

### Unit Tests
No new pure-unit test is required — `computeCost` is already unit-tested (`packages/shared/src/cost.test.ts`)
and `repriceAll` is a DB operation (its logic is the SQL predicate + the loop, which only mean anything
against Postgres). The repo int test (Task 3) is the primary correctness proof.

### Integration Tests (the load-bearing layer here)
- **`reprice.int.test.ts`** (Task 3) — the engine: NULL + old rows repriced, active skipped, costless
  untouched, idempotent re-run. This is the productionized form of the planning spike.
- **`replay.int.test.ts`** (Task 8) — the route: 401 (no auth), 409 (no active catalog), 200 + cost
  actually changed.
- Both **must run against the test DB, 0-skipped** — a skipped int layer is not evidence (CLAUDE.md
  "Validation is a GATE").

### Edge Cases (must be covered by the int tests above)
- Event with **NULL `catalog_version`** (pre-replay-metadata capture) → **included** (the `IS DISTINCT
  FROM` trap). *(reprice.int.test.ts case 1)*
- Event already at the active version → **skipped** (idempotent + loop-advance). *(case 2 + 4)*
- `usage.reported`/`message.*` (tokens but no `cost`) → **never gains a cost**. *(case 3)*
- **No active catalog** → route 409, CLI throws (no rows mutated). *(replay.int.test.ts case 2)*
- Model present but absent from the active catalog → `usd 0, "estimated-model-unknown"` (parity with
  ingest; documented in the runbook). *(optional extra case; not required for the gate)*

---

## VALIDATION COMMANDS

All commands run from the repo root. Pass signal noted per command.

### Level 1: Syntax & Type (repo-root backend typecheck — catches cross-project/test-only imports)
- `npx tsc -b` → **exit 0**.

### Level 2: Focused unit/int tests
- `npx vitest run packages/db/src/repositories/reprice.int.test.ts` → **all pass, 0 skipped**.
- `npx vitest run apps/ingest/src/replay.int.test.ts` → **all pass, 0 skipped**.

### Level 3: Full gate WITH the DB layer asserted to have run
- `npm run db:up && npm run db:migrate` (and ensure `420ai_test` is migrated — see the memory note "Test
  DB not migrated by db:migrate"), then
- `npm run repo-health -- --require-db` → **exit 0**, and it asserts the `*.int.test.ts` layer actually
  ran (0 skipped). This is the milestone sign-off gate (CLAUDE.md "Validation is a GATE / `--require-db`").

### Level 4: Manual validation (functional)
- With an active catalog approved and some cost-bearing events present:
  `npm run db:reprice` → prints `re-priced N events under catalog <version>` (N ≥ 0); a second run prints
  `re-priced 0 events …` (idempotent).
- `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:PORT/v1/replay/reprice` →
  `200 {"repriced":N,"catalogVersion":"…"}`; without the header → `401`; with no active catalog → `409`.

---

## ACCEPTANCE CRITERIA

- [ ] `repriceAll(db, {version, rates})` recomputes `cost` + re-stamps `catalog_version` for every
      cost-bearing event (cost+tokens+model present), including rows with a NULL `catalog_version`.
- [ ] Re-pricing is **shape-preserving** — it never adds a `cost` to a costless event.
- [ ] Re-running `repriceAll` under the same catalog reprices **0** rows (idempotent; loop terminates).
- [ ] `POST /v1/replay/reprice` is admin-gated (401), returns 409 when no catalog is active, and 200
      `{repriced, catalogVersion}` otherwise.
- [ ] `npm run db:reprice` works as an ops entrypoint and closes the pool cleanly.
- [ ] **No schema migration; the event fingerprint is unchanged; no existing call site is modified.**
- [ ] `npm run repo-health -- --require-db` passes with the two new int tests run (0 skipped).
- [ ] `docs/guide/operations.md` documents the procedure + caveats.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately.
- [ ] `npx tsc -b` exits 0.
- [ ] `reprice.int.test.ts` + `replay.int.test.ts` pass, 0 skipped, against the test DB.
- [ ] `npm run repo-health -- --require-db` is green.
- [ ] Manual `db:reprice` + `POST /v1/replay/reprice` smoke checks pass.
- [ ] Runbook updated; SUMMARY/PRD sign-off bullets updated.
- [ ] Reviewed for the "raw sacred / fingerprint untouched / additive only" invariants.

---

## NOTES

### Spikes actually run during planning (evidence for the confidence score)
1. **Harness viability** — ran `pricing-catalogs.int.test.ts` against the live `420ai_test` DB:
   **8 passed, 0 skipped, 2.7s**. Confirms the test DB is up + migrated, vitest auto-injects
   `DATABASE_URL_TEST` from `.env`, and the seeding helpers (`insertPendingCatalog`/`approveCatalog`/
   `ingestBatch` + `costBatch()`) that the new tests reuse all work.
2. **The `IS DISTINCT FROM` + batched-loop spike** (the one genuinely uncertain bit) — wrote a throwaway
   `__reprice_spike.int.test.ts` that inlined the candidate `repriceAll` logic with `BATCH=2` and four
   seeded events (NULL / old / active / costless), ran it against the test DB: **passed**. Proved:
   NULL-`catalog_version` rows are repriced; old-version repriced; active skipped; costless untouched;
   `repriced === 2`; a second run returns `0` (loop terminates / idempotent). The throwaway was deleted;
   its assertions are folded into the Task-3 spec and the Patterns snippet. `npx tsc -b` was confirmed
   **exit 0** before and after (clean baseline).
3. **Symbol/semantics verification (by reading source, not memory):** `computeCost`
   (`cost.ts:60`), `getPricing` no-fallback behavior (`pricing.ts:108-113`), the `ingestBatch` D2 predicate
   + `set` (`ingest.ts:62-106`), `getActiveCatalog`'s `{version, rates}` shape (`pricing-catalogs.ts:82`),
   the `reencryptAll` loop shape (`key-rotation.ts`), the barrel (`index.ts`), `app.ts` registration block,
   `adminAuthorized` usage (`catalog.ts`/`metrics.ts`), and the `db:rotate-key` npm-script wiring.

### Design decisions / trade-offs
- **Re-price targets the *active* catalog only; 409/throw when none.** Symmetric with `ingestBatch`'s
  `repricing` param (which is the active catalog or absent). Re-pricing "under the bundled baseline" is
  intentionally NOT offered — with no active catalog, events are already at the bundled baseline from
  capture, so it would be a near-no-op.
- **Manual trigger, not auto-on-approve.** Matches PRD Q6 ("Updates: manual trigger first") and keeps
  `approveCatalog`'s blast radius at zero. The runbook tells the operator to run `db:reprice` after an
  approve. A future enhancement could offer an opt-in "reprice now" on the approve route.
- **Skip-by-version, no `force`.** Catalog versions are immutable (idempotent by version), so skipping
  rows already at the active version is always correct. A `force` flag (recompute regardless, for when
  `computeCost` *code* changes under a reused version) is a deferrable nicety, not needed for the gap.
- **One transaction for the whole `events` sweep**, mirroring `reencryptAll`. Acceptable at single-user
  self-hosted scale (same precedent already shipped in 12.4e). If the archive ever grows past comfortable
  single-txn size, the loop can be re-chunked into per-batch transactions — noted, not done.
- **Backend-only; no dashboard button in this slice.** Mirrors how 12.1 search shipped backend-first
  (12.2 added the UI). A "Re-price now" button on the catalog admin surface is a natural follow-up
  (additive `apps/dashboard` via the existing proxy) but is out of 12.5a scope.

### Deferred → 12.5b (re-parse engine) — design sketch for the follow-up plan
The other half of PRD §23 (re-derive events from raw with an improved parser). Not in this plan because it
is large and fingerprint-touching. Key constraints surfaced during this analysis, to seed 12.5b:
- **App boundary:** `apps/ingest` references only `packages/shared` + `packages/db` (`tsconfig.json:7-9`);
  it cannot import the collector's parsers. The pure `parse(fileText)` functions (`claude-code.ts`,
  `codex-cli.ts`, `gemini-cli.ts`, `custom-connector.ts`) would need to move into `packages/shared` (their
  `parse` is pure string→`ParseResult`; only `discoverRoots`/config helpers touch `node:fs`, which stay in
  the collector). This relocates **fingerprint-bearing code** — handle with care + a frozen-fingerprint
  test.
- **Whole-file parser:** parsers consume the *entire* file (cross-line `tool_use`→`tool_result`
  correlation; `session.started/ended` from min/max ts). Server-side re-parse must **reassemble the full
  file** from per-line `raw_source_records`, **in original line order**, then re-run `parse`.
- **Order recovery:** Claude keys `rawId` on each record's `uuid` → order-independent. But
  Codex/custom/Gemini-fallback key `rawId` on `${session}:${lineIndex}` and `raw_source_records` stores
  **no sequence column** (`schema.ts`: random `id` + `defaultNow()` `createdAt`). Order is only recoverable
  by parsing the index back out of `source_record_id`, OR 12.5b adds a `line_index` column (a schema
  migration). Decide this first in 12.5b.
- **Decrypt server-side:** raw payloads are encrypted (`payload_ciphertext`); re-parse must `decryptField`
  them (the keyring from 12.4e already supports this server-side).
- Re-parse then feeds the **same upsert-by-fingerprint** path (`ingestBatch` events upsert) → zero
  duplicates by §23. The `/v1/replay/reparse` route would sit in the `replay.ts` this plan creates.

### Confidence
**9.6 / 10** for one-pass success. Evidence: the one non-obvious correctness point (NULL-`catalog_version`
inclusion via `IS DISTINCT FROM` + batched-loop termination) was **executed and proven** against the live
test DB during planning; every imported symbol and the mirrored patterns were read from source (not
memory); the test harness was confirmed working (8/8, 0 skipped); the baseline is green (`tsc -b` exit 0);
and the blast radius is minimal (3 new modules + 2 new tests + barrel/registration/script wiring; **zero
schema change, fingerprint untouched, no existing call site modified**). The residual <0.4 is ordinary
execution variance (e.g. exact int-test seeding ergonomics), not an unretired unknown.
