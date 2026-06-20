# Feature: M12 Slice 12.2b — Dashboard Mutating Surfaces + Export + Settings (PRD §8.4)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — **import types from the right package** (see the "shared vs db type" gotcha).

> **Conventions are NOT re-pasted here.** Repo conventions live in [`CLAUDE.md`](../../CLAUDE.md) and
> [`SUMMARY.md`](../../SUMMARY.md). **Read the "Frontend workspace (`apps/dashboard`)" section of
> `CLAUDE.md` before starting.**

> **This is the SECOND of two sub-slices of M12 Slice 12.2 (Dashboard Surfaces) and DEPENDS ON 12.2a.**
> 12.2a (`m12-slice2a-dashboard-read-surfaces.md`) must be landed first — it ships the foundation this slice
> reuses verbatim: `apps/dashboard/src/lib/proxy.ts` (`proxyJson`/`proxyStream`), `lib/types.ts`,
> `lib/format.ts`, `components/app-nav.tsx`, `components/page-shell.tsx`, and the read pages this slice adds
> buttons to (projects detail, reports list). **If 12.2a is not present, stop and build it first.**

## Feature Description

Builds the **mutating / admin** dashboard surfaces over the **already-existing** ingest APIs — **no
ingest/server/schema changes**:

1. **Reports** — generate (project + session cost reports, AI interpretations) **and compare two versions
   via the stored `metrics` seam**. *(12.2a shipped read-only list+view.)*
2. **Catalog** — pricing-catalog list + approve/reject (upload stays offline-CLI — see Deferred).
3. **Projects** — create + rename; workspace→project remap. *(12.2a shipped read-only list+detail.)*
4. **Pairing** — generate short-lived pairing codes.
5. **Export** — trigger redacted MD/JSON/JSONL/CSV downloads (events, report, transcript).
6. **Settings** — read-only system/version/connection info (editable settings → 12.3+).

Every browser→ingest call proxies through a **same-origin Route Handler** that adds the admin bearer on the
server→ingest hop — **`ADMIN_TOKEN` never reaches the browser** (D8).

This slice is **almost entirely additive** under `apps/dashboard/`. Edits to existing files: add
generate/compare to `components/reports/reports-view.tsx`, add create/rename to the projects views (both from
12.2a), and doc updates.

## User Story

As the **self-hosted single user (admin)** of 420AI
I want to **generate and compare reports, manage the pricing catalog, create/rename projects, mint pairing
codes, export data, and check system status from the dashboard**
So that **I can operate the whole system from the browser — and the admin token never leaves the server**.

## Problem Statement

12.2a made the archive **browsable** but not **operable**: there is no UI to generate or compare reports,
approve a pending pricing catalog, create/rename a project, remap a workspace, mint a pairing code, export
data, or see system versions. Each still requires raw `curl` + `ADMIN_TOKEN`.

## Solution Statement

Reuse 12.2a's `proxyJson`/`proxyStream` + page/client patterns to add **POST/PATCH** proxy Route Handlers
and the corresponding UI controls, mirroring the `alerts-panel.tsx` client-mutation discipline (POST same-
origin, **check `res.ok`**, optimistic flag + rollback, refetch). Export uses `proxyStream` (forwards
`content-disposition` + `x-export-*` headers) so the browser downloads files with **no token client-side**.

## Feature Metadata

**Feature Type**: New Capability (frontend)
**Estimated Complexity**: Medium — **low blast radius** (additive `apps/dashboard` files; **zero** changes to
`apps/ingest`, `packages/db`, `packages/shared`, schema, or migrations).
**Primary Systems Affected**: `apps/dashboard` only.
**Dependencies**: **12.2a foundation** (required). No new libraries.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**From 12.2a (must already exist — read them):**
- `apps/dashboard/src/lib/proxy.ts` — `proxyJson(path, {method,body,contentType})` + `proxyStream(path,
  signal)`. The basis of every handler here.
- `apps/dashboard/src/lib/types.ts` — wire types (`ProjectRow`, `ReportArtifactRow`, `WorkspaceRow`,
  `ProjectEventSummary`). **Add `PricingCatalogRow` here in this slice.**
