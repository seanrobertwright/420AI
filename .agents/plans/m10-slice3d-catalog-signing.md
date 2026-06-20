# Feature: Catalog Signing — signed pricing-catalog updates + verify-before-apply + approval gate (V1 close-out Slice 3D — PRD §10.4 / §18 / §20 / §23)

The following plan should be complete, but it is important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files (`.js` specifiers, `import type`).

> **Conventions are NOT re-pasted here.** [`CLAUDE.md`](../../CLAUDE.md) (repo root) is the source of
> truth for module/TS/naming rules, the library-no-logging boundary, the dependency-injection pattern,
> the testing layers, the validation GATE (incl. `--require-db`), and the **Drizzle/SQL gotchas**. Read
> it first. This plan links to it rather than duplicating it — do not let a snippet here drift from it.

> **Scope note — this is sub-slice 3D of the M10 hardening bundle, the LAST one.** Per the V1 close-out
> roadmap in [`SUMMARY.md`](../../SUMMARY.md), the M10 bundle is four sub-slices in order **3b → 3a → 3c
> → 3d**. 3a (exports), 3b (replay metadata), 3c (persisted alert engine) are **DONE**. 3D is the
> remaining "catalog signing (§10.4): signed catalog updates + signature verify before apply + a
> capture-surface approval gate." It depends on 3b's `PRICING_CATALOG_VERSION` + `catalog_version`
> column (shipped) and 3c's `alert_firings` reconcile machinery (shipped) — both are reused here.

---

## Scope decisions — CONFIRMED WITH THE USER (2026-06-19)

These four answers shape the whole plan; they are the contract, not suggestions.

1. **Bundle scope = Pricing only.** A signed catalog update carries the **pricing table**
   (`model → ModelPricing`) — the runtime, mutable form of today's bundled `PRICING_CATALOG` constant.
   Connectors stay **hardcoded** (`connectors[]` in `apps/collector/src/connectors/connector.ts`) — they
   are NOT made catalog-driven in this slice. (Connector-catalog-as-data is a future slice.)
2. **Apply scope = FULL: an applied (approved-active) catalog re-prices going forward.** Cost is computed
   collector-side today and shipped on the wire, but the **server re-prices at the ingest write
   boundary** using the active catalog (tokens + model are plaintext on the wire). Because M6 cost
   projections read the **stored** `events.cost.usd` (not a recompute), re-pricing at ingest flows to
   every projection/report automatically. "Going forward" only — **historical rows are NOT retroactively
   re-priced** (that is the deferred archive-replay engine, named in NOTES).
3. **Delivery + keys = admin endpoint + ed25519 (bundled public key, offline signing script).**
   `POST /v1/catalog` accepts `{version, payload, signature}`; the server verifies an **ed25519**
   detached signature with `node:crypto` (no new dependency) against a **public key bundled in the
   repo**. A separate **offline signing script** signs with a private key that **never enters the repo**.
4. **Approval gate = every update lands `pending` → admin approves → `active`.** A verified upload is
   stored `pending`; an admin `approve` call activates it (superseding the prior active). The PRD §20
   **`catalog.update_requires_approval`** operational alert fires while any catalog is pending — surfaced
   through the existing 3c `alert_firings` surface (firing history + ack for free).

---

## Feature Description

Complete the PRD **§10.4 Catalog Updates** + **§18 / §20 / §23** catalog-signing contract. The platform's
pricing catalog must be able to update **independently of app releases** (§10.4, §13.2), but only via
**signed** updates (§18: "signed catalog updates are required") that a human **approves** before they take
effect (§18: "capture surface changes require user approval"; §20: the `catalog update requires approval`
alert). Today the catalog is a **compile-time constant** (`PRICING_CATALOG` + `PRICING_CATALOG_VERSION` in
`packages/shared/src/pricing.ts`) with **no remote-update path, no signature trust, and no approval gate**.

This slice adds the missing trust pipeline and wires it to runtime pricing:

1. **A signed-catalog verify primitive** (`@420ai/shared`, `node:crypto` ed25519) + a bundled public key
   + an offline signing script (private key kept out of the repo).
2. **A `pricing_catalogs` table** (additive, one migration) holding uploaded catalogs with a
   `pending|active|superseded|rejected` lifecycle and a **partial unique index enforcing ≤1 active**
   (mirroring the 3c `alert_firings` open-key index).
3. **Admin endpoints** `POST /v1/catalog` (verify → store pending), `GET /v1/catalog` (list),
   `POST /v1/catalog/:id/approve`, `POST /v1/catalog/:id/reject`.
4. **Ingest re-pricing**: when an uploaded catalog is **active**, the ingest write boundary re-prices each
   cost-bearing event under it (and stamps `catalog_version` = the active version). With no active upload,
   ingest is **byte-identical to today** (the bundled `PRICING_CATALOG` stays the offline baseline §10.4).
5. **The §20 alert**: `catalog.update_requires_approval` derived from the pending-catalog count, merged
   into the Live Monitor snapshot's alert list and persisted through the existing 3c firing reconcile.

## User Story

```
As a self-hosting developer whose model prices change between app releases
I want to upload a cryptographically signed pricing-catalog update, have the server verify the signature,
  hold it for my explicit approval, and then re-price new ingests under it
So that my cost metrics stay current WITHOUT trusting an unsigned blob or an unattended auto-apply —
  signature + approval are both required before a catalog ever changes a single computed cost
```

## Problem Statement

PRD §10.4/§18 require **signed** catalog updates with a **user-approval** gate, and §13.2 requires pricing
to ship via the catalog **independently of app releases**. None of this exists: the catalog is a constant
baked into the build, so re-pricing today means a code change + redeploy, there is no signature trust, and
there is no approval step or the §20 "catalog update requires approval" alert (the `AlertCode` union lacks
it). 3b added the `catalog_version` column + `PRICING_CATALOG_VERSION` constant and explicitly named
"independent remote catalog updates (PRD §10.4) that would make it vary at runtime" as **3D's concern** —
this is that slice.

## Solution Statement

Build the trust pipeline as additive infrastructure that mirrors patterns already proven in the repo, then
connect the **active** catalog to the ingest write boundary so an approved update re-prices going forward:

1. **Verify primitive in `@420ai/shared`** (new `catalog-signing.ts`): a pure, dependency-free
   `verifyCatalogSignature` over a **recursive canonical serialization** (both spike-proven below), plus a
   **bundled ed25519 public-key constant**. The matching private key is generated once and kept **offline
   / gitignored**; an **offline `scripts/sign-catalog.ts`** (run via `tsx`) signs with it. The public key
   is also **injectable** into the app (`buildApp({ catalogPublicKey })`, defaulting to the bundled
   constant) so integration tests sign with an ephemeral key — mirroring the M8 `analysisProvider`
   injection.
2. **`pricing_catalogs` table** (generated migration `0007`) with a `pending|active|superseded|rejected`
   status and a **partial unique index `WHERE status='active'`** (≤1 active) — a direct clone of the 3c
   `alert_firings_open_key` partial-unique idiom (`schema.ts:420`).
3. **Repository `pricing-catalogs.ts`** (`insertPendingCatalog` / `getActiveCatalog` / `listCatalogs` /
   `approveCatalog` / `rejectCatalog` / `countPendingCatalogs`) + admin routes mirroring
   `routes/pairing-codes.ts` and `routes/alerts.ts` (the `adminAuthorized → isUuid → repo → 404` ladder).
4. **Ingest re-pricing**: `computeCost`/`getPricing` gain an **optional injected catalog** param
   (backward-compatible default = `PRICING_CATALOG`). `ingestBatch` gains an optional `repricing`
   argument; the ingest route passes the **active** catalog (or omits it → pass-through, today's
   behavior). Re-pricing rewrites `cost.usd` + `catalog_version` for events that already carry
   `cost`+`tokens`+`model` — shape-preserving, zero new event type, fingerprint untouched.
5. **§20 alert**: a pure `deriveCatalogAlerts(pendingCount)` (sibling of 3c's `deriveBacklogTrendAlerts`,
   the frozen `deriveAlerts` stays frozen) merged into `monitor.ts` `buildSnapshot` and persisted via the
   existing `reconcileAlertFirings` — so the alert gets firing history + ack with no new persistence code.

**Zero fingerprint change, raw records untouched, no new event type, no new dependency.** Re-pricing is
"going forward" only (historical re-pricing = the deferred replay engine).

## Feature Metadata

