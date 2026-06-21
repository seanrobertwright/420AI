# Feature: M12 Slice 12.7c — Connector-catalog-as-data (§10.4)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils/types/models — import from the right files (relative imports end in `.js`; `import type` for
type-only). Conventions live in [`CLAUDE.md`](../../CLAUDE.md) — **read it; this plan links, never
re-pastes**.

> **Sibling slices (M12.7 bundle):** 12.7a (Codex failure classification), 12.7b (permission scopes),
> **12.7c (this)**, 12.7d (Cursor/Antigravity gates — resolved/deferred). Each is its own plan file.
> **Read the "Coupling with 12.7b" section in NOTES before touching the connector data shape** — 12.7b
> defines `ConnectorFidelity.requiredPermissions` and the capture-surface approval gate; this slice makes
> connector *metadata/locations* catalog-driven and must feed catalog-sourced scope through 12.7b's
> fingerprint. **Recommended order: 12.7b first, then 12.7c.**

## Feature Description

The M10 3d catalog-signing work (`@420ai/shared/catalog-signing.ts` + the `pricing_catalogs` table +
the four admin endpoints) is **pricing-only**: a signed, admin-approved, ed25519-verified catalog that
re-prices ingests. PRD §10.4 requires the **connector catalog** itself to be data too — _"the connector
catalog must update independently from app releases"_ with a **bundled baseline**, **signed remote
updates**, **local overrides**, and **user approval for capture-surface changes**.

This slice extends the **same** signed-catalog machinery to connector **definitions/metadata/locations**:
a signed `connector_catalogs` document carries, per connector id, its watch locations, fidelity labels,
required-permission scope, and enable/active status — so a connector's watched paths or fidelity can be
updated (and audited/approved) **without a code release**, exactly like pricing. The **parsers stay in
code** (PRD §39: a script/plugin runtime is a NON-GOAL); the catalog is a **metadata + location overlay**
onto code-keyed connectors, plus a channel for **signed custom-style** connectors (the data-only kind the
M10-S2 custom-connector factory already compiles).

## User Story

As a self-hosting operator
I want connector definitions (watched paths, fidelity, permission scope, which connectors are active) to
be **signed catalog data** I can review and approve — not hardcoded in the app
So that I can adopt a corrected watch path, a new fidelity label, or a vetted new connector via a signed
catalog update, with the same trust + approval guarantees the pricing catalog already has, and **never**
have my capture surface silently widened.

## Problem Statement

Connector definitions are **hardcoded**: the registry is a static array
(`apps/collector/src/connectors/connector.ts:73` `connectors = [claudeCode, codex, gemini]`), merged with
the unsigned local `~/.420ai/custom-connectors.json` (`registry.ts:loadRegistry`). There is no signed,
bundled-baseline, admin-approved channel to update connector watch locations or metadata independently of
an app release — PRD §10.4's core requirement. The signing/lifecycle primitive to do this **already
exists** but is wired only to pricing.

## Solution Statement

Reuse the **proven pricing-catalog pattern end-to-end**, parameterized for a connector payload:

1. **Signing (generalize, don't fork):** the `canon`/`canonicalizeCatalog` serializer in
   `catalog-signing.ts` is already payload-agnostic. Make `CatalogContent`/`SignedCatalog`/
   `verifyCatalogSignature` **generic over the payload type** (default stays `Record<string,
   ModelPricing>` ⇒ zero ripple on pricing), and add a bundled `CONNECTOR_CATALOG_PUBLIC_KEY` +
   `ConnectorCatalogPayload` type. The offline `scripts/sign-catalog.ts` gains a connector-catalog mode.
2. **Server lifecycle (mirror `pricing_catalogs` 1:1):** a new additive `connector_catalogs` table
   (migration `0011` + a `down/` SQL), a `connector-catalogs.ts` repository
   (insert-pending → approve/reject, partial-unique ≤1 active, idempotent by version), and four
   admin-gated endpoints (`POST/GET /v1/connector-catalog`, `:id/approve`, `:id/reject`) — a structural
   copy of `pricing-catalogs.ts` + `routes/catalog.ts`.
3. **Collector consumption (the one genuinely new part):** a machine-authed
   `GET /v1/connector-catalog/active` returns the active catalog (or `204`/empty when none). The collector
   caches it at `~/.420ai/connector-catalog.json` and **overlays** it onto the built-in registry in
   `loadRegistry`: known ids get metadata/location overrides; unknown signed entries compile through the
   existing custom-connector factory. **With no active catalog the registry is byte-identical to today**
   (the bundled baseline = the current hardcoded connectors) — default-on, exactly like pricing's "no
   active catalog ⇒ bundled `PRICING_CATALOG`".
4. **Approval coupling (§10.4 / 12.7b):** catalog-overlaid `watchGlobs`/`requiredPermissions` flow through
   12.7b's `captureSurfaceFingerprint`, so **a signed catalog update that widens a connector's scope flips
   it to `needs-approval`** until the user approves — the literal §10.4 "user approval for capture-surface
   changes".

> **Two resolved architecture decisions (do NOT re-litigate at implementation time):**
> **(A) Parsers stay code; the catalog overlays metadata + locations only.** A connector's `parse` cannot
> be data without a plugin runtime, which PRD §39 forbids. Catalog entries map by `id` onto code-resident
> parsers; an entry with no matching built-in parser is compiled by the **existing custom-connector
> factory** (data-only `jsonl`/`regex` mapping), which is the sanctioned "connector as data" path.
> **(B) Distribution = bundled baseline + admin-approved server copy + collector pull + local cache.** The
> server owns the canonical signed/approved catalog (so the dashboard can review/approve, mirroring
> pricing); the collector pulls the **active** one and caches it for offline use; the bundled baseline in
> `@420ai/shared` is the floor. This mirrors §10.4's "bundled baseline + signed updates + local overrides".

## Feature Metadata

**Feature Type**: New Capability (signed connector-catalog channel) + Enhancement (data-driven registry)
**Estimated Complexity**: High (spans `packages/shared`, `packages/db` + migration, `apps/ingest`,
`apps/collector`). **Recommend executing as two internal sub-slices — see "Recommended sub-slicing".**
**Primary Systems Affected**: `packages/shared` (signing generalization + connector-catalog types +
bundled key/baseline), `packages/db` (`connector_catalogs` table + repo + migration `0011`), `apps/ingest`
(admin endpoints + machine-authed active endpoint), `apps/collector` (registry overlay + cache).
**Dependencies**: none new (`node:crypto` only — same as pricing signing).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/shared/src/catalog-signing.ts` (whole file) — Why: the ed25519 primitive you **generalize**.
  Key symbols: `canonicalizeCatalog(content)` / the recursive `canon` (already payload-agnostic),
  `verifyCatalogSignature(content, signatureB64, publicKeyPem = CATALOG_PUBLIC_KEY)`, `CATALOG_PUBLIC_KEY`,
  `SignedCatalog { version, payload, signature }`, `CatalogContent { version, payload }`. ed25519 needs
  the digest arg `null` (line 85) — do not change that.
- `packages/shared/src/catalog-signing.test.ts` — Why: the signing test harness (signs with an ephemeral
  keypair via `generateKeyPairSync("ed25519")`, asserts verify true/false on tamper). Mirror for the
  connector-catalog payload.
- `packages/db/src/repositories/pricing-catalogs.ts` (whole file) — Why: the **exact lifecycle to mirror**.
  `PricingCatalogRow`, `toRow` (Date→ISO normalization — **a documented gotcha; keep it**),
  `insertPendingCatalog` (`onConflictDoNothing` idempotent-by-version), `getActiveCatalog`, `listCatalogs`
  (`desc(uploadedAt)`), `approveCatalog` (txn: demote active → promote pending, partial-unique safe),
  `rejectCatalog`, `countPendingCatalogs`.
- `packages/db/src/repositories/pricing-catalogs.int.test.ts` (**READ FIRST** — exists) — Why: the
  int-test harness you mirror for `connector-catalogs.int.test.ts` (the seed/lifecycle assertions, the
  `describe.skipIf(!process.env.DATABASE_URL_TEST)` guard).
- `packages/db/src/schema.ts` (the `pricingCatalogs` table + its **partial unique index** on
  `status = 'active'`) — Why: copy the table shape verbatim for `connectorCatalogs`. **Read the exact
  index definition** — the ≤1-active guarantee depends on it.
- `packages/db/drizzle/0007_skinny_paper_doll.sql` + `packages/db/drizzle/down/0007_*.down.sql` — Why: the
  migration + rollback shape to mirror. **The next migration is `0011`** (latest on disk is `0010`,
  verified). Generate via the project's Drizzle flow; hand-write the matching `down/0011_*.down.sql`
  (`DROP TABLE connector_catalogs;`).
- `apps/ingest/src/routes/catalog.ts` (whole file) — Why: the 4-endpoint pattern to mirror
  (`adminAuthorized` → `isUuid(id)` else 404 → repo → `undefined`→404; `verifyCatalogSignature(...,
  app.catalogPublicKey)` bad→400). You add a 5th **machine-authed** `GET /v1/connector-catalog/active`.
- `apps/ingest/src/app.ts` + `apps/ingest/src/server.ts` — Why: how `app.catalogPublicKey` is injected
  (`buildApp({ catalogPublicKey })`) and routes registered. You add `app.connectorCatalogPublicKey`
  (injectable for tests) and register the new routes. **Read the `buildApp` options + route registration.**
- `apps/ingest/src/routes/heartbeat.ts` (or `ingest.ts`) — Why: the **machine-authed** (not admin) auth
  pattern for `GET /v1/connector-catalog/active` — the collector calls it with its ingest token, not the
  admin token. Mirror the machine bearer-auth used by `/v1/heartbeat`/`/v1/ingest`.
- `apps/collector/src/connectors/registry.ts` (whole file) — Why: `loadRegistry(home, opts)` is the single
  merge point you extend with the catalog overlay. It already merges built-ins + custom defs and returns
  `{ connectors, dropped }`.
- `apps/collector/src/connectors/custom-connector.ts` (whole file) — Why: `validateCustomDef` +
  `makeCustomConnector` are the **sanctioned data→connector path** for catalog entries with no built-in
  parser (decision A). `CustomConnectorDef` is the entry shape you extend/reuse.
- `apps/collector/src/connectors/connector-config.ts` (whole file) — Why: the tolerant load/save pattern
  (version stamp, absent/corrupt ⇒ safe default, `0o600`, `path` seam) the `~/.420ai/connector-catalog.json`
  cache mirrors. Also where `loadConnectorConfig` lives — the catalog overlay composes with it.
- `apps/collector/src/connectors/connector.ts` (`Connector`/`ConnectorFidelity`, line 73 registry) — Why:
  the contract the overlay mutates (metadata/locations) and the static array the baseline reflects.
- `packages/shared/src/pricing.ts` (the bundled `PRICING_CATALOG`) — Why: the precedent for a **bundled
  baseline** shipped in `@420ai/shared`; the connector baseline ships the same way.

### New Files to Create

- `packages/shared/src/connector-catalog.ts` — `ConnectorCatalogEntry`/`ConnectorCatalogPayload` types,
  the bundled `CONNECTOR_CATALOG_PUBLIC_KEY`, the bundled baseline `CONNECTOR_CATALOG_BASELINE`, and a pure
  `mergeConnectorCatalog(builtins, customDefs, catalog?)` overlay (no I/O).
- `packages/shared/src/connector-catalog.test.ts` — overlay + baseline unit tests.
- `packages/db/src/repositories/connector-catalogs.ts` — lifecycle repo (mirror `pricing-catalogs.ts`).
- `packages/db/src/repositories/connector-catalogs.int.test.ts` — lifecycle int test (mirror pricing's).
- `packages/db/drizzle/0011_*.sql` + `packages/db/drizzle/down/0011_*.down.sql` — the table + rollback.
- `apps/ingest/src/routes/connector-catalog.ts` — the 5 endpoints.
- `apps/ingest/src/connector-catalog.int.test.ts` — endpoint int test (mirror `catalog.int.test.ts`).
- `apps/collector/src/connectors/connector-catalog-cache.ts` — tolerant `~/.420ai/connector-catalog.json`
  load/save (mirror `connector-config.ts`) + the fetch-on-startup wiring helper.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) §10.4 (catalog updates: bundled baseline / signed updates / local
  overrides / config-only custom / **user approval for capture-surface changes**), §10.1/§10.3 (connector
  metadata fields the payload carries), §18/§20/§23 (signing trust / approval alert / replay versioning),
  §39 (script/plugin runtime is a **non-goal** — decision A), §25 M12 slice 12.7.
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — "Connector Catalog", "Capture Surface Change", "Connector
  Fidelity". **Name code after these terms.**
- [`scripts/CATALOG-SIGNING.md`](../../scripts/CATALOG-SIGNING.md) — the offline-signing workflow you
  extend with a connector-catalog mode.

### Patterns to Follow

**Generalize the signer (backward-compatible — pricing keeps working):**

```ts
// catalog-signing.ts — make the content generic; default preserves the pricing call sites.
export interface CatalogContent<P = Record<string, ModelPricing>> { version: string; payload: P; }
export interface SignedCatalog<P = Record<string, ModelPricing>> extends CatalogContent<P> { signature: string; }
export function verifyCatalogSignature<P>(
  content: CatalogContent<P>, signatureB64: string, publicKeyPem: string = CATALOG_PUBLIC_KEY,
): boolean { /* body unchanged — canon() is already payload-agnostic */ }
```

**Lifecycle repo (mirror `pricing-catalogs.ts` — keep the Date→ISO `toRow` normalization):** the
connector repo is a structural copy with `payload: ConnectorCatalogPayload` instead of
`Record<string, ModelPricing>`. `getActiveConnectorCatalog` returns `{ version, payload } | undefined`
(undefined ⇒ collector falls back to the bundled baseline — the default-on contract).

**Overlay (pure, in `@420ai/shared` so both collector and tests share it):**

```ts
/**
 * Overlay an approved connector catalog onto the built-in registry metadata.
 * Decision A: parsers stay code — only locations/fidelity/permissions/active are overlaid by id.
 * Entries with no built-in id are compiled via the custom-connector factory (data-only).
 * No catalog (undefined) ⇒ the builtins+customs are returned unchanged (baseline == today).
 */
```

> **DB-gotcha compliance (CLAUDE.md "Drizzle / SQL gotchas"):** the repo reads `status` text +
> `uploaded_at`/`approved_at` **timestamptz → JS `Date`**; `toRow` MUST `.toISOString()` them (copy
> pricing's `toRow`, lines 29-51). No aggregate `min/max`/`date_trunc` here, but the same Date-normalization
> trap applies to the plain timestamptz columns. Write paths guard existence (`isUuid` → 404, then repo
> `undefined` → 404) — never a constraint/cast 500 (mirror `routes/catalog.ts`).

---

## IMPLEMENTATION PLAN

### Phase 1: Signing generalization + connector-catalog types (`packages/shared`)

Make `CatalogContent`/`SignedCatalog`/`verifyCatalogSignature` generic (default = pricing, zero ripple).
Add `connector-catalog.ts`: `ConnectorCatalogEntry` (`id`, optional `displayName`, `watchGlobs?`,
fidelity overlay incl. `requiredPermissions?` (12.7b coupling), `enabled?`, `captureMode?`, optional
custom-connector `def` for data-only entries), `ConnectorCatalogPayload { connectors: ConnectorCatalogEntry[] }`,
`CONNECTOR_CATALOG_PUBLIC_KEY` (bundled; injectable in tests), `CONNECTOR_CATALOG_BASELINE` (the current
built-ins' metadata as data), and the pure `mergeConnectorCatalog` overlay.

### Phase 2: Server lifecycle (`packages/db` + `apps/ingest`) — the high-confidence pricing mirror

`connector_catalogs` table (migration `0011` + `down/`), `connector-catalogs.ts` repo (copy pricing's
lifecycle), and `routes/connector-catalog.ts` (4 admin endpoints mirroring `routes/catalog.ts`) + a 5th
**machine-authed** `GET /v1/connector-catalog/active`. Inject `app.connectorCatalogPublicKey` via
`buildApp`. Int tests mirror pricing's.

### Phase 3: Collector consumption (the new part)

`connector-catalog-cache.ts` (tolerant `~/.420ai/connector-catalog.json` load/save). On collector startup
(in the `watch`/`serve` entrypoint), best-effort fetch `GET /v1/connector-catalog/active` with the ingest
token; on success cache it; on failure use the cache; with neither use the bundled baseline. Wire
`loadRegistry` to apply `mergeConnectorCatalog(builtins, customDefs, cachedCatalog)`.

### Phase 4: Approval coupling (12.7b) + offline signer + docs

Ensure catalog-overlaid `watchGlobs`/`requiredPermissions` flow into 12.7b's `captureSurfaceFingerprint`
(if 12.7b shipped first, this is automatic — the overlay produces `Connector`s and 12.7b fingerprints
whatever the registry yields). Extend `scripts/sign-catalog.ts` + `CATALOG-SIGNING.md`. Update
`docs/guide/operations.md` (catalog management) + `docs/guide/custom-connectors.md`.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is independently validatable. **(Sub-slice boundary: Tasks 1–9 = 12.7c-1
server+shared; Tasks 10–13 = 12.7c-2 collector. See "Recommended sub-slicing".)**

### Task 1 — UPDATE `packages/shared/src/catalog-signing.ts` (generalize, backward-compatible)

- **IMPLEMENT**: make `CatalogContent`/`SignedCatalog` generic with `P = Record<string, ModelPricing>`
  default; make `verifyCatalogSignature<P>` generic. Body unchanged (`canon` is already generic).
- **GOTCHA**: the default type param keeps every existing pricing call site compiling untouched. Do NOT
  change `canon`/`canonicalizeCatalog` bytes (would invalidate existing pricing signatures).
- **VALIDATE**: `npm run typecheck` (exit 0) + `npx vitest run packages/shared/src/catalog-signing.test.ts`.

### Task 2 — CREATE `packages/shared/src/connector-catalog.ts`

- **IMPLEMENT**: the types above + `CONNECTOR_CATALOG_PUBLIC_KEY` (generate an ed25519 keypair offline,
  bundle the public PEM, keep the private key in gitignored `.secrets/` — mirror `CATALOG_PUBLIC_KEY`),
  `CONNECTOR_CATALOG_BASELINE` (the three built-ins' id+watchGlobs+fidelity as data), and
  `mergeConnectorCatalog(builtins, customDefs, catalog?)`.
- **PATTERN**: `catalog-signing.ts` (bundled key) + `pricing.ts` (bundled baseline) + `custom-connector.ts`
  (`CustomConnectorDef` for data-only entries).
- **GOTCHA**: `@420ai/shared` is a **leaf** — it cannot import `Connector` from `apps/collector`. So
  `mergeConnectorCatalog` must operate on a **structural** connector shape (or take the builtins as a
  param typed by a shared interface). Prefer: the overlay takes `(builtins: ConnectorLike[], ...)` where
  `ConnectorLike` is the minimal shared shape, and the collector passes its real `Connector[]` (structurally
  compatible). Keep it pure (no fs/no crypto in the merge).
- **VALIDATE**: `npm run typecheck` + `npx vitest run packages/shared/src/connector-catalog.test.ts`.
- **Export** both new modules from `packages/shared/src/index.ts`.

### Task 3 — UPDATE `packages/db/src/schema.ts` — add `connectorCatalogs`

- **IMPLEMENT**: a table mirroring `pricingCatalogs` (uuid `id` default, `version` unique-ish via the
  idempotent insert, `payload` jsonb typed `ConnectorCatalogPayload`, `signature` text, `status` text,
  `uploaded_at`/`approved_at` timestamptz, `approved_by` text) + the **partial unique index** on
  `status = 'active'`.
- **GOTCHA**: copy the partial-unique index EXACTLY from `pricingCatalogs` — it enforces ≤1 active.
- **VALIDATE**: `npm run typecheck`.

### Task 4 — GENERATE migration `0011` + hand-write `down/0011_*.down.sql`

- **IMPLEMENT**: run the project's Drizzle generate flow (see `packages/db/package.json` scripts) to emit
  `0011_*.sql`; hand-write `down/0011_*.down.sql` = `DROP TABLE IF EXISTS connector_catalogs;`.
- **GOTCHA**: confirm latest is `0010` (verified on disk) ⇒ this is `0011`. The `down/` SQL is required
  (12.4 migration-rollback path). Apply to BOTH dev and the test DB (`420ai_test` is migrated separately
  — see memory `test-db-not-migrated-by-db-migrate`).
- **VALIDATE**: `npm run db:up && npm run db:migrate` (and migrate the test DB) — exit 0.

### Task 5 — CREATE `packages/db/src/repositories/connector-catalogs.ts`

- **IMPLEMENT**: structural copy of `pricing-catalogs.ts`: `ConnectorCatalogRow`, `toRow` (Date→ISO),
  `insertPendingConnectorCatalog` (idempotent by version via `onConflictDoNothing`),
  `getActiveConnectorCatalog` (`{ version, payload } | undefined`), `listConnectorCatalogs`,
  `approveConnectorCatalog` (txn demote→promote), `rejectConnectorCatalog`, `countPendingConnectorCatalogs`.
- **PATTERN**: `pricing-catalogs.ts` line-for-line; swap `ModelPricing` payload → `ConnectorCatalogPayload`.
- **GOTCHA**: keep the `toRow` `.toISOString()` normalization (the M5/M9 Date-vs-ISO trap). Export from
  `packages/db/src/index.ts`.
- **VALIDATE**: `npm run typecheck`.

### Task 6 — CREATE `packages/db/src/repositories/connector-catalogs.int.test.ts`

- **IMPLEMENT**: mirror `pricing-catalogs.int.test.ts` — `describe.skipIf(!process.env.DATABASE_URL_TEST)`;
  insert-pending idempotency, approve supersedes prior active (≤1 active holds), reject, count-pending,
  active-after-approve.
- **VALIDATE**: `npm run repo-health -- --require-db` (this test must RUN, not skip).

### Task 7 — UPDATE `apps/ingest/src/app.ts` / `server.ts` — inject the connector-catalog public key

- **IMPLEMENT**: add `connectorCatalogPublicKey?` to `buildApp` options + the fastify decoration (mirror
  `catalogPublicKey`); default to the bundled `CONNECTOR_CATALOG_PUBLIC_KEY`. Register the new routes.
- **PATTERN**: the existing `catalogPublicKey` injection (read `app.ts` for the exact decoration).
- **VALIDATE**: `npm run typecheck`.

### Task 8 — CREATE `apps/ingest/src/routes/connector-catalog.ts`

- **IMPLEMENT**: mirror `routes/catalog.ts` for the 4 admin endpoints (`POST/GET /v1/connector-catalog`,
  `:id/approve`, `:id/reject`) — `adminAuthorized` → signature-verify (bad→400) on POST → repo;
  `isUuid(id)` else 404 → repo `undefined`→404 on approve/reject. ADD a 5th **machine-authed**
  `GET /v1/connector-catalog/active` returning `getActiveConnectorCatalog(app.db)` (or `204` when none) —
  auth via the machine ingest-token guard (mirror `/v1/heartbeat`), NOT admin.
- **PATTERN**: `routes/catalog.ts` (admin endpoints) + `routes/heartbeat.ts` (machine auth).
- **GOTCHA**: the active endpoint is the ONLY machine-authed one; the rest stay admin-gated. A bad
  signature is a clean 400 (never 500). Add the body schema to `schemas.ts` (mirror `catalogUploadBodySchema`).
- **VALIDATE**: `npm run typecheck`.

### Task 9 — CREATE `apps/ingest/src/connector-catalog.int.test.ts`

- **IMPLEMENT**: mirror `catalog.int.test.ts` — build the app with an **ephemeral** connector-catalog key,
  sign a payload, POST (200 pending) / bad-sig (400) / GET list / approve / reject / and the machine-authed
  active endpoint returns the approved payload; unknown-id approve → 404; non-admin → 401; active with no
  catalog → 204/empty.
- **VALIDATE**: `npm run repo-health -- --require-db` (int test runs, 0 skipped).

### Task 10 — CREATE `apps/collector/src/connectors/connector-catalog-cache.ts`

- **IMPLEMENT**: tolerant load/save of `~/.420ai/connector-catalog.json` (mirror `connector-config.ts`:
  version stamp, absent/corrupt ⇒ `undefined`/safe default, `0o600`, `path` seam) + a
  `fetchActiveConnectorCatalog({ baseUrl, token, fetch? })` helper that GETs `/v1/connector-catalog/active`
  and **verifies the signature** against `CONNECTOR_CATALOG_PUBLIC_KEY` before caching (defense-in-depth:
  the collector re-verifies even though the server only serves approved catalogs).
- **PATTERN**: `connector-config.ts` (persistence) + `ingest-client.ts` (the collector's authed fetch).
- **GOTCHA**: library file — never log/exit; inject `fetch` for tests. A failed fetch is non-fatal (use
  the cache or the baseline). Verify the signature with the bundled key (a tampered cache file ⇒ ignored).
- **VALIDATE**: `npm run typecheck` + `npx vitest run apps/collector/src/connectors/connector-catalog-cache.test.ts`.

### Task 11 — UPDATE `apps/collector/src/connectors/registry.ts` — overlay the catalog

- **IMPLEMENT**: extend `loadRegistry(home, opts)` to accept an optional `catalog?: ConnectorCatalogPayload`
  (from the cache) and apply `mergeConnectorCatalog([...defaultConnectors], customDefs, catalog)` so
  metadata/locations overlay by id and signed data-only entries compile via `makeCustomConnector`. With no
  catalog, behavior is byte-identical to today (regression-guarded).
- **PATTERN**: the existing merge in `loadRegistry`.
- **GOTCHA**: preserve the existing `dropped[]` reasons + id-collision rules. The overlay must not break
  the M3/M4 capture core — it only adjusts the connector objects' metadata/globs.
- **VALIDATE**: `npm run typecheck` + `npx vitest run apps/collector/src/connectors/registry.test.ts`.

### Task 12 — WIRE startup fetch in the collector entrypoint(s)

- **IMPLEMENT**: in `cli.ts` (`watch`) and `serve.ts`, best-effort `fetchActiveConnectorCatalog` at
  startup, cache it, and pass the cached catalog into `loadRegistry`. On any failure, fall back to cache
  then baseline (never block capture). Entrypoint logs the outcome (library stays silent).
- **PATTERN**: the existing credential/registry resolution in `cli.ts`/`serve.ts`.
- **GOTCHA**: respect the leak-window rule (arm teardown before awaits); the fetch is one-shot at startup,
  not a long-lived resource. Offline-first: capture must start even if the fetch fails.
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts apps/collector/src/cli.test.ts`.

### Task 13 — Offline signer + docs

- **IMPLEMENT**: extend `scripts/sign-catalog.ts` with a connector-catalog mode (sign a
  `ConnectorCatalogPayload`); update `scripts/CATALOG-SIGNING.md`, `docs/guide/operations.md` (manage/approve
  a connector catalog; the machine-pull + offline fallback), `docs/guide/custom-connectors.md` (signed vs
  local custom connectors).
- **VALIDATE**: `npx tsx scripts/sign-catalog.ts --help` (or the documented invocation) runs
  non-interactively.

---

## TESTING STRATEGY

### Unit Tests

- `connector-catalog.test.ts` — `mergeConnectorCatalog`: no-catalog ⇒ baseline unchanged; id overlay
  updates globs/fidelity/permissions; data-only entry compiles to a connector; unknown built-in id with no
  `def` is dropped with a reason.
- `catalog-signing.test.ts` (updated) — the generic verify works for a connector payload (sign/verify/tamper).
- `connector-catalog-cache.test.ts` — tolerant load/save; signature-verify gate; injected-`fetch` success
  caches, failure falls back.
- `registry.test.ts` (updated) — overlay applied; no-catalog regression (byte-identical registry).

### Integration Tests (MUST actually run — this slice touches `@420ai/db` + `apps/ingest`)

- `connector-catalogs.int.test.ts` (repo lifecycle) + `connector-catalog.int.test.ts` (endpoints incl.
  machine-authed active). Both `describe.skipIf(!DATABASE_URL_TEST)` — **the gate must exercise them with
  the test DB up** (`repo-health -- --require-db`, 0 skipped).

### Edge Cases

- No active catalog ⇒ collector uses bundled baseline (registry == today). **Regression guard.**
- Tampered cache file / bad signature ⇒ ignored, baseline used (never captures off an unverified catalog).
- Catalog overlay **widens** a connector's `watchGlobs` ⇒ (with 12.7b) `needs-approval` until approved.
- Idempotent re-upload of an existing catalog version ⇒ returns the existing row (no duplicate).
- Approve supersedes prior active ⇒ ≤1 active holds (partial unique).
- Unknown/malformed id on approve/reject ⇒ 404, never a constraint 500.
- Collector offline at startup ⇒ capture still starts (cache → baseline).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE.

### Level 1: Typecheck & style
- `npm run typecheck` — root `tsc -b` (shared + db + ingest + collector); **exit 0**.
- `npm run lint` — **exit 0**.

### Level 2: Unit tests
- `npm test` — all new + updated unit suites pass (integration self-skips without a DB — expected here).

### Level 3: Full gate WITH the DB layer (REQUIRED — touches `@420ai/db` + `apps/ingest`)
- `npm run db:up && npm run db:migrate` (and migrate `420ai_test`), then
  `npm run repo-health -- --require-db` — **PASS with the two new `*.int.test.ts` actually executed (0
  skipped)**. A plain `repo-health` PASS is NOT sufficient sign-off for this slice (the int layer is the
  proof the table/endpoints work).

### Level 4: Manual validation
- Offline-sign a connector catalog, `POST /v1/connector-catalog` (admin), `:id/approve`, then
  `GET /v1/connector-catalog/active` (machine token) returns it; start the collector offline (no server)
  and confirm capture still starts on the bundled baseline; start it online and confirm the active catalog
  overlays (e.g. an updated `displayName`/glob shows via `connectors.list`).

### Level 5: Optional
- `npm run build:dashboard` only if a catalog-review UI is added (NOT in this slice — admin endpoints +
  offline signer only; a dashboard approve/reject UI is deferred, mirroring how pricing-catalog upload
  stayed CLI-only).

---

## ACCEPTANCE CRITERIA

- [ ] `catalog-signing` is generic over payload; **pricing call sites unchanged** and its tests still pass.
- [ ] `connector_catalogs` table + migration `0011` (+ `down/`) added; `connector-catalogs.ts` repo mirrors
      the pricing lifecycle (idempotent insert, ≤1 active, approve/reject, Date→ISO `toRow`).
- [ ] 4 admin endpoints + 1 machine-authed `GET /v1/connector-catalog/active`; bad signature → 400,
      unknown id → 404, non-admin → 401.
- [ ] Collector overlays the active (signature-verified) catalog onto the registry; **no active catalog ⇒
      registry byte-identical to today** (regression test passes); offline startup still captures.
- [ ] Catalog-overlaid scope flows through 12.7b's `captureSurfaceFingerprint` (a widening update ⇒
      `needs-approval`).