- `apps/dashboard/src/lib/format.ts` — `formatDate`, `formatUsd`, `formatTokens`, `formatAgo`.
- `apps/dashboard/src/components/app-nav.tsx` — add `/catalog`, `/pairing`, `/export`, `/settings` links if
  12.2a didn't already.
- `apps/dashboard/src/components/page-shell.tsx` — wrap each new page.
- `apps/dashboard/src/components/reports/reports-view.tsx` + `components/projects/{projects-view,
  project-detail-view}.tsx` — extended here with mutation controls.

**Dashboard mutation pattern to mirror:**
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` (@58-69) — the **client mutation** pattern: POST
  same-origin, **check `res.ok`** (fetch resolves on 4xx/5xx), optimistic `acking` set + rollback. The
  in-flight disable pattern prevents double-fire.
- `apps/dashboard/src/app/api/alerts/firings/[id]/ack/route.ts` (full) — the **POST proxy with dynamic
  `[id]`** (`params` is a Promise → `await`).
- `apps/dashboard/src/app/api/monitor/stream/route.ts` (full) — the **stream** shape `proxyStream` distills
  (for export downloads).
- `apps/dashboard/src/app/monitor/page.tsx` — Server-Component page (for settings' initial fetch).

**Type sources (import from the correct package):**
- `packages/shared/src/index.ts` — barrel. `LiveMonitorSnapshot` (monitor.ts) for settings' versions.
- `packages/db/src/repositories/pricing-catalogs.ts` (`PricingCatalogRow` @18) — **db-origin. DO NOT import
  in the dashboard.** Mirror into `lib/types.ts` (timestamps as `string`):
  `{ id, version, payload: Record<string,unknown>, signature, status: "pending"|"active"|"superseded"|
  "rejected", uploadedAt: string, approvedAt: string|null, approvedBy: string|null }`.
- `ReportArtifactRow.metrics` is `unknown` — the **compare seam**. Treat as `Record<string, unknown>`.

### New Files to Create

**Proxy Route Handlers** (all `force-dynamic`)
- `app/api/projects/[id]/reports/route.ts` (POST), `.../interpretations/route.ts` (POST)
- `app/api/sessions/[sessionId]/reports/route.ts` (POST), `.../interpretations/route.ts` (POST)
- `app/api/catalog/route.ts` (GET list), `app/api/catalog/[id]/approve/route.ts` (POST),
  `app/api/catalog/[id]/reject/route.ts` (POST)
- `app/api/projects/[id]/route.ts` (PATCH rename) — *if 12.2a didn't create it*
- `app/api/workspaces/[id]/route.ts` (PATCH remap)
- `app/api/pairing-codes/route.ts` (POST)
- `app/api/health/route.ts` (GET — settings)
- `app/api/exports/events/route.ts` (GET stream), `app/api/reports/[id]/export/route.ts` (GET stream),
  `app/api/sessions/[sessionId]/transcript/export/route.ts` (GET stream)
- *(POST `app/api/projects/route.ts` create + POST `app/api/search/reindex/route.ts` — add the POST verb to
  the route files 12.2a created, or create reindex fresh.)*

**Pages + client views**
- `app/catalog/page.tsx` + `components/catalog/catalog-view.tsx`
- `app/pairing/page.tsx` + `components/pairing/pairing-view.tsx`
- `app/export/page.tsx` + `components/export/export-view.tsx`
- `app/settings/page.tsx` + `components/settings/settings-view.tsx`
- `components/reports/report-compare.tsx` (the metrics-diff view; or fold into `reports-view.tsx`)
- `apps/dashboard/src/lib/metrics-diff.ts` (+ `metrics-diff.test.ts`) — pure shallow numeric diff helper.

### Files to Modify

- `apps/dashboard/src/components/reports/reports-view.tsx` — add Generate buttons + two-version Compare.
- `apps/dashboard/src/components/projects/projects-view.tsx` — add "New project" form.
- `apps/dashboard/src/components/projects/project-detail-view.tsx` — add rename + (optional) workspace remap.
- `apps/dashboard/src/app/api/projects/route.ts` — add `POST` (create); `app/api/search/route.ts` siblings:
  add `app/api/search/reindex/route.ts` (POST).
- `apps/dashboard/src/components/search/search-view.tsx` — add a "Reindex" button (POST).
- `apps/dashboard/src/components/app-nav.tsx` — ensure `/catalog`,`/pairing`,`/export`,`/settings` links.
- `docs/guide/usage.md` — extend the Dashboard section (mutations/export/settings).
- `SUMMARY.md` §6 / `docs/PRD.md` §25 M12 — note 12.2b status (completing 12.2) **on sign-off only**.

### Relevant Documentation
- [Next.js — Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
  (POST/PATCH; dynamic `params` is a Promise in Next 16).
- [MDN — `Response.body` streaming](https://developer.mozilla.org/en-US/docs/Web/API/Response/body) — export downloads.

### Patterns to Follow

**POST/PATCH Route Handler** (forward the browser's JSON body verbatim):

```ts
import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";
export const dynamic = "force-dynamic";

