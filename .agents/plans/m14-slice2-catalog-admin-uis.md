# Feature: M14 Slice 14.2 — Catalog admin UIs

> Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (proxy discipline, frontend workspace lanes,
> validation gate) — this plan links, not re-pastes. Milestone definition + scope decision:
> [`m14-general-ai-chat-capture.md`](./m14-general-ai-chat-capture.md) (slice 14.2, D-M14-3).

## Feature Description

Close the two 12.7c/12.2b tracked deferrals that keep catalog administration CLI-only:

1. **Connector-catalog approve/reject UI** — the signed connector catalog (12.7c) has a full
   `pending → active/rejected` lifecycle server-side, but the dashboard has no surface over it;
   approving today means curl with the admin token.
2. **Pricing-catalog upload UI** — the dashboard manages the pricing approval gate (12.2b) but
   upload is CLI-only. The UI submits the **already-signed** document (`{version, payload,
   signature}` produced offline by `scripts/sign-catalog.ts`); the private key never touches the
   browser, and ingest re-verifies the ed25519 signature server-side (a bad paste is a clean 400).

## User Story

As the self-hosting admin
I want to review/approve/reject connector-catalog updates and upload signed pricing catalogs from the dashboard
So that catalog administration doesn't require curl + the raw admin token.

## Problem / Solution

**Problem:** `POST /v1/connector-catalog/:id/approve|reject` and `POST /v1/catalog` exist and are
admin-gated, but have no dashboard surface — the "dashboard-reviewable like pricing" promise of
12.7c is half-delivered.

**Solution:** dashboard-only additive slice. Three new same-origin proxy Route Handlers for the
connector catalog (list/approve/reject), a `POST` handler added to the existing `/api/catalog`
proxy for upload, and a reworked `/catalog` page with two sections (pricing + connector) sharing
one table component. Zero backend change; proxy discipline per `CLAUDE.md` (token never in the
browser).

## Feature Metadata

**Feature Type**: Enhancement (dashboard-only, additive)
**Estimated Complexity**: Low–Medium
**Primary Systems Affected**: `apps/dashboard` only
**Dependencies**: none new (uses existing `@420ai/shared` types)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ BEFORE IMPLEMENTING

- `apps/ingest/src/routes/connector-catalog.ts` (whole file) — the five endpoints this UI fronts.
  Verified: `GET /v1/connector-catalog` (admin, bare `ConnectorCatalogRow[]` newest-first),
  `POST /v1/connector-catalog/:id/approve|reject` (admin, 404 on non-pending/unknown/malformed id),
  `POST /v1/connector-catalog` upload (NOT surfaced this slice — stays CLI, see NOTES).
- `apps/ingest/src/routes/catalog.ts:27-43` — `POST /v1/catalog` upload contract: body
  `{version, payload, signature}` (schema `apps/ingest/src/schemas.ts:404-413`), bad signature →
  400 `{error:"signature verification failed"}`, success → 200 with the pending row. Idempotent
  re-upload by version returns the existing row.
- `packages/db/src/repositories/connector-catalogs.ts:19-28` — `ConnectorCatalogRow` server shape
  (timestamps already ISO-normalized on read via `toRow` — same as pricing).
- `apps/dashboard/src/lib/types.ts:62-77` — `PricingCatalogRow` mirror + the wire-type convention
  the new `ConnectorCatalogRow` mirror follows.
- `apps/dashboard/src/components/catalog/catalog-view.tsx` (whole file) — the existing pricing
  approve/reject view: STATUS_BADGE map, `act()` mutation discipline (POST proxy, check `res.ok`,
  disable in-flight, `router.refresh()`). This slice refactors it into a two-section page.
- `apps/dashboard/src/app/catalog/page.tsx` — server component fetch pattern
  (`ingestUrl()` + `await adminHeaders()`, `cache:"no-store"`, empty list on unreachable).
- `apps/dashboard/src/app/api/catalog/route.ts`, `.../[id]/approve/route.ts` — the proxy routes the
  three new connector-catalog routes MIRROR (`proxyJson`, `dynamic = "force-dynamic"`).
- `apps/dashboard/src/lib/proxy.ts:23-48` — `proxyJson(path, {method, body, contentType})`
  forwards upstream status verbatim; thrown hop → 502. The upload POST reuses it unchanged.