**Feature Type**: New Capability (completes PRD §10.4 catalog updates + the §18/§20 signing/approval gate)
**Estimated Complexity**: **Medium–High** — new shared crypto module + cost-signature param + 1 new table
+ 1 generated migration + new repo + 4 admin endpoints + ingest re-pricing + the §20 alert + an offline
signing script + a one-time keypair generation. Every mechanism is spike-proven or a direct clone of an
existing pattern; the size is in breadth, not novelty.
**Primary Systems Affected**: `packages/shared` (new `catalog-signing.ts`; `cost.ts`/`pricing.ts` injected
catalog; `alerts.ts` new code + deriver), `packages/db` (new table + migration + new repo + `ingestBatch`
re-pricing), `apps/ingest` (new catalog route + ingest route wiring + monitor alert + body schema +
injected public key), `scripts/` (offline signer), repo root (keypair generation + `.gitignore`).
**Dependencies**: **None new.** `node:crypto` ed25519 (native, Node ≥ 24 — spike-confirmed v24.16.0);
`drizzle-kit generate` (existing migration workflow); `tsx` (existing, for the signing script).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Shared — the catalog/cost/alerts surfaces (the things you extend)**
- `packages/shared/src/pricing.ts` (whole, 106 lines) — `ModelPricing` (lines 15–26), `PRICING_CATALOG`
  (41–100), `PRICING_CATALOG_VERSION = "m10-catalog-v1"` (39, from 3b), `getPricing(model)` (103–105). You
  add an **optional `catalog` param** to `getPricing` (default `PRICING_CATALOG`). `PRICING_CATALOG` is the
  **bundled offline baseline** (§10.4) — keep it; the uploaded catalog only OVERRIDES it when active.
- `packages/shared/src/cost.ts` (whole, 85 lines) — `computeCost(model, tokens)` (60–85) calls
  `getPricing(model)` (68). You add an **optional `catalog` param** threaded into `getPricing`. The math
  (73–77) is the re-pricing formula the server reuses. `CostResult` (21–26) is unchanged.
- `packages/shared/src/fingerprint.ts` (whole, 24 lines) — **READ, DO NOT TOUCH.** Confirms
  `@420ai/shared` may import `node:crypto` (line 1 `import { createHash } from "node:crypto"`), so the new
  `catalog-signing.ts` may too. The fingerprint hashes ONLY four fields — re-pricing touches NONE of them.
- `packages/shared/src/alerts.ts` (whole, 206 lines) — `AlertCode` union (37–42) gains
  `"catalog.update_requires_approval"`. `OperationalAlert` (64–72), `AlertSeverity` (34), `sortAlerts`
  (146–148). **`deriveAlerts` (84–139) stays FROZEN (3c D2)** — you ADD a sibling pure
  `deriveCatalogAlerts(pendingCount)`, exactly as 3c added `deriveBacklogTrendAlerts` (184–205) beside it.
- `packages/shared/src/alert-firings.ts` (whole, 59 lines) — `alertKey` (50–52). A catalog alert has no
  `machineId`/`connector` → `alertKey` yields `"catalog.update_requires_approval:*"` (one firing). No
  change needed here; read it to confirm the key shape.
- `packages/shared/src/index.ts` (whole, 18 lines) — the barrel. ADD `export * from "./catalog-signing.js";`.

**DB schema + repositories (new table + re-pricing)**
- `packages/db/src/schema.ts` — read the **3c `alertFirings`** table (399–423) for the **partial unique
  index** idiom (`uniqueIndex(...).where(sql\`${t.status} = 'active'\`)`, line 420) and the
  `gitCommits`/`reportArtifacts` tables (288–272) for the table-doc-comment + `jsonb`/`text`/`timestamp`
  column style. You ADD a `pricingCatalogs` table at the end. Latest table comment style + `(t) => [ ... ]`
  index array is the template.
- `packages/db/src/repositories/ingest.ts` (whole, 95 lines) — **THE event upsert.** `ingestBatch(db,
  machineId, batch)` (17–95). The events loop (49–91) is where re-pricing slots in: between reading `e`
  and the `.values({...})` insert, apply the optional `repricing`. The `.values` (54–73) AND the
  `onConflictDoUpdate.set` (74–88) BOTH set `cost`/`catalogVersion` — re-pricing must update the **derived
  cost/catalogVersion in both** (mirror the §23 re-stamp discipline the comment at 78–79 describes).
- `packages/db/src/repositories/alert-firings.ts` (whole, 197 lines) — `reconcileAlertFirings(db, userId,
  alerts, now)` (96–138) persists ANY `OperationalAlert[]`; the §20 catalog alert rides it unchanged.
  Read `toFiring`/`listAlertFirings`/`ackAlertFiring` to confirm no change is needed (the catalog alert is
  just another alert in the array). This is the "firing history + ack for free" claim — verify it.
- `packages/db/src/repositories/projections.ts` (lines 41–45, 73–151) — **READ to confirm the re-pricing
  thesis**: `costSum` (42) sums the **stored** `events.cost ->> 'usd'` (NOT a recompute), filtered to
  `cost.estimated`. So re-pricing the stored `cost` at ingest is sufficient — every projection inherits it.
  **DO NOT change this file.** (`numeric → string`, wrapped in `Number(...)` at 89/118/149 — a documented
  gotcha; not touched here.)
- `packages/db/src/index.ts` (whole, 97 lines) — the `@420ai/db` barrel. ADD the new repo's exports
  (`insertPendingCatalog`, `getActiveCatalog`, `listCatalogs`, `approveCatalog`, `rejectCatalog`,
  `countPendingCatalogs`) + `export type { PricingCatalogRow }` and the `pricingCatalogs` table re-export
  (mirror the `alertFirings` lines 18, 34–38).

**Ingest app (routes + wiring)**
- `apps/ingest/src/app.ts` (whole, 99 lines) — `BuildAppOptions` (24–34) gains `catalogPublicKey?:
  string`; `buildApp` decorates `app.catalogPublicKey` (default the bundled constant) next to the M8
  `analysisProvider` decoration (49) — **the injection pattern to mirror**. Register the new
  `catalogRoutes` in the `app.register(...)` block (59–73).
- `apps/ingest/src/plugins/auth.ts` (whole, 50 lines) — the `declare module "fastify"` augmentation (9–25)
  is where you ADD `catalogPublicKey: string;` to the `FastifyInstance` interface (next to `adminToken`,
  line 11). Read how `analysisProvider` is declared (13) and mirror it.
- `apps/ingest/src/auth.ts` (whole, 29 lines) — `adminAuthorized(app, request)` (11–18) and `isUuid(s)`
  (27–29): the admin gate + id guard every catalog route uses. NO change; import + reuse.
- `apps/ingest/src/routes/pairing-codes.ts` (whole, 42 lines) — the **admin-gated POST route template**
  (adminAuthorized → body → repo → send). Mirror its shape for `POST /v1/catalog`.
- `apps/ingest/src/routes/alerts.ts` (whole, 28 lines) — the **admin-gated `:id` route template**
  (adminAuthorized → `isUuid(id)` else 404 → findUserIdByEmail → repo → undefined→404 → send). Mirror it
  for `POST /v1/catalog/:id/approve` and `/reject`. (Catalog has no user scope, so DROP the
  `findUserIdByEmail` step — the catalog is global; keep adminAuthorized + isUuid + repo→404.)
- `apps/ingest/src/routes/ingest.ts` (whole, 19 lines) — add: resolve the active catalog
  (`getActiveCatalog(app.db)`) and pass it to `ingestBatch` as the optional `repricing` arg. The route is
  bearer-machine-authed (preHandler), not admin — UNCHANGED auth.
- `apps/ingest/src/routes/monitor.ts` (whole, 149 lines) — `buildSnapshot` (43–77): after deriving the
  frozen `deriveAlerts` + sibling `deriveBacklogTrendAlerts` (70–73), ADD a `countPendingCatalogs(db)`
  query and merge `...deriveCatalogAlerts(pending)` into the `sortAlerts([...])` array BEFORE
  `reconcileAlertFirings` (75). **This is the only `monitor.ts` change.** Note the SSE leak discipline
  (D7, 104–147) is untouched — you add a cheap COUNT, no new long-lived resource.
- `apps/ingest/src/schemas.ts` — the Fastify body validators (`eventSchema`/`ingestBodySchema`/
  `pairingCodeBodySchema`). ADD a `catalogUploadBodySchema` ({ version: string, payload: object, signature:
  string }, all required). **Read this file before editing** (line numbers vary) to match the existing
  JSON-schema style (e.g. `pairingCodeBodySchema`).

**The connector cost emission (the re-priceable event — read to confirm, DO NOT change)**
- `apps/collector/src/connectors/claude-code.ts` (lines 153–234) — `makeEvent` stamps `model`
  (171) + `catalogVersion: PRICING_CATALOG_VERSION` (164, from 3b). The `cost.estimated` event (232)
  carries `{ tokens, cost }` AND inherits `model` — i.e. it has all three fields re-pricing needs. The
  `usage.reported` event (229) carries tokens but NO cost (so re-pricing skips it — it has no `cost`). This
  is the proof that re-pricing keys on "`e.cost` present" and finds `tokens`+`model` there. **No connector
  change in this slice** — re-pricing is entirely server-side.