// app/api/projects/[id]/reports/route.ts
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  return proxyJson(`/v1/projects/${id}/reports`, { method: "POST", body, contentType: "application/json" });
}
```

**No-body POST** (approve/reject/reindex):

```ts
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/catalog/${id}/approve`, { method: "POST" });
}
```

**Export stream handler** (forward querystring + headers):

```ts
import type { NextRequest } from "next/server";
import { proxyStream } from "@/lib/proxy";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  return proxyStream(`/v1/exports/events${req.nextUrl.search}`, req.signal);
}
```

**Client mutation** (mirror `alerts-panel.tsx` — check `res.ok`, disable in-flight, refetch):

```tsx
"use client";
const [busy, setBusy] = useState(false);
async function approve(id: string): Promise<void> {
  setBusy(true);
  try {
    const res = await fetch(`/api/catalog/${id}/approve`, { method: "POST" });
    if (!res.ok) { /* inline error from res.status (404 not pending / 502 unreachable) */ return; }
    // refetch the list via GET /api/catalog (or router.refresh())
  } finally { setBusy(false); }
}
```

**Browser download via proxy** (no token client-side):

```tsx
// an <a download> or window.location.href to the proxy URL; the proxy streams ingest's response.
<a href={`/api/exports/events?format=jsonl&projectId=${id}`} download>Download events (JSONL)</a>
```

**Metrics-diff (the compare seam)** — pure, unit-testable:

```ts
// apps/dashboard/src/lib/metrics-diff.ts
export interface MetricDelta { key: string; a: number | null; b: number | null; delta: number | null }
/** Shallow numeric-leaf diff of two report `metrics` blobs (shape varies by reportType → defensive). */
export function diffMetrics(a: unknown, b: unknown): MetricDelta[] {
  const oa = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const ob = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort();
  return keys.map((key) => {
    const av = typeof oa[key] === "number" ? (oa[key] as number) : null;
    const bv = typeof ob[key] === "number" ? (ob[key] as number) : null;
    return { key, a: av, b: bv, delta: av !== null && bv !== null ? bv - av : null };
  }).filter((d) => d.a !== null || d.b !== null);
}
```

---

## IMPLEMENTATION PLAN

### Phase 1: Reports — generate + compare
Buttons on project detail + reports page; the two-version metrics-diff compare view.

### Phase 2: Catalog + projects mutations
Catalog list + approve/reject; project create/rename; workspace remap; search reindex.

### Phase 3: Pairing + Export + Settings
Pairing-code generation; export trigger forms (stream downloads); read-only settings.

### Phase 4: Testing & Validation
`metrics-diff.test.ts`; `typecheck:dashboard` + `build:dashboard`; manual screenshots + token-leak grep == 0.

---

## STEP-BY-STEP TASKS

Execute in order. **After each surface run `npm run build:dashboard`.**

### Phase 1 — Reports generate + compare