- [ ] `npm run typecheck`, `npm run lint`, and `npm run repo-health -- --require-db` (int tests ran, 0
      skipped) all PASS.
- [ ] Parsers stay code; no plugin/script runtime introduced (PRD §39).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE ran green.
- [ ] `repo-health -- --require-db` PASS with the connector-catalog int tests executed (0 skipped).
- [ ] Manual: sign → approve → machine-pull → overlay; offline fallback to baseline verified.
- [ ] `SUMMARY.md` §6 + PRD §25 updated to mark 12.7c done; `docs/guide/operations.md` documents the flow.

---

## NOTES

### Recommended sub-slicing (this is the biggest 12.7 sub-slice)

Execute as **12.7c-1** (Tasks 1–9: signing generalization + `connector_catalogs` table/repo/endpoints —
a near-exact, high-confidence mirror of the pricing catalog) then **12.7c-2** (Tasks 10–13: collector
overlay consumption + offline cache + startup fetch — the genuinely new part). 12.7c-1 ships value
standalone (a signed, admin-approved connector catalog the dashboard can manage) and de-risks 12.7c-2.

### Coupling with 12.7b (permission scopes) — honor this exactly

12.7b's plan (`.agents/plans/m12-slice7b-connector-permission-scopes.md`, "Coupling with 12.7c" section)
fixes the contract: `requiredPermissions` lives on `ConnectorFidelity`/`ConnectorInfo`, and
`captureSurfaceFingerprint(connector, home)` hashes sorted `watchGlobs + requiredPermissions`. This slice
must therefore: (1) carry `requiredPermissions` in each `ConnectorCatalogEntry` and overlay it onto the
connector's fidelity; (2) produce real `Connector` objects from the overlay so 12.7b's
`approvalStatus`/`filterByApproval` see catalog-sourced scope unchanged — i.e. **a signed catalog update
that widens a connector's globs/permissions automatically flips it to `needs-approval`** (the §10.4
"capture-surface change" trigger). **Recommended order: 12.7b first**, so this slice just feeds the existing
fingerprint. If 12.7c lands first, 12.7b still applies — the approval module is source-agnostic (in-code vs
catalog).