### New Files to Create

- `packages/shared/src/catalog-signing.ts` — `SignedCatalog` type, `canonicalizeCatalog`,
  `verifyCatalogSignature`, `CATALOG_PUBLIC_KEY` constant. (Pure; `node:crypto` only.)
- `packages/shared/src/catalog-signing.test.ts` — canonicalize stability + ephemeral-key sign/verify +
  tamper + bundled-key-parses unit tests.
- `packages/db/src/repositories/pricing-catalogs.ts` — the catalog lifecycle repository.
- `packages/db/src/repositories/pricing-catalogs.int.test.ts` — table lifecycle + partial-unique +
  re-pricing-via-`ingestBatch` integration tests.
- `apps/ingest/src/routes/catalog.ts` — the four admin endpoints.
- `apps/ingest/src/catalog.int.test.ts` — end-to-end: upload (bad sig → 400, good → pending) → approve →
  active → ingest re-prices → §20 alert appears on `/v1/monitor`. (Mirror `apps/ingest/src/app.int.test.ts`
  / `exports.int.test.ts` harness — `buildApp` in-process + `app.inject`.)
- `scripts/sign-catalog.ts` — the offline signing script (run via `tsx`; reads a private key from
  `--key <path>` or `$CATALOG_SIGNING_KEY`).
- `packages/db/drizzle/0007_*.sql` (+ `meta/0007_snapshot.json` + `_journal.json` entry) — **generated**,
  not hand-written.
- `.secrets/catalog-private-key.pem` — the offline private key (gitignored, NEVER committed).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) — **§10.4** (Catalog Updates: bundled baseline + **signed remote
  updates** + **user approval for capture-surface changes**), **§18** ("signed catalog updates are
  required"; "capture surface changes require user approval"), **§20** (operational alerts: the
  **`catalog update requires approval`** alert), **§13.2** (pricing ships via the catalog, independent of
  app releases), **§23** (replay/versioning — the `catalog_version` stamp re-pricing updates), **§12** (the
  fingerprint invariant re-pricing must not touch).
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — glossary. Name code after existing terms: **"Connector
  Catalog"**, **"Catalog Update"**, **"Catalog Version"** (added in 3b), **"Operational Alert"**. **GAP
  (Task 12):** add a **"Signed Catalog Update"** entry (signature + approval) so the new endpoints are
  named after a documented term.