#### CREATE report/interpretation generate proxies + buttons
- **IMPLEMENT**: `api/projects/[id]/reports/route.ts` (POST), `api/projects/[id]/interpretations/route.ts`
  (POST), `api/sessions/[sessionId]/reports/route.ts` (POST), `api/sessions/[sessionId]/interpretations/
  route.ts` (POST). Add "Generate cost report" / "Generate AI interpretation" buttons on the project detail
  view (12.2a) and per-session controls; on `res.ok` refetch the reports list.
- **PATTERN**: POST proxy above; client mutation from `alerts-panel.tsx`.
- **GOTCHA**: interpretations call a **billable** provider — add a confirm step; handle **503** (provider not
  configured) and **502** (provider error) distinctly (the proxy forwards the status). Generation is
  **non-idempotent** (bumps version) — disable the button while in-flight to avoid double POST.
- **VALIDATE**: `npm run build:dashboard`; manual: generate → a new version appears.

#### CREATE `lib/metrics-diff.ts` (+ test) and the compare view
- **IMPLEMENT**: `diffMetrics` as in "Patterns"; `components/reports/report-compare.tsx` — pick **two
  artifacts of the same `(reportType, scopeId)`** (filter the 12.2a list), render their `markdown` side-by-
  side + a `diffMetrics(aMetrics, bMetrics)` delta table (key, vA, vB, Δ).