- `packages/shared/src/connector-catalog.ts:95-97` — `ConnectorCatalogPayload`
  (`{connectors: ConnectorCatalogEntry[]}`) — imported `type`-only for the entries-count column.
- `scripts/CATALOG-SIGNING.md` — operator doc that gains a line about the new upload UI.

### New Files to Create

- `apps/dashboard/src/lib/signed-catalog.ts` — pure client-side pre-parse of a pasted/selected
  signed-catalog document (JSON.parse + shape check) so the form can reject garbage before POSTing.
- `apps/dashboard/src/lib/signed-catalog.test.ts` — unit tests (vitest, co-located, no infra —
  mirrors `snippet.test.ts` style).
- `apps/dashboard/src/app/api/connector-catalog/route.ts` — GET list proxy.
- `apps/dashboard/src/app/api/connector-catalog/[id]/approve/route.ts` — POST proxy.
- `apps/dashboard/src/app/api/connector-catalog/[id]/reject/route.ts` — POST proxy.
- `apps/dashboard/src/components/catalog/catalog-upload.tsx` — client upload form (textarea +
  file picker; POSTs `/api/catalog`).

### Files to Update

- `apps/dashboard/src/lib/types.ts` — ADD `ConnectorCatalogRow` mirror (payload typed
  `ConnectorCatalogPayload` from `@420ai/shared`; timestamps `string` — already ISO on the wire).
- `apps/dashboard/src/app/api/catalog/route.ts` — ADD `POST` (upload proxy); update the stale
  "intentionally NOT proxied" comment (the *signing* stays offline; the submit is now proxied).
- `apps/dashboard/src/components/catalog/catalog-view.tsx` — refactor to two sections sharing an
  internal generic table (rows differ only by action base path + an optional detail column).
- `apps/dashboard/src/app/catalog/page.tsx` — fetch both lists in parallel, pass both.
- `scripts/CATALOG-SIGNING.md` — note the dashboard upload path for pricing catalogs.

### Patterns to Follow

- **Proxy discipline** (`CLAUDE.md` "Frontend workspace"): browser → same-origin Route Handler →
  `proxyJson` adds the admin bearer server-side. Never a `NEXT_PUBLIC_*` token.
- **Mutation discipline** (`catalog-view.tsx:41-56`): check `res.ok`, disable in-flight,
  `router.refresh()` on success, map 404 → "No longer pending.", catch → "Ingest unreachable.".
- **Wire types** (`lib/types.ts` header): db-origin rows mirrored dashboard-side with `string`
  timestamps. Connector-catalog timestamps are ALREADY ISO strings server-side (repo `toRow`
  normalizes) — do not re-coerce.
- **No new long-lived resources**: plain request/response fetches only — no SSE/intervals, so the
  M9 teardown discipline isn't triggered (nothing to arm).

---

## STEP-BY-STEP TASKS

### 1. ADD `ConnectorCatalogRow` to `apps/dashboard/src/lib/types.ts`

- **IMPLEMENT**: interface mirroring `packages/db/.../connector-catalogs.ts:19-28`; `payload:
  ConnectorCatalogPayload` via `import type { ConnectorCatalogPayload } from "@420ai/shared"`.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0)

### 2. CREATE `apps/dashboard/src/lib/signed-catalog.ts` (+ test)

- **IMPLEMENT**: `parseSignedCatalogText(text: string): { ok: true; doc: SignedCatalogDoc } |
  { ok: false; error: string }` — trims, `JSON.parse` in try/catch, requires non-empty string
  `version`/`signature` and a plain-object `payload` (mirrors ingest's
  `catalogUploadBodySchema`, `additionalProperties` NOT enforced client-side — server is the gate).