- [`SUMMARY.md`](../../SUMMARY.md) — the V1 close-out roadmap (3d definition: "Signed catalog updates +
  signature verify before apply + a capture-surface approval gate. Needs a key-management decision
  (ed25519: bundled public key, offline private)") — this plan resolves that decision. Update its status
  (Task 13).
- Node `crypto` ed25519 — `crypto.sign(null, msg, privateKey)` / `crypto.verify(null, msg, publicKey,
  sig)` (the `null` algorithm is REQUIRED for Ed25519). Keys via
  `crypto.generateKeyPairSync("ed25519")`, exported `spki`/`pkcs8` PEM. **Spike-proven below.**
- Drizzle Kit [`generate`](https://orm.drizzle.team/docs/drizzle-kit-generate) — additive `CREATE TABLE`
  migration from the `schema.ts` diff.

### Patterns to Follow

Follow `CLAUDE.md` (source of truth). The repo-specific ones that bite here:

**Dependency injection for testability** — the M8 `analysisProvider` (real client in `server.ts`, stub in
tests) is injected via `BuildAppOptions` + `app.decorate` + the `declare module "fastify"` augmentation.
Mirror it EXACTLY for `catalogPublicKey` so int tests sign with an ephemeral key without needing the
offline private key in CI.

**Partial unique index for a single-active invariant** — `alert_firings_open_key`
(`uniqueIndex("...").on(t.userId, t.alertKey).where(sql\`${t.status} = 'open'\`)`, `schema.ts:420`)
enforces ≤1 open firing per key. Clone it as `pricing_catalogs_one_active` (`.where(sql\`${t.status} =
'active'\`)`) for ≤1 active catalog. A bare-target `onConflictDoUpdate` won't match a partial index — use
`targetWhere` if you upsert against it (you don't here; you `update ... set status` in a txn — see Task 6).

**Admin route guard ladder** — `adminAuthorized(app, request)` (401) → `isUuid(id)` (404) → repo →
`undefined → 404` → send. From `routes/pairing-codes.ts` + `routes/alerts.ts`. The catalog is GLOBAL (no
`user_id`), so omit the `findUserIdByEmail` step the alerts route has.

**Sibling pure alert deriver** — `deriveBacklogTrendAlerts` (alerts.ts:184) is a pure function merged
beside the frozen `deriveAlerts` via `sortAlerts`. `deriveCatalogAlerts` is the same shape. **Do NOT edit
`deriveAlerts`** (3c D2 — frozen).

**Silent libraries** — `@420ai/shared` + `@420ai/db` repos throw, never log/exit. The **signing script**
(`scripts/sign-catalog.ts`) is an **entrypoint** → it MAY read argv, log, and `process.exit` (CLAUDE.md).

**Drizzle/SQL gotchas (`CLAUDE.md`)** — the new table's `uploaded_at`/`approved_at` are plain `timestamp`
(`Date` via the driver) → **normalize to ISO with `.toISOString()` on read** in the repo's row mapper
(mirror `toFiring` in alert-firings.ts:74–78). `payload` is `jsonb` (no numeric/aggregate gotcha).
`countPendingCatalogs` uses `count(*)::int` → JS number (mirror projections.ts `::int` casts). No
`min/max(ts)`/`date_trunc` aggregate here, so no aggregate-ISO gotcha; no `numeric` (no `Number()` wrap).

**Spike-snippet fidelity** — the two crypto spikes below are PROVEN; the `catalog-signing.ts`
`verifyCatalogSignature`/`canonicalizeCatalog` MUST match their asserted behavior (ed25519 `null`
algorithm; recursive key-sorted canonicalization; tamper → false).

---

## DESIGN DECISIONS (resolve conflicts up front)

- **D1 — Re-pricing happens at the INGEST WRITE BOUNDARY, server-side, gated on an ACTIVE UPLOADED
  catalog.** Cost is computed collector-side and shipped on the wire, but tokens+model are plaintext, so
  the server re-prices. The ingest route resolves `getActiveCatalog(db)`: **if** an uploaded catalog is
  active, pass it as `repricing` to `ingestBatch` → re-price; **if not**, pass nothing → store the wire
  cost verbatim (today's exact behavior). This makes the slice **zero-ripple** (no active catalog in any
  existing test → no change) and makes "applied catalog re-prices going forward" literally true (an
  *applied* = approved-active catalog re-prices; no application = no re-pricing). The bundled
  `PRICING_CATALOG` constant remains the **collector-side default + the §10.4 offline baseline**.
- **D2 — Re-pricing is shape-preserving and keys on "the event already has a cost".** For each wire event
  where `e.cost !== undefined && e.tokens && e.model`, recompute `cost = computeCost(e.model, e.tokens,
  active.rates)` and set `catalogVersion = active.version`. Events without a cost (e.g. `usage.reported`,
  `message.*`) are passed through untouched — re-pricing never ADDS a cost where there wasn't one, so the
  event taxonomy + the `cost.estimated`-filtered projections are unchanged. Applied in BOTH the `.values`
  insert and the `onConflictDoUpdate.set` (the §23 re-stamp path).
- **D3 — "Going forward" only; NO retroactive re-pricing.** Historical rows keep their stored cost +
  `catalog_version`. Re-pricing the existing archive under a new catalog is the **deferred archive-replay
  engine** (named in 3b's NOTES + here). This slice does NOT read-back/decrypt/re-derive stored records.
- **D4 — ed25519, bundled public key, offline private key, injectable for tests.** The public key is a
  bundled constant `CATALOG_PUBLIC_KEY` in `catalog-signing.ts` AND injectable via
  `buildApp({ catalogPublicKey })` (default = the constant). The private key is generated once, stored in
  gitignored `.secrets/catalog-private-key.pem`, and used only by the offline `scripts/sign-catalog.ts`.
  **The private key NEVER enters the repo or the server runtime.** `verifyCatalogSignature` defaults its
  `publicKeyPem` arg to the bundled constant.
- **D5 — Canonical serialization is RECURSIVE key-sorting, shared by signer + verifier.**
  `canonicalizeCatalog({version, payload})` sorts object keys at every level (spike-proven: different
  key-insertion orders → identical bytes). BOTH the offline script and the server import the SAME function
  from `@420ai/shared` — never two implementations (drift = silent verify failures).
- **D6 — The catalog table is GLOBAL (no `user_id`).** Pricing applies to everyone (single-user V1 but the
  catalog is not a per-user entity). The partial unique on `status='active'` is therefore global.
  Idempotent upload: `version` is unique → re-uploading the same `version` is a no-op (`onConflictDoNothing`
  → return the existing row). The §20 firing it raises IS per-user (the admin/`DEFAULT_EMAIL` user), via
  the existing `reconcileAlertFirings(... userId ...)`.
- **D7 — Approval supersedes the prior active atomically.** `approveCatalog(db, id, approvedBy, now)` runs
  in a transaction: demote the current active row to `superseded`, then promote the target (which must be
  `pending`) to `active` + stamp `approved_at`/`approved_by`. Order matters (demote before promote) because
  the partial unique forbids two active rows. Returns the activated row, or `undefined` if `id` is unknown
  or not `pending` (→ route 404/409).
- **D8 — `catalog.update_requires_approval` severity = `warning`, `since = null`.** It needs admin action
  (warning draws appropriate attention without implying an outage); `since` is a state/count, not a
  timestamp (mirrors `sync.backlog_high`). Tunable — documented in the deriver's JSDoc.
- **D9 — The four endpoints are admin-gated; ingest stays machine-authed.** `POST/GET /v1/catalog` +
  `:id/approve` + `:id/reject` use `adminAuthorized` (the dashboard reaches them via the existing
  server-side proxy that holds the admin token — the browser never sees it). `POST /v1/ingest` is
  unchanged (bearer-machine-authed); it only gains an internal `getActiveCatalog` read.

### Resolved conflicting guidance (do not reconcile by guesswork at implement time)
- **"Re-price going forward" vs. "don't churn existing tests/data":** re-pricing is **gated on an active
  uploaded catalog** (D1). Existing tests upload nothing → byte-identical behavior. Only the NEW
  re-pricing test uploads+approves a catalog. There is no retroactive pass (D3).
- **"Catalog updates independently of app releases" (§10.4) vs. "the bundled constant is the source of
  truth":** the bundled `PRICING_CATALOG` is the **offline baseline** (§10.4 explicitly wants a bundled
  baseline). An uploaded+approved catalog **overrides** it at the ingest boundary. Both coexist; neither is
  deleted.
- **"Signed updates required" vs. "tests can't hold the private key":** the public key is **injectable**
  (D4). Production verifies against the bundled constant; tests inject an ephemeral public key and sign with
  its private key. The signature requirement is never bypassed — only the KEY is swapped in tests.

---

## IMPLEMENTATION PLAN

### Phase 0: One-time keypair generation + spikes (PROVEN — fold results in, then proceed)
Generate the bundled ed25519 keypair; write the public PEM into `catalog-signing.ts`, the private PEM into
gitignored `.secrets/`. (The two crypto spikes are already run — see NOTES — so `verifyCatalogSignature` /
`canonicalizeCatalog` are written to their proven contract, not re-derived.)

### Phase 1: Foundation (shared — verify primitive + injected-catalog cost)
`catalog-signing.ts` (canonicalize + verify + bundled public key); `getPricing`/`computeCost` optional
catalog param; `AlertCode` + `deriveCatalogAlerts`; barrel export.

### Phase 2: Schema + migration
`pricing_catalogs` table (+ partial unique active); generate `0007_*.sql`.

### Phase 3: DB repository + ingest re-pricing
`pricing-catalogs.ts` repo (lifecycle + `getActiveCatalog` + `countPendingCatalogs`); `ingestBatch`
optional `repricing`; barrel exports.

### Phase 4: Ingest app wiring
Injected `catalogPublicKey`; `routes/catalog.ts` (4 endpoints); ingest route resolves+passes the active
catalog; monitor `buildSnapshot` merges the §20 alert; body schema.

### Phase 5: Offline signing script + tests + docs
`scripts/sign-catalog.ts`; unit + integration tests; glossary + SUMMARY; full `repo-health --require-db`.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently validatable.

### 1. GENERATE the catalog keypair + gitignore the private key
- **IMPLEMENT**: from the repo root, generate one ed25519 keypair and write the PEMs:
  ```bash
  mkdir -p .secrets
  node -e "const c=require('node:crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');require('node:fs').writeFileSync('.secrets/catalog-public-key.pem',publicKey.export({type:'spki',format:'pem'}));require('node:fs').writeFileSync('.secrets/catalog-private-key.pem',privateKey.export({type:'pkcs8',format:'pem'}));console.log('wrote .secrets/catalog-{public,private}-key.pem')"
  ```
  Then ADD `\n.secrets/\n` to `.gitignore` (the WHOLE directory — both keys live there during dev; only the
  PUBLIC key is copied into source in Task 2). Verify `git status` shows **neither** `.secrets/` file.
- **PATTERN**: the spike in NOTES used this exact API (`generateKeyPairSync('ed25519')`, `spki`/`pkcs8` PEM).
- **GOTCHA**: the PRIVATE key must NEVER be committed. Confirm `.secrets/` is gitignored BEFORE the next
  task. The `repo-health` stray-artifact scan won't catch a committed `.pem`; this is a manual discipline.
- **VALIDATE**: `git check-ignore .secrets/catalog-private-key.pem` prints the path (it is ignored).

### 2. CREATE `packages/shared/src/catalog-signing.ts`
- **IMPLEMENT**: a pure module with:
  - `import { verify as cryptoVerify, createPublicKey } from "node:crypto";` (or `import crypto from
    "node:crypto"`).
  - `import type { ModelPricing } from "./pricing.js";`
  - `export interface SignedCatalog { version: string; payload: Record<string, ModelPricing>; signature:
    string; }` (signature = base64 detached ed25519 over `canonicalizeCatalog({version, payload})`).
  - `export function canonicalizeCatalog(content: { version: string; payload: Record<string, ModelPricing>
    }): string` — **recursive** stable stringify (sort keys at EVERY level). Implementation (spike-proven):
    ```ts
    function canon(v: unknown): string {
      if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
      if (v && typeof v === "object")
        return "{" + Object.keys(v as Record<string, unknown>).sort()
          .map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k]))
          .join(",") + "}";
      return JSON.stringify(v);
    }
    export function canonicalizeCatalog(content) { return canon(content); }
    ```
  - `export const CATALOG_PUBLIC_KEY = \`<paste .secrets/catalog-public-key.pem VERBATIM, incl. the BEGIN/END
    lines and trailing newline>\`;` (a template literal; keep the exact PEM bytes).
  - `export function verifyCatalogSignature(content: { version: string; payload: Record<string, ModelPricing>
    }, signatureB64: string, publicKeyPem: string = CATALOG_PUBLIC_KEY): boolean` —
    ```ts
    try {
      return cryptoVerify(null, Buffer.from(canonicalizeCatalog(content), "utf8"),
        createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
    } catch { return false; } // malformed key/sig → not verified, never throw
    ```
- **PATTERN**: `fingerprint.ts` (imports `node:crypto`, pure, no logging). The ed25519 `null`-algorithm
  call + PEM public key are spike-proven (NOTES).
- **GOTCHA**: Ed25519 REQUIRES the digest algorithm be `null` in `crypto.verify`/`crypto.sign` — passing a
  hash name throws. `createPublicKey` on a malformed PEM throws → the `try/catch` returns `false` (a bad
  upload is a clean 400, never a 500). Canonicalize MUST be recursive (a shallow top-level sort fails on the
  nested `payload` model→rates map — spike covers exactly this).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 3. EXPORT catalog-signing from the shared barrel — `packages/shared/src/index.ts`
- **IMPLEMENT**: add `export * from "./catalog-signing.js";` (alongside the existing `./pricing.js` etc.).
- **GOTCHA**: `.js` specifier (NodeNext), even though the source is `.ts`.
- **VALIDATE**: `npm run typecheck` (exit 0); `node -e "import('@420ai/shared').then(m=>console.log(typeof
  m.verifyCatalogSignature, typeof m.canonicalizeCatalog, m.CATALOG_PUBLIC_KEY.startsWith('-----BEGIN')))"`
  after a build — or just rely on typecheck + the Task 10 unit test.

### 4. ADD an optional injected catalog to `getPricing` + `computeCost` — `pricing.ts`, `cost.ts`
- **IMPLEMENT**: (a) `pricing.ts`: `export function getPricing(model: string, catalog: Record<string,
  ModelPricing> = PRICING_CATALOG): ModelPricing | undefined { return catalog[model]; }`. (b) `cost.ts`:
  `export function computeCost(model: string | undefined, tokens: NormalizedTokens, catalog?: Record<string,
  ModelPricing>): CostResult` — thread `catalog` into `getPricing(model, catalog)` (line 68). Keep the rest
  of the math identical.
- **PATTERN**: the existing `computeCost`/`getPricing` bodies — only the signature + the `getPricing` call
  change.
- **GOTCHA**: the param is **optional with a default** → every existing caller (the 3 connectors, the M1
  report path) is unaffected (backward compatible). Do NOT make it required. `ModelPricing` is already
  exported from `pricing.ts`.
- **VALIDATE**: `npm run typecheck` (exit 0); existing `cost.test.ts`/connector tests still pass
  (`npx vitest run packages/shared apps/collector`).

### 5. ADD the §20 AlertCode + `deriveCatalogAlerts` — `packages/shared/src/alerts.ts`
- **IMPLEMENT**: (a) add `| "catalog.update_requires_approval"` to the `AlertCode` union (line 42). (b) ADD
  a pure deriver beside `deriveBacklogTrendAlerts`:
  ```ts
  /**
   * Emit a `catalog.update_requires_approval` (warning) when ≥1 signed pricing-catalog
   * update is awaiting approval (PRD §20/§10.4/§18). Pure + clock-free — sibling of
   * deriveBacklogTrendAlerts (3c D2); `deriveAlerts` stays frozen. `since` is null (a
   * count/state, like sync.backlog_high). Severity is tunable (warning: needs admin action).
   */
  export function deriveCatalogAlerts(pendingCount: number): OperationalAlert[] {
    if (pendingCount <= 0) return [];
    return [{
      code: "catalog.update_requires_approval",
      severity: "warning",
      message: `${pendingCount} signed pricing-catalog update${pendingCount === 1 ? "" : "s"} awaiting approval`,
      since: null,
    }];
  }
  ```
- **PATTERN**: `deriveBacklogTrendAlerts` (alerts.ts:184–205) — same pure-deriver shape.
- **GOTCHA**: **Do NOT edit `deriveAlerts`** (3c D2 — frozen). The new code keys on neither machine nor
  connector → `alertKey` → `"catalog.update_requires_approval:*"` (one firing). Output is merged + re-sorted
  by `sortAlerts` in the route (Task 9), not here.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 6. ADD the `pricing_catalogs` table — `packages/db/src/schema.ts`
- **IMPLEMENT**: append a new table (after `alertFirings`):
  ```ts
  /**
   * M10 3d signed pricing-catalog updates (PRD §10.4/§18/§20/§23). A catalog uploaded
   * via POST /v1/catalog after ed25519 signature verify, held `pending` until an admin
   * approves it → `active` (the prior active is `superseded`). The PARTIAL unique index
   * enforces ≤1 active (mirrors alert_firings_open_key). GLOBAL (no user_id) — pricing
   * applies to everyone. `payload` is the model→ModelPricing map (the signed content);
   * an active row re-prices ingests going forward (cost computed server-side at ingest).
   */
  export const pricingCatalogs = pgTable(
    "pricing_catalogs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      version: text("version").notNull(),                         // self-declared catalog version (e.g. "m10-catalog-v2")
      payload: jsonb("payload").$type<Record<string, ModelPricing>>().notNull(),
      signature: text("signature").notNull(),                     // base64 ed25519 over canonicalizeCatalog({version,payload})
      status: text("status").notNull().default("pending"),        // "pending" | "active" | "superseded" | "rejected"
      uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
      approvedAt: timestamp("approved_at", { withTimezone: true }),
      approvedBy: text("approved_by"),
    },
    (t) => [
      uniqueIndex("pricing_catalogs_version").on(t.version),       // idempotent upload (re-upload same version = no-op)
      uniqueIndex("pricing_catalogs_one_active").on(t.status).where(sql`${t.status} = 'active'`),
    ],
  );
  ```
- **PATTERN**: `alertFirings` (399–423) partial-unique idiom; `reportArtifacts`/`gitCommits` column style.
  `ModelPricing` is imported at the top of schema.ts already? **CHECK** line 13 — it imports
  `NormalizedTokens, CostResult` from `@420ai/shared`; ADD `ModelPricing` to that import.
- **GOTCHA**: `sql` is already imported (line 12). `jsonb().$type<...>()` for the typed payload (mirror
  `events.tokens` line 129). snake_case SQL names. The `pricing_catalogs_version` unique makes re-upload a
  clean no-op (D6). Do NOT add `user_id` (D6 — global).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 7. GENERATE the migration — `packages/db/drizzle/0007_*.sql`
- **IMPLEMENT**: `npm run db:generate` → emits `0007_<name>.sql` + `meta/0007_snapshot.json` +
  `_journal.json` entry from the schema diff.
- **PATTERN**: prior generated migrations (`0006` added `machine_heartbeats` + `alert_firings`). Commit SQL
  + snapshot + journal together.
- **GOTCHA**: CONFIRM the emitted SQL is purely additive — one `CREATE TABLE "pricing_catalogs"` + the two
  indexes (incl. the partial `... WHERE status = 'active'`), **no `DROP`/`ALTER`** on existing tables. If
  drizzle-kit prompts interactively, a rename was misinferred — abort and re-check Task 6. Do NOT hand-edit
  the SQL.
- **VALIDATE**: open `0007_*.sql`; `npm run db:up && npm run db:migrate` applies cleanly (exit 0).

### 8. CREATE the repository — `packages/db/src/repositories/pricing-catalogs.ts`
- **IMPLEMENT**: import `eq`, `and`, `sql`, `desc` from `drizzle-orm`; `pricingCatalogs` from `../schema.js`;
  `type ModelPricing` from `@420ai/shared`; `type DbClient` from `../client.js`. Define:
  - `export interface PricingCatalogRow { id: string; version: string; payload: Record<string,
    ModelPricing>; signature: string; status: "pending"|"active"|"superseded"|"rejected"; uploadedAt:
    string; approvedAt: string | null; approvedBy: string | null; }`
  - a `toRow(r)` mapper that `.toISOString()`-normalizes `uploadedAt`/`approvedAt` (the **timestamp→Date→ISO
    gotcha**; mirror `toFiring` alert-firings.ts:74–78) and casts `status`/`payload`.
  - `insertPendingCatalog(db, input: { version: string; payload: Record<string, ModelPricing>; signature:
    string }): Promise<PricingCatalogRow>` — `insert(...).values({ ...input, status: "pending" })
    .onConflictDoNothing({ target: pricingCatalogs.version }).returning(...)`; if the insert returned
    nothing (duplicate version), re-select by version and return the existing row (idempotent, D6).
  - `getActiveCatalog(db): Promise<{ version: string; rates: Record<string, ModelPricing> } | undefined>` —
    select where `status = 'active'` limit 1; map to `{ version, rates: payload }` or `undefined`.
  - `listCatalogs(db): Promise<PricingCatalogRow[]>` — all rows, `orderBy(desc(uploadedAt))`.
  - `approveCatalog(db, id, approvedBy, now): Promise<PricingCatalogRow | undefined>` — in a
    `db.transaction`: (1) `update pricingCatalogs set status='superseded' where status='active'`; (2)
    `update pricingCatalogs set status='active', approvedAt=now, approvedBy=approvedBy where id=:id AND
    status='pending' returning *`. If (2) returned no row → `undefined` (unknown id or not pending). Map +
    return. (Demote-before-promote satisfies the partial unique — D7.)
  - `rejectCatalog(db, id, now): Promise<PricingCatalogRow | undefined>` — `update set status='rejected'
    where id=:id AND status='pending' returning *`; undefined if none.
  - `countPendingCatalogs(db): Promise<number>` — `select { n: sql<number>\`count(*)::int\` } from
    pricingCatalogs where status='pending'`; return `rows[0]?.n ?? 0`.
- **PATTERN**: `alert-firings.ts` (the txn-free upsert + ISO-normalizing `toFiring` mapper, the
  `count(*)::int` idiom from projections.ts:80). `attribution.ts` for `db.transaction` + guarded `update ...
  returning` → undefined.
- **GOTCHA**: `approveCatalog` MUST be transactional (demote+promote atomic) or a crash between leaves zero
  active. `::int` on the count (JS number, not a `numeric` string). Silent library — throw, never log.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 9. ADD optional re-pricing to `ingestBatch` — `packages/db/src/repositories/ingest.ts`
- **IMPLEMENT**: (a) extend the signature: `ingestBatch(db, machineId, batch, repricing?: { version:
  string; rates: Record<string, ModelPricing> })`. Import `computeCost`, `type ModelPricing` from
  `@420ai/shared`. (b) inside the events loop (before the `.values`), derive per-event:
  ```ts
  const reprice = repricing && e.cost !== undefined && e.tokens && e.model;
  const cost = reprice ? computeCost(e.model, e.tokens, repricing!.rates) : e.cost;
  const catalogVersion = reprice ? repricing!.version : e.catalogVersion;
  ```
  (c) use `cost` + `catalogVersion` in BOTH the `.values({...})` (`cost,` `catalogVersion,`) AND the
  `onConflictDoUpdate.set` (`cost: cost ?? null,` `catalogVersion: catalogVersion ?? null,`).
- **PATTERN**: the existing `cost: e.cost` / `catalogVersion: e.catalogVersion` lines in both the insert
  (69, 58) and the set (83, 80) — replace `e.cost`/`e.catalogVersion` with the locally-derived
  `cost`/`catalogVersion`.
- **GOTCHA**: D2 — re-price ONLY when the event already has a cost (`e.cost !== undefined`) AND tokens AND
  model; otherwise pass through verbatim. The `repricing` param is **optional**; existing callers
  (`app.int.test`, `capture-engine.int.test`, `push.int.test`) omit it → identical behavior (zero ripple).
  Re-pricing must touch BOTH the insert and the §23 re-stamp `set` (or a replay leaves a stale cost). Do
  NOT change the fingerprint or any other column.
- **VALIDATE**: `npm run typecheck` (exit 0); existing ingest int tests unchanged & green under
  `--require-db`.

### 10. EXPORT the repo + add unit tests for the shared primitives
- **IMPLEMENT**: (a) `packages/db/src/index.ts`: re-export `pricingCatalogs` from `./schema.js` (mirror the
  `alertFirings` re-export, line 18) and add the repo exports `insertPendingCatalog, getActiveCatalog,
  listCatalogs, approveCatalog, rejectCatalog, countPendingCatalogs` + `export type { PricingCatalogRow }
  from "./repositories/pricing-catalogs.js";`. (b) `packages/shared/src/catalog-signing.test.ts`:
  - `canonicalizeCatalog` is stable across key-insertion order (assert two differently-ordered equal objects
    canonicalize identically).
  - generate an ephemeral ed25519 keypair in-test; sign `canonicalizeCatalog(content)` with the private key;
    `verifyCatalogSignature(content, sigB64, ephemeralPublicPem)` is `true`; a nested-rate tamper → `false`;
    a wrong-key → `false`; a malformed signature/key → `false` (no throw).
  - `CATALOG_PUBLIC_KEY` parses: `expect(() => createPublicKey(CATALOG_PUBLIC_KEY)).not.toThrow()` (proves
    the committed bundled key is a valid ed25519 public key WITHOUT needing the private key).
  - (c) `packages/shared/src/cost.test.ts`: add a case — `computeCost("claude-opus-4-8", tokens,
    { "claude-opus-4-8": { input: 1e-3, output: 0, cache_read: 0, cache_write: 0, sourceUrl: "x", asOf: "x"
    } })` uses the INJECTED rate (asserts the re-pricing math path), and `computeCost(model, tokens)` with no
    catalog still uses `PRICING_CATALOG`. (d) `packages/shared/src/alerts.test.ts`: `deriveCatalogAlerts(0)`
    → `[]`; `deriveCatalogAlerts(2)` → one `catalog.update_requires_approval` warning with `since: null`.
- **PATTERN**: existing `fingerprint.test.ts`/`cost.test.ts`/`alerts.test.ts` (co-located, no infra). The
  in-test ephemeral keypair mirrors the spikes in NOTES.
- **GOTCHA**: these are UNIT tests (no DB) — always run. Use `crypto.generateKeyPairSync("ed25519")` +
  `crypto.sign(null, ...)` in-test. Do NOT depend on the offline private key file.
- **VALIDATE**: `npx vitest run packages/shared` (all pass).

### 11. WIRE the ingest app — injected key + routes + ingest re-pricing + monitor alert + schema
- **IMPLEMENT**:
  - `apps/ingest/src/plugins/auth.ts`: add `catalogPublicKey: string;` to the `FastifyInstance`
    augmentation (next to `adminToken`).
  - `apps/ingest/src/app.ts`: `BuildAppOptions` gains `catalogPublicKey?: string;`; in `buildApp`,
    `app.decorate("catalogPublicKey", opts.catalogPublicKey ?? CATALOG_PUBLIC_KEY);` (import
    `CATALOG_PUBLIC_KEY` from `@420ai/shared`); `app.register(catalogRoutes);` in the register block.
  - `apps/ingest/src/schemas.ts`: add `export const catalogUploadBodySchema = { type: "object", required:
    ["version", "payload", "signature"], properties: { version: { type: "string" }, payload: { type:
    "object" }, signature: { type: "string" } } } as const;` (match the file's existing schema style; read
    it first).
  - `apps/ingest/src/routes/catalog.ts` (NEW): 4 admin-gated routes (mirror pairing-codes/alerts):
    - `POST /v1/catalog` `{ schema: { body: catalogUploadBodySchema } }`: `adminAuthorized` else 401; if
      `!verifyCatalogSignature({ version, payload }, signature, app.catalogPublicKey)` → 400 `{ error:
      "signature verification failed" }`; else `insertPendingCatalog(app.db, { version, payload, signature
      })` → 200 the row.
    - `GET /v1/catalog`: `adminAuthorized` else 401; `listCatalogs(app.db)` → 200.
    - `POST /v1/catalog/:id/approve`: `adminAuthorized` → `isUuid(id)` else 404 → `approveCatalog(app.db,
      id, "admin", new Date())` → undefined→404 `{ error: "pending catalog not found" }` → 200 the row.
    - `POST /v1/catalog/:id/reject`: same ladder → `rejectCatalog(...)` → undefined→404 → 200.
  - `apps/ingest/src/routes/ingest.ts`: `const active = await getActiveCatalog(app.db); const result = await
    ingestBatch(app.db, request.machineId, request.body, active ? { version: active.version, rates:
    active.rates } : undefined);` (import `getActiveCatalog` from `@420ai/db`).
  - `apps/ingest/src/routes/monitor.ts` `buildSnapshot`: add `countPendingCatalogs` to the `Promise.all`
    batch (or a separate await), import `deriveCatalogAlerts` + `countPendingCatalogs`, and change the
    `sortAlerts([...])` to `sortAlerts([ ...deriveAlerts(built), ...deriveBacklogTrendAlerts(machineRows,
    samplesByMachine), ...deriveCatalogAlerts(pendingCatalogs) ])`.
- **PATTERN**: `routes/pairing-codes.ts` (admin POST), `routes/alerts.ts` (admin `:id` ladder),
  `app.ts` analysisProvider injection (49), `monitor.ts` alert merge (70–73).
- **GOTCHA**: the catalog is global → the approve/reject routes do NOT call `findUserIdByEmail` (drop that
  step the alerts route has). `verifyCatalogSignature` is called with `app.catalogPublicKey` (injected) so
  tests can swap the key. The Fastify body schema `payload: { type: "object" }` permits arbitrary nested
  rates (the signature is the real integrity check). `getActiveCatalog` is ONE extra indexed read per
  ingest batch — acceptable; do not cache in this slice.
- **VALIDATE**: `npm run typecheck` (exit 0); `npm run typecheck:dashboard` unaffected (no dashboard change).

### 12. CREATE the offline signing script — `scripts/sign-catalog.ts`
- **IMPLEMENT**: an entrypoint (may log/argv/exit) run via `tsx`:
  - read a catalog JSON file (arg 1) of shape `{ version: string, payload: Record<string, ModelPricing> }`;
  - read the private key PEM from `--key <path>` or `$CATALOG_SIGNING_KEY` (path);
  - `const sig = crypto.sign(null, Buffer.from(canonicalizeCatalog({version,payload}),"utf8"),
    createPrivateKey(privPem)).toString("base64");`
  - print `JSON.stringify({ version, payload, signature: sig }, null, 2)` to stdout (the body to POST).
  - import `canonicalizeCatalog` from `../packages/shared/src/catalog-signing.js` (run via `tsx`, single
    source of truth — D5).
- **PATTERN**: `apps/collector/src/cli.ts` (an entrypoint that reads argv + prints). Keep it tiny.
- **GOTCHA**: the script is the ONLY place the private key is read; it lives outside the server runtime. Use
  the SAME `canonicalizeCatalog` as the verifier (NOT a re-implementation) or signatures won't verify (D5).
  Document the usage in a header comment: `npx tsx scripts/sign-catalog.ts catalog.json --key
  .secrets/catalog-private-key.pem > signed.json`.
- **VALIDATE**: round-trip manually — sign `examples` with `.secrets/catalog-private-key.pem`, then in a
  scratch `node` REPL `verifyCatalogSignature(content, signature, CATALOG_PUBLIC_KEY) === true`. (Also
  covered by Task 13's int test using an injected ephemeral key.)

### 13. ADD integration tests — `pricing-catalogs.int.test.ts` (db) + `catalog.int.test.ts` (ingest)
- **IMPLEMENT**:
  - `packages/db/src/repositories/pricing-catalogs.int.test.ts` (`describe.skipIf(!process.env
    .DATABASE_URL_TEST)`): insert pending → `getActiveCatalog` undefined + `countPendingCatalogs` = 1;
    `approveCatalog` → status active, `getActiveCatalog` returns it, pending count 0; insert a 2nd pending +
    approve → the 1st is `superseded`, only the 2nd is active (the partial unique held — no two-active
    error); `rejectCatalog` a pending → rejected; re-insert an existing `version` → idempotent (same row, no
    dup). Plus the **re-pricing proof**: `ingestBatch(db, machineId, batch, { version: "m10-catalog-v2",
    rates: { <model>: <different rates> } })` for a batch with a `cost.estimated` event → the stored
    `events.cost->>'usd'` reflects the v2 rates AND `events.catalog_version = "m10-catalog-v2"`; the same
    batch with `repricing` omitted → stored cost = the wire cost (unchanged). Use the
    `TRUNCATE ... RESTART IDENTITY CASCADE` seed idiom from `monitor.int.test.ts` / the existing ingest int
    test.
  - `apps/ingest/src/catalog.int.test.ts`: build the app with an **injected ephemeral public key**
    (`buildApp({ ..., catalogPublicKey: ephemeralPubPem })`); sign a catalog with the matching private key
    via `crypto.sign(null, canonicalizeCatalog(content), priv)`. Assert: `POST /v1/catalog` with a TAMPERED
    signature → 400; with a valid signature → 200 pending; `GET /v1/catalog` lists it; `POST
    /v1/catalog/:id/approve` → active; after approval, `POST /v1/ingest` of a cost-bearing batch stores a
    re-priced cost + `catalog_version` = the approved version; `GET /v1/monitor` shows a
    `catalog.update_requires_approval` firing WHILE a catalog is pending (and it clears after approval).
- **PATTERN**: `apps/ingest/src/app.int.test.ts` / `exports.int.test.ts` (in-process `buildApp` +
  `app.inject`, admin `Authorization: Bearer <adminToken>` header), `alert-firings.int.test.ts` (firing
  assertions), `monitor.int.test.ts` (seed/snapshot).
- **GOTCHA**: these are `*.int.test.ts` — excluded from `tsc -b`, type-stripped by vitest, SELF-SKIP without
  `DATABASE_URL_TEST`. They only prove anything under `--require-db`. The ingest int test must inject the
  ephemeral public key (D4) — the bundled `CATALOG_PUBLIC_KEY`'s private key is NOT available in CI.
- **VALIDATE**: `npm run repo-health -- --require-db` (these cases run, 0 skipped).

### 14. ADD glossary entry — `docs/CONTEXT.md`
- **IMPLEMENT**: add a **"Signed Catalog Update"** entry near "Catalog Update" / "Catalog Version": *"A
  pricing-catalog update delivered as a detached ed25519-signed bundle (`{version, payload, signature}`).
  The server verifies the signature against a bundled public key, stores the update as `pending`, and
  applies it only after explicit admin approval (PRD §10.4/§18/§20). An active update re-prices subsequent
  ingests."* (Also confirm "Catalog Version" / "Operational Alert" already cover the rest.)
- **PATTERN**: the terse one-sentence glossary style.
- **VALIDATE**: `npm run repo-health` (docs scanned — no broken links, no NULs).

### 15. UPDATE `SUMMARY.md` (status + roadmap)
- **IMPLEMENT**: mark sub-slice **3d — Catalog signing** DONE in the §0 status + the §6 roadmap: note it
  shipped the ed25519 verify primitive + bundled public key + offline signer, the `pricing_catalogs` table
  (migration `0007`) with the pending→active approval gate (partial-unique ≤1 active), the four admin
  endpoints, **ingest-time re-pricing under the active catalog (going forward; historical replay still
  deferred)**, and the `catalog.update_requires_approval` §20 alert via the 3c firing surface. Note this
  **completes the M10 hardening bundle** (3a/3b/3c/3d all done). Mention the archive-replay engine + making
  connectors catalog-driven remain deferred.
- **PATTERN**: the existing SUMMARY status prose + the 3a/3b/3c sub-slice entries.
- **VALIDATE**: `npm run repo-health` (docs scanned).

### 16. GATE — full `repo-health -- --require-db`
- **IMPLEMENT**: nothing new; run the gate with the test DB up.
- **GOTCHA**: this slice touches `@420ai/db` (new table + migration + 2 repos) AND `apps/ingest` (routes +
  ingest re-pricing + monitor), so the integration layer MUST actually run — a plain `repo-health` PASS
  (int self-skipped) is NOT sufficient (`CLAUDE.md` "Validation is a GATE"; skipped ≠ passed). This is the
  sign-off gate.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS, int
  layer ran, 0 skipped.

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, always run — no infra)
- `catalog-signing.test.ts` — canonicalize stability; ephemeral-key sign→verify true; nested tamper/wrong
  key/malformed input → false (no throw); `CATALOG_PUBLIC_KEY` parses as a valid ed25519 key. **The core
  trust proof.**
- `cost.test.ts` — `computeCost` with an injected catalog uses the injected rates; with no catalog uses
  `PRICING_CATALOG` (back-compat).
- `alerts.test.ts` — `deriveCatalogAlerts(0)`→`[]`, `(n>0)`→one warning with `since:null`; `deriveAlerts`
  output unchanged (frozen).

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST` — run under `--require-db`)
- `pricing-catalogs.int.test.ts` — table lifecycle (pending→active→superseded, reject, idempotent
  re-upload), partial-unique ≤1 active, `countPendingCatalogs`, and `ingestBatch` re-pricing (stored
  `cost.usd` + `catalog_version` reflect the active catalog; omitted repricing → unchanged).
- `catalog.int.test.ts` — endpoints end-to-end with an injected ephemeral key: bad-sig 400, good 200
  pending, list, approve→active, ingest re-prices under the approved catalog, the §20 firing appears while
  pending and clears after approval.

### Edge Cases (must be covered)
- Tampered signature / wrong key / malformed PEM → `verifyCatalogSignature` returns false (route 400, never
  500).
- Re-upload of an existing `version` → idempotent no-op (same row), not a duplicate.
- `approve` an unknown / already-active / rejected id → 404 (not pending); the prior active becomes
  superseded atomically (never two active rows).
- Ingest with NO active catalog → byte-identical to today (wire cost stored, collector's `catalog_version`).
- Ingest with an active catalog that DROPS a model → that event re-prices to usd 0 /
  `estimated-model-unknown` (honest — the active catalog is authoritative; D2).
- A `usage.reported` event (tokens, no cost) is never given a cost by re-pricing (shape-preserving, D2).
- The §20 alert fires once (single `alertKey`) regardless of pending count; it acks via the existing
  `/v1/alerts/firings/:id/ack`; it resolves when the pending queue empties (reconcile D5).

---

## VALIDATION COMMANDS

All commands run from the **repo root**. Each is a GATE.

### Level 1: Syntax & Types (repo-root build — catches cross-project/test-only imports)
- `npm run typecheck` → **exit 0** (root `tsc -b`; the four backend workspaces). The `ingestBatch`
  signature change + the new repo/route surface compile clean.

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/catalog-signing.test.ts` → the signature/canonicalize proofs pass.
- `npm test` → full `vitest run`; units always run, int self-skips. **Must be green.**

### Level 3: Integration Tests (the DB-backed layer must ACTUALLY run)
- `npm run db:up && npm run db:migrate` → applies `0007_*.sql` cleanly (exit 0).
- `npm run repo-health -- --require-db` → **PASS, and the `*.int.test.ts` layer ran with 0 skipped.** This
  slice touches `@420ai/db` + `apps/ingest`, so a plain `repo-health` PASS is NOT sufficient (skipped ≠
  passed). **Milestone sign-off gate.**

### Level 4: Manual Validation
1. `npm run db:up && npm run db:migrate`; start ingest (`npm run ingest:dev`).
2. Build a catalog JSON (copy `PRICING_CATALOG` to `{version:"m10-catalog-v2", payload:{...one model with a
   changed rate...}}`); `npx tsx scripts/sign-catalog.ts catalog.json --key .secrets/catalog-private-key.pem
   > signed.json`.
3. `curl -X POST localhost:8420/v1/catalog -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type:
   application/json" -d @signed.json` → 200 `status:"pending"`. Corrupt one byte of `signature` → 400.
4. `curl localhost:8420/v1/monitor -H "authorization: Bearer $ADMIN_TOKEN"` → an
   `catalog.update_requires_approval` firing is present.
5. `curl -X POST localhost:8420/v1/catalog/<id>/approve -H "authorization: Bearer $ADMIN_TOKEN"` → 200
   `status:"active"`; re-check `/v1/monitor` → the firing resolves.
6. `collector push` a real Claude/Codex session (or POST a cost-bearing `IngestBatch`); `psql $DATABASE_URL
   -c "select model, cost->>'usd', catalog_version from events where event_type='cost.estimated' limit 5;"`
   → cost reflects the v2 rate + `catalog_version = "m10-catalog-v2"`.

### Level 5: Code-review gate (separate layer)
- `npm run repo-health -- --require-db` green AND run `/lril:code-review` before commit. This slice adds no
  long-lived resource (the monitor change is a cheap COUNT — the SSE leak class from M9 does NOT apply);
  review focuses on: (a) the private key never committed (`git log -p -- .secrets` empty; `.secrets/`
  gitignored); (b) the re-pricing touching BOTH the insert and the `set`; (c) `approveCatalog`
  transactionality; (d) signer/verifier sharing ONE `canonicalizeCatalog` (D5).

---

## ACCEPTANCE CRITERIA

- [ ] `verifyCatalogSignature` (ed25519, recursive canonical serialization) rejects tampered/wrong-key/
      malformed input without throwing; `CATALOG_PUBLIC_KEY` is a valid bundled ed25519 public key; the
      private key is gitignored and NEVER committed.
- [ ] `pricing_catalogs` table (migration `0007`, generated) holds a pending→active→superseded/rejected
      lifecycle with a partial unique enforcing ≤1 active; re-upload of a `version` is idempotent.
- [ ] `POST /v1/catalog` verifies the signature (bad → 400) then stores pending; `GET /v1/catalog` lists;
      `POST /v1/catalog/:id/approve` activates + supersedes the prior active atomically; `:id/reject`
      rejects — all admin-gated with the `isUuid → 404` ladder.
- [ ] With an ACTIVE uploaded catalog, ingest re-prices cost-bearing events under it (stored `cost.usd` +
      `catalog_version` reflect the active version); with NO active catalog, ingest is byte-identical to
      today. No retroactive re-pricing (historical rows untouched).
- [ ] The `catalog.update_requires_approval` §20 alert fires while a catalog is pending, surfaces in the
      `/v1/monitor` `alertFirings`, acks via the existing route, and resolves on approval — with NO new
      persistence machinery (reuses 3c reconcile).
- [ ] The event fingerprint is untouched; no new event type, no raw-record change; `deriveAlerts` is
      unchanged (frozen).
- [ ] `scripts/sign-catalog.ts` signs with the offline private key using the SAME `canonicalizeCatalog`
      the server verifies with; a manual round-trip verifies.
- [ ] `npm run typecheck`, `npm test` exit 0; `npm run repo-health -- --require-db` PASSES with the int
      layer run, **0 skipped**.
- [ ] `docs/CONTEXT.md` defines "Signed Catalog Update"; `SUMMARY.md` marks 3d done + the M10 bundle
      complete.
- [ ] `/lril:code-review` run before commit; findings addressed.

## COMPLETION CHECKLIST

- [ ] Keypair generated; private key gitignored + uncommitted; public key bundled in `catalog-signing.ts`.
- [ ] Phase-0 spikes folded in (verify/canonicalize match the proven contract).
- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] Root `tsc -b` exits 0; full `vitest run` green; new unit + int tests present and passing.
- [ ] `repo-health -- --require-db` PASS (int layer exercised, 0 skipped).
- [ ] Migration `0007` + snapshot + journal committed together; `db:migrate` clean; the SQL is additive.
- [ ] Glossary + SUMMARY updated; deferred archive-replay engine + catalog-driven connectors named (not
      implied as covered).

---

## NOTES

### Spikes actually run during planning (evidence for the confidence score)
1. **ed25519 sign/verify with `node:crypto`, no deps** (Node v24.16.0): `crypto.sign(null, msg, priv)` /
   `crypto.verify(null, msg, pub, sig)` → `okGood:true, okTamper:false`, verify from a PEM public key
   `okFromPem:true`, signature is 88 base64 chars, public PEM `-----BEGIN PUBLIC KEY-----`, private
   `-----BEGIN PRIVATE KEY-----`. **Proves** the verify primitive + the bundled-PEM-public-key approach.
2. **Recursive canonical serialization round-trip** (the subtle part): a recursive key-sorting
   `canon()` over `{version, payload:{model:{nested rates}}}` → `canonStable:true` (different key-insertion
   orders canonicalize identically), `okGood:true` (a signature made by the signer verifies for a
   differently-ordered received object), `okTamper:false` (a nested-rate change breaks verification).
   **Proves** the D5 canonicalization is sound — the one place sign/verify could silently drift.

Both throwaways were deleted; their asserted behavior is encoded in `catalog-signing.ts` + its unit test.

### Why "Full re-pricing" is tractable + low-risk here
The decisive find: M6 cost projections read the **stored** `events.cost->>'usd'` (projections.ts:42), NOT a
recompute from tokens. So re-pricing the stored cost ONCE at the ingest write boundary propagates to every
projection + M7/M8 report automatically — no projection/report change. Gating it on an *active uploaded*
catalog (D1) makes the change zero-ripple to all existing tests/behavior. The collector still computes a
local cost (for its M1 SQLite report + the wire), but the server is authoritative once a catalog is applied.

### What is deliberately deferred (name in the PR, do NOT build here)
- **The archive-replay engine** — retroactive re-pricing of historical rows under a new catalog (read-back/
  decrypt/re-derive stored raw records). The substrate (immutable raw records + idempotent fingerprint
  upsert + the `catalog_version` column + now the active-catalog store) all exist; the read-back-and-re-emit
  pass is its own slice. "Re-prices going forward" = ingest-time only (D3).
- **Catalog-driven connectors** — making the hardcoded `connectors[]` registry + connector permissions/
  capture-surfaces a *signed catalog payload* (the broader §10.4 "connector catalog"). This slice's bundle
  is **pricing only** (confirmed scope #1). The approval gate is in place to extend to capture-surface
  diffs when connectors become catalog-driven.
- **A dashboard catalog-approval page** (list pending → view rate diff → approve/reject button). The §20
  alert already surfaces in the existing alerts panel; approval is via the admin API / proxy. A dedicated
  UI belongs to the deferred §8.4 "dashboard surfaces" slice. (3c added only a small Ack button; 3d keeps
  the same backend-first discipline.)
- **Reconcile-throttle / signed catalog rotation / multiple signing keys** — V1 ships one bundled public
  key + one active catalog. Key rotation + a key-id header are later concerns.

### Replay/versioning correctness (PRD §23, restated)
Re-pricing rewrites only `cost` + `catalog_version` on cost-bearing events, in both the insert and the
`onConflictDoUpdate.set` — so a replay/re-ingest under the same active catalog re-stamps in place (no dupes,
fingerprint independent of both). Historical rows priced under an older catalog keep their honest older
`catalog_version` until the deferred replay engine re-derives them.

---

## Confidence Score

**9.5 / 10** for one-pass success.

**Evidence backing it:**
- **The single genuinely-new mechanism (ed25519 signing + canonical serialization) was SPIKE-PROVEN twice
  during planning** (NOTES) — `null`-algorithm sign/verify, PEM public-key verify, tamper rejection, and
  the recursive-canonicalization round-trip all confirmed on the actual Node v24.16.0. The verify code is
  transcribed from the proven spike, not derived.
- **Every other piece is a direct clone of a shipped pattern, each read at the source**: the partial-unique
  single-active index (3c `alert_firings_open_key`, schema.ts:420), the admin route ladder
  (`pairing-codes.ts`/`alerts.ts` + `adminAuthorized`/`isUuid` in auth.ts), the dependency injection
  (`analysisProvider` in app.ts:49 + the `declare module` augmentation), the sibling pure alert deriver +
  reconcile reuse (`deriveBacklogTrendAlerts`/`reconcileAlertFirings`), the ISO-normalizing row mapper
  (`toFiring`), and the generated-migration workflow (3b's Phase-0 check).
- **The architectural risk of "Full re-pricing" was retired by reading `projections.ts`**: cost is read
  from the stored column, so re-pricing is one localized change at the ingest boundary, gated to be
  zero-ripple (D1). The re-priceability of `cost.estimated` events (tokens+model present) was confirmed at
  `claude-code.ts:164/171/232`.
- **`@420ai/shared` may use `node:crypto`** — confirmed (fingerprint.ts:1). **`computeCost`/`getPricing`
  changes are backward-compatible** (optional defaulted param) — no caller breaks.

**The −0.5** is the slice's BREADTH (≈8 files + 1 table + 4 endpoints + a script) and two procedural risks
the gate catches: (1) the offline-private-key hygiene (must stay gitignored/uncommitted — a manual
discipline `repo-health` does not enforce, called out in Task 1 + the review gate); (2) the
signer/verifier MUST share one `canonicalizeCatalog` (D5) — a re-implementation in the script would pass
typecheck but fail verification (mitigated by the script importing the shared function + the manual
round-trip in Task 12/Level-4). Both are explicitly guarded; neither is a hidden assumption.