- **PATTERN**: reports list from 12.2a; `ReportArtifactRow` from `lib/types.ts`.
- **GOTCHA**: `metrics` shape **varies by `reportType`** — `diffMetrics` is defensive (shallow numeric
  leaves; guards non-object). Typed per-type diff is **deferred**. Compare only artifacts that share
  `reportType`+`scopeId` (else the diff is meaningless).
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/metrics-diff.test.ts` → pass; `npm run build:dashboard`;
  manual: two versions of one project's cost report → diff renders.

### Phase 2 — Catalog + project mutations

#### CREATE catalog page (list + approve/reject)
- **IMPLEMENT**: add `PricingCatalogRow` to `lib/types.ts`; `api/catalog/route.ts` (GET),
  `api/catalog/[id]/approve/route.ts` (POST), `api/catalog/[id]/reject/route.ts` (POST);
  `app/catalog/page.tsx` (fetch `PricingCatalogRow[]`); `components/catalog/catalog-view.tsx` (Table:
  version, status badge, uploadedAt, approvedAt/By; `pending` rows get Approve + Reject buttons → refetch).
- **GOTCHA**: **upload (`POST /v1/catalog`) requires an offline ed25519 signature** — do **not** build an
  upload form (signing is offline-only per M10 3d). Dashboard manages the **approval gate only**. Approve
  atomically supersedes the current active → refetch to reflect both rows. A non-pending id → **404**
  (forwarded) → inline error.
- **VALIDATE**: `npm run build:dashboard`; manual (if a pending catalog exists): approve flips status.

#### ADD project create/rename + workspace remap + search reindex
- **IMPLEMENT**: add `POST` to `api/projects/route.ts` (create, body `{name,gitRemote?}`); ensure
  `api/projects/[id]/route.ts` PATCH (rename `{name}`) exists; `api/workspaces/[id]/route.ts` PATCH (remap
  `{projectId}`); `api/search/reindex/route.ts` (POST). UI: "New project" form on projects-view; inline
  rename on project-detail-view; a project picker to remap a workspace (on machines or detail view); a
  "Reindex" button on search-view.
- **GOTCHA**: remap `{projectId}` must be a **UUID** (chosen from a list → safe); malformed → 400/404
  (forwarded). Create returns `{id}` only → refetch the list. Rename returns `{id,name}`. Reindex returns
  `ReindexCounts` — show the counts; it's a **full rebuild** (can be slow on a big archive) → disable while
  in-flight.
- **VALIDATE**: `npm run build:dashboard`; manual: create + rename persist; remap moves a workspace; reindex
  returns counts.

### Phase 3 — Pairing + Export + Settings

#### CREATE pairing page
- **IMPLEMENT**: `api/pairing-codes/route.ts` (POST, body `{}` or `{email}`); `app/pairing/page.tsx` +
  `components/pairing/pairing-view.tsx` (`"use client"`: "Generate pairing code" → POST → show `code` +
  `expiresAt` via `formatDate` + copy-to-clipboard).
- **GOTCHA**: response `{ code, expiresAt }`; the code is **short-lived** — show expiry prominently. No
  list-of-codes endpoint (generate-only). DEFAULT_EMAIL used server-side if `email` omitted.
- **VALIDATE**: `npm run build:dashboard`; manual: generate shows a code + expiry.

#### CREATE export page (stream downloads)
- **IMPLEMENT**: `api/exports/events/route.ts`, `api/reports/[id]/export/route.ts`,
  `api/sessions/[sessionId]/transcript/export/route.ts` (all `proxyStream`, forward `req.nextUrl.search`);
  `app/export/page.tsx` + `components/export/export-view.tsx` (`"use client"`: forms — events export with
  format `json|jsonl|csv` + optional projectId/connector/start/end; report export by id + format `md|json`;
  transcript export by sessionId + format `md|json|jsonl`. Submit = an `<a download>`/`window.location.href`
  to the proxy URL).
- **PATTERN**: `monitor/stream/route.ts` shape; `proxyStream` forwards `content-disposition` + `x-export-*`.
- **GOTCHA**: exports are **already redacted server-side** (`x-export-redaction-version` header) — safe.
  Download via the proxy → ingest stream → file save with **no token in the browser**. Malformed `projectId`
  → 404 (forwarded).
- **VALIDATE**: `npm run build:dashboard`; manual: download a JSONL events export; open → redacted, no
  ciphertext.

#### CREATE settings page (read-only)
- **IMPLEMENT**: `api/health/route.ts` (GET `/v1/health`); `app/settings/page.tsx` (fetch `/v1/health` +
  `/v1/monitor` for `monitorVersion` + `/v1/catalog` for the active version); `components/settings/
  settings-view.tsx` (read-only cards: ingest reachable? (health `status`+`time`), `monitorVersion`, active
  catalog `version`; a note that editable settings arrive in later M12 slices).
- **GOTCHA**: there is **no settings/config API** — Settings is **read-only** (editable config → 12.3+).
  **Never render `ADMIN_TOKEN`/`INGEST_URL` values** to the browser (show "configured", not the value).
- **VALIDATE**: `npm run build:dashboard`; manual: settings shows versions + "ingest: ok".

### Phase 4 — Testing & Validation

#### RUN the gate + tests
- **VALIDATE**:
  - `npm run typecheck:dashboard` → 0 errors.
  - `npm run build:dashboard` → builds (the dashboard milestone gate).
  - `npm test` → all pass (`metrics-diff.test.ts` runs; 12.2a tests unchanged).
  - `npm run repo-health` → PASS (root `tsc -b` unaffected — no backend change; **no `--require-db`**).

#### Manual evidence (headless Edge)
- **VALIDATE** (`$EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`):
  - screenshot `/catalog`, `/pairing`, `/export`, `/settings`, the reports compare, the project create/rename.
  - **Token-leak**: `curl -s http://localhost:3000/catalog | grep -c "$ADMIN_TOKEN"` → **0** (repeat for
    `/export`, `/settings`, `/pairing`).
  - Export redaction: `curl -s "http://localhost:3000/api/exports/events?format=jsonl" -o /tmp/ev.jsonl &&
    grep -c "payload_ciphertext" /tmp/ev.jsonl` → 0.

#### UPDATE docs + sign-off
- **IMPLEMENT**: extend the `docs/guide/usage.md` Dashboard section (mutations/export/settings); on green
  gate tick **12.2** complete in `SUMMARY.md` §6 + `docs/PRD.md` §25 M12, naming deferrals.
- **VALIDATE**: `grep -n "12.2" SUMMARY.md`.

---

## TESTING STRATEGY

### Unit Tests (vitest)
- `lib/metrics-diff.test.ts` — numeric-leaf diff; non-object metrics → `[]`; mixed keys; null-vs-number.
- **No React component tests** (no jsdom/testing-library in the repo). Rely on `build:dashboard` + manual
  screenshots; extract pure logic (metrics-diff) for unit coverage.