- **TESTS**: valid doc passes; invalid JSON, missing/empty fields, non-object payload, array
  payload all fail with a message.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/signed-catalog.test.ts` (all pass)

### 3. CREATE the three connector-catalog proxy routes

- **MIRROR**: `app/api/catalog/route.ts` (GET) and `app/api/catalog/[id]/approve/route.ts` (POST),
  path prefix `/v1/connector-catalog`. `export const dynamic = "force-dynamic"` on each.
- **VALIDATE**: `npm run typecheck:dashboard`

### 4. ADD `POST` to `apps/dashboard/src/app/api/catalog/route.ts`

- **IMPLEMENT**: `const body = await req.text()` → `proxyJson("/v1/catalog", { method: "POST",
  body, contentType: "application/json" })`. Upstream 400 (bad signature) forwards verbatim.
- **VALIDATE**: `npm run typecheck:dashboard`

### 5. CREATE `catalog-upload.tsx` + REFACTOR `catalog-view.tsx` + UPDATE `page.tsx`

- **IMPLEMENT**: upload form (textarea + `<input type="file">` reading via `file.text()`),
  client-side `parseSignedCatalogText` before POST; on success show the returned row's
  version/status and `router.refresh()`. View: two Cards — "Pricing catalog" (upload + table),
  "Connector catalog" (table with an Entries count column, actions → `/api/connector-catalog`).
  Page: `Promise.all` the two ingest fetches (each individually error-safe → empty list).
- **VALIDATE**: `npm run build:dashboard` (exit 0 — catches barrel/JSX breakage)

### 6. UPDATE `scripts/CATALOG-SIGNING.md`

- **IMPLEMENT**: one short paragraph — signed pricing bundles can now be submitted via the
  dashboard Catalog page; signing itself stays offline.
- **VALIDATE**: `npx prettier --check scripts/CATALOG-SIGNING.md`

---

## VALIDATION COMMANDS (GATES — run from repo root)

1. **Level 1 — root typecheck**: `npm run typecheck` (exit 0; dashboard is OUT of this graph)
2. **Level 1b — dashboard lanes**: `npm run typecheck:dashboard` AND `npm run build:dashboard` (exit 0)
3. **Level 2 — unit**: `npm test` (all pass; new signed-catalog tests included)
4. **Level 3 — gate**: `npm run repo-health` (PASS). No `@420ai/db`/`apps/ingest` change → the
   `--require-db` int layer is not touched by this slice (zero backend diff), but run
   `npm run repo-health -- --require-db` before milestone sign-off per `CLAUDE.md`.
5. **Lint + format** (CI-only checks, per memory): `npm run lint` and
   `npx prettier --check` on changed files.
6. **Level 4 — manual (live stack)**: with ingest + dashboard running — `/catalog` renders both
   sections; approve/reject a pending connector catalog flips both rows; uploading a
   corrupt/signed-with-wrong-key document shows the 400 error inline; a valid signed document
   appears as `pending`; `grep -c "$ADMIN_TOKEN"` on the served page == 0.

---

## ACCEPTANCE CRITERIA

- [ ] Connector-catalog list renders with status badges; pending rows have working Approve/Reject
- [ ] Pricing-catalog upload accepts a signed `{version,payload,signature}` doc (paste or file),
      surfaces ingest's verdict (pending row on success; inline error on 400/502)
- [ ] Connector-catalog upload is NOT added (explicit non-goal — stays offline CLI)
- [ ] Zero backend change (git diff touches `apps/dashboard` + docs only)
- [ ] Admin token never in served HTML; all mutations go through same-origin proxies
- [ ] All validation gates pass (root typecheck, dashboard typecheck+build, vitest, repo-health, lint)

## NOTES

- **Scope guard (D-M14-3)**: the milestone doc scopes 14.2 to "connector-catalog approve/reject +
  pricing-catalog upload". Connector-catalog *upload* stays CLI-only (`sign-catalog.ts
  --connector`); machine/token revoke UI and editable settings stay in the deferral bucket.
- **Conflict resolution**: `api/catalog/route.ts`'s existing comment says upload is "intentionally
  NOT proxied — the dashboard is the approval gate". 14.2 supersedes that decision for the
  *submit* hop only (the milestone doc wins); signing remains offline. The comment is updated in
  Task 4 so the two instructions don't coexist.
- **Verification performed during planning** (evidence for the confidence score): every referenced
  endpoint/symbol read at source — `connector-catalog.ts` routes + `isUuid→404` ladder,
  `ConnectorCatalogRow`/`toRow` ISO normalization, `catalogUploadBodySchema`, `proxyJson`
  signature (`Init = {method, body, contentType}`), `ConnectorCatalogPayload` export, dashboard's
  `@420ai/shared` dependency (`package.json` + `transpilePackages`). No new packages; no schema
  change; no fingerprint proximity.
- **Confidence**: 9.4/10 — additive UI over verified existing endpoints, patterns copied from
  in-repo precedents, testable pure helper extracted. Residual risk: JSX/`next build` quirks,
  caught by the `build:dashboard` gate.