### Design decisions / trade-offs (resolved)

- **A — parsers stay code (PRD §39).** The catalog overlays metadata/locations/fidelity/active by `id`;
  data-only entries reuse the M10-S2 custom-connector factory. No plugin runtime is introduced. This is
  what keeps the slice bounded and the frozen capture core safe.
- **B — distribution = server-canonical + collector-pull + local cache + bundled baseline.** Mirrors
  §10.4. The server owns approval (dashboard-reviewable, like pricing); the collector pulls the active
  catalog and caches it for offline use; the bundled `CONNECTOR_CATALOG_BASELINE` is the floor so a fresh
  or offline install behaves exactly as today (default-on, mirroring pricing's "no active ⇒ bundled").
- **Generalize, don't fork, the signer.** A default type param keeps the pricing path byte-identical while
  the connector payload reuses the same `canon` bytes — one trust primitive, two payloads.
- **Collector re-verifies the signature** even though the server only serves approved catalogs
  (defense-in-depth: a tampered local cache file is ignored).

### Spikes actually run during planning (evidence)

- **Read `catalog-signing.ts`** — confirmed `canon`/`canonicalizeCatalog` is recursive and
  **payload-agnostic** (operates on any object), `verifyCatalogSignature(content, sigB64, pubKeyPem?)`
  signature, the `null`-digest ed25519 requirement, and `CATALOG_PUBLIC_KEY`/`SignedCatalog`/`CatalogContent`
  shapes — so generalization is a type-only change with zero byte change.
- **Read `pricing-catalogs.ts`** — confirmed the full lifecycle to mirror (`insertPendingCatalog`
  `onConflictDoNothing` idempotency, `approveCatalog` demote→promote txn, partial-unique ≤1 active,
  `toRow` Date→ISO normalization, `getActiveCatalog` undefined-when-none, `countPendingCatalogs`).
- **Read `routes/catalog.ts`** — confirmed the 4-endpoint auth ladder (`adminAuthorized` →
  `verifyCatalogSignature(..., app.catalogPublicKey)` bad→400 → `isUuid` else 404 → repo undefined→404)
  and the `app.catalogPublicKey` injection point.
- **Read `registry.ts` + `custom-connector.ts` + `connector-config.ts`** — confirmed `loadRegistry` is the
  single merge point, `validateCustomDef`/`makeCustomConnector` is the sanctioned data→connector path
  (decision A), and the tolerant load/save pattern the cache mirrors.
- **Verified migration number** — latest on disk is `0010_watery_spencer_smythe.sql` ⇒ this slice's
  migration is **`0011`**, with a hand-written `down/0011_*.down.sql`.
- **Read `gemini-cli.ts`/`codex-cli.ts` fidelity objects** — the metadata shape the baseline encodes as data.

### One-pass confidence: 9.2 / 10

The **server+shared half (12.7c-1)** is a near-exact structural mirror of a shipped, tested subsystem
(pricing catalog) — every symbol and the lifecycle were read, not recalled; that half is ~9.6. The
**collector half (12.7c-2)** is new (overlay + startup fetch + offline cache) and additive, but introduces
the most novel surface (the `ConnectorLike` leaf-shape for `mergeConnectorCatalog`, and the startup-fetch
wiring in two entrypoints) — ~8.8. The two **resolved architecture decisions** (parsers-stay-code overlay;
server-canonical + collector-pull distribution) are explicit so the executor doesn't guess. **Residual
deduction:** the exact leaf-side `ConnectorLike` shape that lets `@420ai/shared` overlay onto
`apps/collector`'s `Connector` without a dependency inversion should be confirmed by a 10-minute spike
against `control-protocol.ts`'s existing `ConnectorInfo` mirroring pattern (the repo already solves this
exact leaf-can't-import-collector problem for `ConnectorInfo` — reuse that approach). Executing 12.7c-1
first (≥9.3 on its own) is the recommended way to keep each landed step above the floor.