### Integration Tests
- **None.** No backend change ⇒ no `*.int.test.ts`; no `--require-db`.

### Edge Cases
- Interpretation: **503** (not configured) / **502** (provider error) shown distinctly.
- Double-click generate/approve/reindex → button disabled in-flight (no duplicate POST).
- Approve a non-pending catalog → 404 (forwarded) → inline error.
- Remap with malformed/unknown projectId → 400/404 → inline error.
- Export with no rows → file downloads, `x-export-truncated:false`.
- `metrics` absent/non-object → compare degrades to markdown-only (no crash).
- Pairing code expiry shown; copy works.

---

## VALIDATION COMMANDS

### Level 1: Typecheck
- `npm run typecheck` (root `tsc -b`) → exit 0 (unchanged).
- `npm run typecheck:dashboard` → exit 0.

### Level 2: Unit suite
- `npm test` → all pass (`metrics-diff.test.ts` runs).

### Level 3: Build gate
- `npm run build:dashboard` → builds clean.
- `npm run repo-health` → PASS.

### Level 4: Manual Validation (headless Edge)
```bash
npm run ingest:dev      # terminal A
npm run dashboard:dev   # terminal B (ADMIN_TOKEN/INGEST_URL in apps/dashboard/.env.local)
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
for p in catalog pairing export settings; do
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot="/tmp/420-$p.png" "http://localhost:3000/$p";
done
curl -s http://localhost:3000/catalog | grep -c "$ADMIN_TOKEN"   # → 0
curl -s "http://localhost:3000/api/exports/events?format=jsonl" -o /tmp/ev.jsonl && grep -c "payload_ciphertext" /tmp/ev.jsonl  # → 0
```

### Level 5: Additional
- Interpretation not-configured surfaces 503: POST `/api/projects/<id>/interpretations` with no provider →
  503 (forwarded), not 502/500.

---

## ACCEPTANCE CRITERIA

- [ ] Reports: generate (project + session, cost + AI interpretation) and **compare two versions via the
      `metrics` seam** (markdown side-by-side + numeric delta).
- [ ] Catalog: list + approve/reject (upload remains offline-CLI, noted in UI).
- [ ] Projects: create + rename; workspace→project remap.
- [ ] Search: reindex trigger returns counts.
- [ ] Pairing: generate a short-lived code with expiry + copy.
- [ ] Export: trigger redacted MD/JSON/JSONL/CSV downloads (events/report/transcript) via proxy stream.
- [ ] Settings: read-only versions/health; no secret rendered.
- [ ] Mutations check `res.ok`, disable in-flight, refetch; 404/503/502 surfaced distinctly.
- [ ] **`ADMIN_TOKEN` never in served HTML/JS** (grep == 0 on every new page).
- [ ] `typecheck:dashboard` = 0; `build:dashboard` builds; `npm test` passes; `repo-health` PASS. **No
      change** to `apps/ingest`/`packages/db`/`packages/shared`/schema/migrations.
- [ ] 12.2 complete; deferrals named.

## COMPLETION CHECKLIST

- [ ] 12.2a foundation present (proxy/types/format/nav) — verified before starting.
- [ ] Each surface: proxy → page/controls → `build:dashboard` → screenshot, committed per surface.
- [ ] `metrics-diff.test.ts` passes.
- [ ] Token-leak grep == 0 on every new page; export redaction verified (no ciphertext).
- [ ] `docs/guide/usage.md` updated; `SUMMARY.md`/PRD M12 **12.2 complete** with deferrals named.
- [ ] Code reviewed (`/lril:code-review`) — watch the M9-class leak windows (`request.signal` on every stream
      proxy; in-flight button disable; no stray timers/listeners).

---

## NOTES

### Verifications run during planning (evidence)
1. **Mutation pattern read verbatim** from `alerts-panel.tsx` @58-69 (POST same-origin, check `res.ok`,
   optimistic + rollback) and `alerts/firings/[id]/ack/route.ts` (POST proxy, awaited `params` Promise).
2. **Endpoint inventory** confirmed by reading `apps/ingest/src/routes/{reports,interpretations,catalog,
   projects,workspaces,search,pairing-codes,exports,health}.ts` + `auth.ts` + `schemas.ts`:
   - `POST /v1/projects/:id/reports {type?,bucket?}` (201); `POST /v1/sessions/:sessionId/reports {type?}` (201).
   - `POST /v1/projects/:id/interpretations` + `POST /v1/sessions/:sessionId/interpretations` (201, billable;
     503 not-configured / 502 provider error via the app error handler).
   - `GET /v1/catalog` → `PricingCatalogRow[]`; `POST /v1/catalog/:id/approve` + `.../reject` → row
     (404 if not pending).
   - `POST /v1/projects {name,gitRemote?}` → `{id}`; `PATCH /v1/projects/:id {name}` → `{id,name}`.
   - `PATCH /v1/workspaces/:id {projectId}` → `{id,projectId}` (400 malformed / 404 missing).
   - `POST /v1/search/reindex` → `ReindexCounts`.
   - `POST /v1/pairing-codes {email?}` → `{code,expiresAt}`.
   - Exports (stream + `content-disposition` + `x-export-*`): `GET /v1/exports/events?format=&projectId=&
     sessionId=&connector=&start=&end=`; `GET /v1/reports/:id/export?format=md|json`;
     `GET /v1/sessions/:sessionId/transcript/export?format=md|json|jsonl`.
   - `GET /v1/health` → `{status,time}`. All admin-gated (exports/health open? — health is open; the rest
     admin-gated); all already implemented.
3. **Type boundary:** `PricingCatalogRow` is in **`packages/db`** (pricing-catalogs.ts @18) → mirrored into
   `lib/types.ts` with `string` timestamps (it cannot be imported by the dashboard). `LiveMonitorSnapshot`
   (settings versions) is in `@420ai/shared`.
4. **Gate:** `repo-health` runs `typecheck:dashboard` + (sign-off) `build:dashboard`; no backend code ⇒ no
   `--require-db`.

### Design decisions (object on review if you disagree)
- **Catalog = approval gate only** (upload is offline ed25519-signed); **Settings = read-only** (no config
  API); **Pairing = generate-only** (no list endpoint). Building UI for non-existent endpoints would be
  guesswork — these are explicit scope lines.
- **Compare via `diffMetrics`** — pure, unit-tested, defensive over the `unknown`/per-reportType `metrics`
  shape. Headline = markdown side-by-side + a numeric delta table; a typed per-type diff is deferred.
- **Export via `<a download>` to the proxy** — simplest token-safe download; `proxyStream` forwards headers
  so the file saves correctly and truncation/row-count are visible.
- **Billable-call guardrails** — confirm step + in-flight disable + distinct 503/502 handling (interpretation
  hits a paid provider).

### Invariants preserved
- **Zero** backend change. D8 token discipline (server-only env reads; grep==0 gate). M9 leak-window
  discipline (`request.signal` on every stream proxy; in-flight disable; no stray timers).

### Deferred (name in the PR; do NOT build here)
- Catalog **upload** UI (offline signing only) + pricing-catalog diff view.
- Machine/ingest-token **revoke** + machine delete (no endpoint — needs backend later).
- **Editable** settings (auth, scheduled reports, provider config) — read-only (→ 12.3+).
- Rich Markdown + Mermaid report rendering; `ts_headline` bold-highlight; list/search pagination.
- Typed per-reportType metrics diff; a React component test harness.

### Confidence: 9.5 / 10
Every endpoint shape, the mutation pattern, the export-stream pattern, and the type boundary are verified by
reading source; the compare seam is reduced to a pure unit-tested helper; 12.2a supplies the proven
foundation. Residual 0.5: execution volume across six surfaces (a JSX/Tailwind slip only `next build`
catches — mitigated by building per surface) and the per-reportType variability of `metrics` (handled
defensively, cannot block). Depends on 12.2a being landed first (stated as a hard precondition).
