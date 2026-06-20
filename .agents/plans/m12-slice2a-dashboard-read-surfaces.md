# Feature: M12 Slice 12.2a — Dashboard Foundation + Read Surfaces (PRD §8.4)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — **import types from the right package** (the #1 risk here — see the "shared vs
db type" gotcha below).

> **Conventions are NOT re-pasted here.** Repo conventions (module/TS rules, the validation GATE, the
> "Frontend workspace" rules, the token-never-in-browser proxy discipline) live in
> [`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md). **Read the "Frontend workspace
> (`apps/dashboard`)" and "Logging / process boundaries" sections of `CLAUDE.md` before starting.**

> **This is the FIRST of two sub-slices of M12 Slice 12.2 (Dashboard Surfaces).**
> **12.2a (this plan)** ships the app-shell foundation + the read-only surfaces. **12.2b** (sibling plan
> `m12-slice2b-dashboard-mutations.md`) adds the mutating/admin surfaces (report generate+compare, catalog
> approve/reject, project create/rename, pairing, export, settings) and **depends on the foundation this
> slice lands** (`lib/proxy.ts`, `lib/types.ts`, `lib/format.ts`, the nav shell). Build 12.2a first.

## Feature Description

The dashboard today ships **only the Live Monitor** (M9). This slice lays the multi-page foundation and the
**read-only** surfaces over the **already-existing** ingest APIs — **no ingest/server/schema changes**:

1. **App shell** — a generalized server-side proxy helper, dashboard-local wire types, shared formatters, a
   persistent nav, and a page-shell wrapper. Everything 12.2b reuses.
2. **Projects** — list + per-project detail (summary, usage totals/by-model/over-time, sessions, git metadata). *Read only — create/rename is 12.2b.*
3. **Reports** — list versioned artifacts + view markdown. *Read only — generate/compare is 12.2b.*
4. **Search** — query the M12.1 redacted search index. *Reindex trigger is 12.2b.*
5. **Machines** — read-only machine/workspace health (status, backlog, heartbeat). *Workspace remap is 12.2b.*

Every browser→ingest call goes through a **same-origin proxy Route Handler** that adds the admin bearer on
the server→ingest hop — **`ADMIN_TOKEN` never reaches the browser** (the repo-wide D8 invariant).

This slice is **entirely additive new files** under `apps/dashboard/`. The only edits to existing files are
the nav in `layout.tsx`, the root `page.tsx` redirect, and doc updates. The Live Monitor page is untouched.

## User Story

As the **self-hosted single user (admin)** of 420AI
I want to **browse my projects, read reports, search, and watch machines from the web dashboard**
So that **I can inspect the archive without raw `curl` + `ADMIN_TOKEN` — and the admin token never leaves
the server while I do it**.

## Problem Statement

The ingest API exposes a complete admin read surface (projects, projections, reports, search, monitor,
workspaces), but the **only** UI is the Live Monitor. The dashboard has a proven **single-purpose** proxy
pattern (`/api/monitor`, `/api/monitor/stream`, `/api/alerts/firings/[id]/ack`) but **no general way** to
proxy arbitrary admin GET calls and **no navigation** between pages.

## Solution Statement

1. **Generalize the proxy.** Extract the verbatim monitor-proxy pattern into a small server-only helper
   (`proxyJson`/`proxyStream`) and add **thin per-endpoint Route Handlers** under `app/api/**`.
2. **App shell + nav.** Add a persistent nav in `layout.tsx` (server component) linking all surfaces.
3. **One page per surface.** Each page is a **Server Component** that fetches initial data via the proxy
   (server→ingest hop) and hands it to a **`"use client"`** component, mirroring `MonitorPage → LiveMonitor`.
4. **Dashboard-local wire types.** The dashboard depends on **`@420ai/shared` only** (not `@420ai/db`), so
   define local wire-shape types for db-origin rows with **timestamps as `string`** (JSON-over-HTTP turns
   `Date` into ISO string). Import shared types directly.

## Feature Metadata

**Feature Type**: New Capability (frontend)
**Estimated Complexity**: Medium — **low blast radius** (additive `apps/dashboard` files; **zero** changes
to `apps/ingest`, `packages/db`, `packages/shared`, schema, or migrations)
**Primary Systems Affected**: `apps/dashboard` only.
**Dependencies**: None new. Next 16.2.9 / React 19.2.7 / Tailwind v4 (all present). Reuses `@420ai/shared`
types + existing shadcn primitives (`Card`/`Table`/`Badge`/`cn`/`DataCard`) + `ingestUrl()`/`adminHeaders()`.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Dashboard patterns to mirror:**

- `apps/dashboard/src/lib/ingest.ts` (full, 1-19) — the **only** ingest access: `ingestUrl()` (@11) +
  `adminHeaders()` (@16). Server-only — NEVER import from a `"use client"` file. The proxy helper builds on these.
- `apps/dashboard/src/app/api/monitor/route.ts` (full, 1-25) — the **GET JSON proxy** to generalize:
  `force-dynamic`; refused upstream THROWS → try/catch → 502; `!res.ok` → 502.
- `apps/dashboard/src/app/api/monitor/stream/route.ts` (full) — the **SSE/stream proxy**: `signal:
  request.signal` ties the upstream hop to the browser; pipe `upstream.body` unchanged. (Not used in 12.2a —
  but `proxyStream` is defined here for 12.2b's export downloads; keep it.)
- `apps/dashboard/src/app/api/alerts/firings/[id]/ack/route.ts` (full, 1-29) — the **dynamic `[id]`**
  pattern: `params` is a `Promise` in Next 16 and MUST be `await`ed (@14-15).
- `apps/dashboard/src/app/monitor/page.tsx` (full, 1-29) — the **Server Component page** shape:
  `export const dynamic = "force-dynamic"`, fetch initial via `ingestUrl()`+`adminHeaders()` in try/catch
  with a safe fallback, hand to a client component.
- `apps/dashboard/src/components/live-monitor.tsx` (full, 1-74) — the **client component** shape:
  `"use client"`, `useState` seeded from `initial`, `<main className="mx-auto max-w-6xl px-6 py-10">` layout,
  header block (@46-70 → extract into `PageShell`).
- `apps/dashboard/src/components/monitor/monitor-view.tsx` (1-213) — the **table+card render** pattern
  (Card/Table/Badge composition, monospace IDs, status→badge maps, `dataCardStatus()` mapping).
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` (@18-29) — `formatAgo(iso, nowMs)` to extract into
  `lib/format.ts` (and have alerts-panel import it — DRY, no behavior change).
- `apps/dashboard/src/components/ui/card.tsx` — exports `Card, CardHeader, CardFooter, CardTitle,
  CardDescription, CardContent`.
- `apps/dashboard/src/components/ui/table.tsx` — exports `Table, TableHeader, TableBody, TableHead,
  TableRow, TableCell`.
- `apps/dashboard/src/components/ui/badge.tsx` — exports `Badge, badgeVariants` (variants `default|
  secondary|destructive|outline`; pass `className` for custom tints).
- `apps/dashboard/src/components/data-card.tsx` (1-106) — `DataCard` (props `title`, `subtitle`,
  `fields:{label,value,highlight}[]`, `status:"active"|"inactive"|"alert"`) for summary tiles.
- `apps/dashboard/src/lib/utils.ts` — `cn(...)`.
- `apps/dashboard/src/app/layout.tsx` (full, 1-15) — where the nav shell goes; `<html className="dark">`.
- `apps/dashboard/src/app/page.tsx` — root redirect (currently `redirect("/monitor")`).
- `apps/dashboard/src/lib/ingest.test.ts` (full) — the **vitest** pattern for new lib-helper tests
  (env save/restore in `afterEach`).
- `apps/dashboard/package.json`, `next.config.ts`, `tsconfig.json` — Next **16.2.9**, React **19.2.7**, TS
  strict, `@/*`→`./src/*`, `transpilePackages:["@420ai/shared"]`, `typecheck = tsc --noEmit`.

**Type sources (CRITICAL — import from the correct package):**

- `packages/shared/src/index.ts` — the barrel. **Import dashboard types from `@420ai/shared`.**
- `packages/shared/src/projections.ts` — `SessionProjection` @16, `UsageTotals` @38, `UsageByModelRow` @46,
  `UsageOverTimeRow` @53, `ConnectorHealthRow` @60, `ProjectGitMetadata` @71. **All timestamps already ISO
  `string`.** Import directly.
- `packages/shared/src/monitor.ts` — `LiveMonitorSnapshot`, `MachineStatusRow`, `ActiveSessionRow`,
  `MonitorStatus`, `emptyMonitorSnapshot()`. ISO strings.
- `packages/shared/src/search.ts` — `SearchResults`, `SearchHit`, `SearchEntityType`, `ReindexCounts`.
- `packages/db/src/repositories/reports.ts` (`ReportArtifactRow` @14-29) — **db-origin; `generatedAt: Date`.
  DO NOT import in the dashboard.** Mirror locally with `generatedAt: string`.
- `packages/db/src/repositories/projects.ts` (`ProjectRow` @11) — db-origin; `createdAt`/`archivedAt: Date`.
  Mirror locally with `string`.
- `packages/db/src/repositories/workspaces.ts` (`WorkspaceRow` @14) — db-origin; `createdAt`/`lastSeenAt:
  Date`. Mirror locally with `string`.
- `ProjectEventSummary` — **not in `@420ai/shared`** (in db). Mirror locally (type the fields you render;
  grep `packages/db/src/repositories/projects.ts` for the exact shape).

### New Files to Create

**Foundation (shared by 12.2b)**
- `apps/dashboard/src/lib/proxy.ts` — `proxyJson()` + `proxyStream()` server-only helpers.
- `apps/dashboard/src/lib/proxy.test.ts` — vitest (mirror `ingest.test.ts`).
- `apps/dashboard/src/lib/types.ts` — dashboard-local **wire** types (timestamps `string`).
- `apps/dashboard/src/lib/format.ts` (+ `format.test.ts`) — `formatAgo`, `formatUsd`, `formatTokens`, `formatDate`.
- `apps/dashboard/src/components/app-nav.tsx` — nav shell (server component; `<Link>`s).
- `apps/dashboard/src/components/page-shell.tsx` — `<main>` + header wrapper.

**Read-surface proxy Route Handlers** (all `force-dynamic`)
- `app/api/projects/route.ts` (GET list only in 12.2a; POST create is 12.2b)
- `app/api/projects/[id]/summary/route.ts`, `.../usage/route.ts`, `.../usage/by-model/route.ts`,
  `.../usage/over-time/route.ts`, `.../git/route.ts`, `.../sessions/route.ts` (GET)
- `app/api/reports/route.ts` (GET list), `app/api/reports/[id]/route.ts` (GET one)
- `app/api/search/route.ts` (GET)
- `app/api/workspaces/route.ts` (GET list)

**Pages + client views**
- `app/projects/page.tsx` + `components/projects/projects-view.tsx`
- `app/projects/[id]/page.tsx` + `components/projects/project-detail-view.tsx`
- `app/reports/page.tsx` + `components/reports/reports-view.tsx`
- `app/search/page.tsx` + `components/search/search-view.tsx`
- `app/machines/page.tsx` + `components/machines/machines-view.tsx`

### Files to Modify

- `apps/dashboard/src/app/layout.tsx` — wrap `children` with the nav shell; update `metadata.title`.
- `apps/dashboard/src/app/page.tsx` — keep `redirect("/monitor")` (Decision: proven landing; note in PR).
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` — import `formatAgo` from `lib/format.ts` (remove
  the local copy; **no behavior change**).
- `docs/guide/usage.md` — add a "Dashboard" section (read surfaces).
- `SUMMARY.md` §6 / `docs/PRD.md` §25 M12 — note 12.2a status **on sign-off only**.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [Next.js — Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
  — the proxy handlers. **Dynamic `params` is a `Promise` in Next 16** (must `await`).
- [Next.js — `next/link`](https://nextjs.org/docs/app/api-reference/components/link) — the nav shell.
- [Next.js — Server Components data fetching](https://nextjs.org/docs/app/building-your-application/data-fetching)
  — pages fetch server-side with `cache: "no-store"` + `force-dynamic`.

### Patterns to Follow

**Generalized proxy** (`apps/dashboard/src/lib/proxy.ts`) — distilled VERBATIM from the three monitor proxies:

```ts
// SERVER-ONLY. Built on the same ingestUrl()/adminHeaders() the monitor proxies use (D8).
import { NextResponse } from "next/server";
import { ingestUrl, adminHeaders } from "@/lib/ingest";

type Init = { method?: string; body?: BodyInit | null; contentType?: string };

/** Proxy a JSON request to ingest, adding the admin bearer on the server→ingest hop. */
export async function proxyJson(path: string, init: Init = {}): Promise<NextResponse> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: { ...adminHeaders(), ...(init.contentType ? { "content-type": init.contentType } : {}) },
      body: init.body ?? null,
      cache: "no-store",
    });
    const text = await res.text(); // ingest always replies JSON; pass through verbatim
    if (!res.ok) {
      return new NextResponse(text || JSON.stringify({ error: "ingest error", status: res.status }), {
        status: res.status, // forward 400/401/404 so the UI can react (404 → "not found")
        headers: { "content-type": "application/json" },
      });
    }
    return new NextResponse(text, { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
}

/** Proxy a streaming file download (for 12.2b exports), forwarding content-disposition + x-export-* headers. */
export async function proxyStream(path: string, signal: AbortSignal): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${ingestUrl()}${path}`, { headers: adminHeaders(), cache: "no-store", signal });
  } catch {
    return new Response("ingest unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new Response("ingest error", { status: upstream.status || 502 });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const h of ["content-type", "content-disposition", "x-export-row-count", "x-export-truncated", "x-export-redaction-version"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: 200, headers });
}
```

> **Spike-snippet fidelity:** these reproduce the exact contract of the three existing proxies.
> `force-dynamic` belongs on each **route file**, not the helper. The `!res.ok` branch **forwards the
> upstream status** (the monitor proxy collapses to 502) — intentional, so a page can show "not found" on a
> 404 vs "ingest down" on a 502 (only a thrown/unreachable hop becomes 502).

**A thin GET Route Handler** (e.g. `app/api/projects/route.ts`):

```ts
import { proxyJson } from "@/lib/proxy";
export const dynamic = "force-dynamic";
export async function GET() { return proxyJson("/v1/projects"); }
```

**A dynamic-param GET handler** (Next 16 — `params` is a Promise):

```ts
import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";
export const dynamic = "force-dynamic";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/projects/${id}/summary`);
}
```

**A querystring-forwarding handler** (e.g. `app/api/search/route.ts`):

```ts
import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) { return proxyJson(`/v1/search${req.nextUrl.search}`); }
```

**Server-Component page** (mirror `monitor/page.tsx`):

```tsx
import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { ProjectsView } from "@/components/projects/projects-view";
import type { ProjectRow } from "@/lib/types";
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let projects: ProjectRow[] = [];
  try {
    const res = await fetch(`${ingestUrl()}/v1/projects`, { headers: adminHeaders(), cache: "no-store" });
    if (res.ok) projects = ((await res.json()) as { projects: ProjectRow[] }).projects;
  } catch { /* render empty */ }
  return <ProjectsView initial={projects} />;
}
```

**Dashboard-local wire types** (db-origin rows; `Date`→`string`):

```ts
// apps/dashboard/src/lib/types.ts — wire shapes (JSON over HTTP ⇒ all timestamps are ISO strings).
export interface ProjectRow {
  id: string; userId: string; name: string; gitRemote: string | null;
  createdAt: string; archivedAt: string | null; // server type is Date
}
export interface ReportArtifactRow {
  id: string; userId: string; projectId: string | null; reportType: string; scopeKind: string;
  scopeId: string; version: number; reportVersion: string; catalogVersion: string | null;
  analysisVersion: string | null; params: unknown; metrics: unknown; markdown: string;
  generatedAt: string; // server type is Date
}
export interface WorkspaceRow {
  id: string; userId: string; projectId: string | null; machineId: string | null;
  rootPath: string; gitRemote: string | null; gitBranch: string | null;
  createdAt: string; lastSeenAt: string; // server type is Date
}
// + ProjectEventSummary mirrored from packages/db (timestamps as string).
// NOTE: PricingCatalogRow is added by 12.2b — leave it out here unless you choose to seed it now.
```

**Naming/style:** `kebab-case.tsx` files; `PascalCase` components; client components start with `"use
client"`; `import type` for shared types; `cn()` for classes; reuse `Card`/`Table`/`Badge`; dark theme is global.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation
The substrate every page (and all of 12.2b) reuses. **Land and `next build` before any page.**
`lib/proxy.ts` (+test), `lib/types.ts`, `lib/format.ts` (+test), `components/app-nav.tsx`,
`components/page-shell.tsx`, nav into `layout.tsx`, alerts-panel `formatAgo` import.

### Phase 2: Read surfaces
**Projects (list → detail) → Reports (list+view) → Search → Machines.** Proxy → page → view → build → screenshot.

### Phase 3: Testing & Validation
Lib-helper unit tests; `typecheck:dashboard` + `build:dashboard`; manual screenshots + token-leak grep == 0.

---

## STEP-BY-STEP TASKS

Execute in order. **After each surface run `npm run build:dashboard`** — the only thing that catches
type/JSX/theGridCN-barrel errors (root `tsc -b` cannot see the dashboard).

### Phase 1 — Foundation

#### CREATE `apps/dashboard/src/lib/proxy.ts`
- **IMPLEMENT**: `proxyJson` + `proxyStream` exactly as in "Patterns".
- **PATTERN**: `app/api/monitor/route.ts`, `.../alerts/firings/[id]/ack/route.ts`, `.../monitor/stream/route.ts`.
- **IMPORTS**: `import { NextResponse } from "next/server";` `import { ingestUrl, adminHeaders } from "@/lib/ingest";`
- **GOTCHA**: SERVER-ONLY (reads `process.env.ADMIN_TOKEN`). Forward upstream status on `!res.ok`; 502 only on a thrown fetch.
- **VALIDATE**: `npm run typecheck:dashboard` → 0 errors.

#### CREATE `apps/dashboard/src/lib/proxy.test.ts`
- **IMPLEMENT**: stub `globalThis.fetch`; assert bearer added when `ADMIN_TOKEN` set; `!res.ok` status
  forwarded; thrown fetch → 502. Restore env/fetch in `afterEach`.
- **PATTERN**: `lib/ingest.test.ts`.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/proxy.test.ts` → pass.

#### CREATE `apps/dashboard/src/lib/types.ts`
- **IMPLEMENT**: `ProjectRow`, `ReportArtifactRow`, `WorkspaceRow`, `ProjectEventSummary` (mirror db shapes,
  timestamps `string`).
- **GOTCHA**: timestamps are `string`, not `Date` (JSON serializes `Date` → ISO). Typing them `Date` and
  calling `.toISOString()` in the browser is the classic bug this prevents.
- **VALIDATE**: `npm run typecheck:dashboard` → 0 errors.

#### CREATE `apps/dashboard/src/lib/format.ts` (+ `format.test.ts`)
- **IMPLEMENT**: pure `formatAgo(iso, nowMs)` (copy from `alerts-panel.tsx` @18-29), `formatUsd(n)`
  (`$0.0000`), `formatTokens(n)` (thousands separators), `formatDate(iso)`.
- **GOTCHA**: keep pure (inject `nowMs`; no `Date.now()` inside) so tests are deterministic.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/format.test.ts` → pass.

#### UPDATE `apps/dashboard/src/components/monitor/alerts-panel.tsx`
- **IMPLEMENT**: replace the local `formatAgo` with `import { formatAgo } from "@/lib/format";`.
- **GOTCHA**: behavior identical — same function moved. Do not touch the rest of the file.
- **VALIDATE**: `npm run build:dashboard` → builds; Live Monitor alerts still render times.

#### CREATE `apps/dashboard/src/components/app-nav.tsx` + `page-shell.tsx`
- **IMPLEMENT**: `AppNav` = server component, `<nav>` with `<Link>`s to `/monitor`, `/projects`, `/reports`,
  `/search`, `/machines` (12.2b adds `/catalog`, `/pairing`, `/export`, `/settings` — adding those links now
  is fine; they 404 until 12.2b). `PageShell({title, subtitle, actions, children})` = the
  `<main className="mx-auto max-w-6xl px-6 py-10">` + header block from `live-monitor.tsx` @46-70.
- **IMPORTS**: `import Link from "next/link";` `import { cn } from "@/lib/utils";`
- **GOTCHA**: `AppNav` has no interactivity → keep it a server component (no `"use client"`). An active-link
  highlight needs `usePathname()` (client) — optional; isolate in a small client child if added.
- **VALIDATE**: `npm run typecheck:dashboard` → 0 errors.

#### UPDATE `apps/dashboard/src/app/layout.tsx`
- **IMPLEMENT**: render `<AppNav/>` alongside `{children}`; update `metadata.title` to "420AI — Dashboard".
- **PATTERN**: keep `<html lang="en" className="dark">` + `<body className="min-h-screen antialiased">`.
- **VALIDATE**: `npm run build:dashboard` → builds; nav renders on every route incl. `/monitor`.

### Phase 2 — Read surfaces

#### CREATE projects list (proxy + page + view)
- **IMPLEMENT**: `api/projects/route.ts` (GET `/v1/projects`); `app/projects/page.tsx` (fetch `{projects}`);
  `components/projects/projects-view.tsx` (`"use client"`, Table: name, gitRemote, createdAt via `formatDate`,
  each row links to `/projects/[id]`). Wrap in `PageShell` (title "Projects").
- **PATTERN**: page = `monitor/page.tsx`; table = `monitor-view.tsx`.
- **GOTCHA**: response is `{ projects: ProjectRow[] }` (object, not bare array). `createdAt` is a string.
- **VALIDATE**: `npm run build:dashboard`; manual: nav → Projects shows rows.

#### CREATE project detail (summary + usage + sessions + git)
- **IMPLEMENT**: `api/projects/[id]/summary|usage|usage/by-model|usage/over-time|git|sessions/route.ts` (GET,
  dynamic `[id]` awaited); `app/projects/[id]/page.tsx` (fetch summary + usage + by-model + over-time + git +
  sessions with `Promise.all`); `components/projects/project-detail-view.tsx` — `DataCard` tiles for totals
  (cost via `formatUsd(costUsd)`, tokens via `formatTokens(tokens.total)`, `costConfidence` badge), a
  by-model Table, an over-time list, a sessions Table, and a git block (`branches`, `projectPaths`).
- **PATTERN**: `monitor-view.tsx` cards+tables; `UsageTotals`/`UsageByModelRow`/`UsageOverTimeRow`/
  `SessionProjection`/`ProjectGitMetadata` from `@420ai/shared`; `ProjectEventSummary` from `lib/types.ts`.
- **GOTCHA**: `isUuid` guards server-side → a malformed id returns **404** through the proxy → render a
  "project not found" state, not a crash. `costUsd`/`tokens`/timestamps from shared types are already
  numbers/ISO (coercion happened server-side in M6 — no re-coercion).
- **VALIDATE**: `npm run build:dashboard`; manual: open a real project id; tiles + tables populate.

#### CREATE reports list + view (read only)
- **IMPLEMENT**: `api/reports/route.ts` (GET `/v1/reports?type=&scopeId=`), `api/reports/[id]/route.ts` (GET
  one); `app/reports/page.tsx` (fetch `ReportArtifactRow[]`); `components/reports/reports-view.tsx` (Table:
  reportType, scopeId, version, generatedAt, catalogVersion/analysisVersion badges; select a row → render
  its `markdown` in `<pre className="whitespace-pre-wrap">`). Optional `type`/`scopeId` filter inputs.
- **PATTERN**: `monitor-view.tsx` table; `ReportArtifactRow` from `lib/types.ts` (db-origin).
- **GOTCHA**: list response is a **bare array** `ReportArtifactRow[]` (not wrapped). `metrics`/`params` are
  `unknown` — don't render them structurally yet (the compare view is 12.2b). Newest-first is server-side.
  Markdown is shown as preformatted text this slice (rich Markdown/Mermaid renderer is **deferred**).
- **VALIDATE**: `npm run build:dashboard`; manual: list shows artifacts; clicking one shows markdown.

#### CREATE search page
- **IMPLEMENT**: `api/search/route.ts` (GET, forward `req.nextUrl.search`); `app/search/page.tsx` (renders
  the view; no initial fetch); `components/search/search-view.tsx` (`"use client"`: query input + type filter
  `session|report|project` + optional projectId; on submit GET `/api/search?q=…`; render `hits` with
  `entityType` badge, `title`, the redacted `snippet` as **plain text**, `rank`; link each hit to its entity
  page).
- **PATTERN**: client fetch from `alerts-panel.tsx`; `SearchResults`/`SearchHit` from `@420ai/shared`.
- **GOTCHA**: the snippet is **already redacted** (content-safe) but contains `ts_headline` `<b>` markup —
  render as **text** (XSS-safe; bold-highlight is deferred). `q` required (schema `minLength:1`) → disable
  submit when empty. Malformed `projectId` → 404 through proxy → show "no results"/inline error.
- **VALIDATE**: `npm run build:dashboard`; manual: search a known phrase returns hits; no secret appears.

#### CREATE machines page (read-only)
- **IMPLEMENT**: `api/workspaces/route.ts` (GET `/v1/workspaces`); reuse the existing `api/monitor/route.ts`
  for machine status; `app/machines/page.tsx` (fetch monitor snapshot + workspaces); `components/machines/
  machines-view.tsx` (machines Table from `LiveMonitorSnapshot.machines`: name, os, status badge,
  backlogHigh, queuePending/Inflight, lastHeartbeatAt via `formatAgo`; workspaces Table: rootPath, gitRemote,
  gitBranch, projectId).
- **PATTERN**: `monitor-view.tsx` (already renders `machines`); `MachineStatusRow` from `@420ai/shared`,
  `WorkspaceRow` from `lib/types.ts`.
- **GOTCHA**: **read-only** — no machine/token-revoke endpoint exists (deferred); workspace→project **remap**
  is a mutation → **12.2b**.
- **VALIDATE**: `npm run build:dashboard`; manual: machines + workspaces render.

### Phase 3 — Testing & Validation

#### RUN the gate + lib tests
- **VALIDATE**:
  - `npm run typecheck:dashboard` → 0 errors.
  - `npm run build:dashboard` → builds (the dashboard milestone gate).
  - `npm test` → all pass (new `proxy.test.ts` + `format.test.ts` run; rest unchanged).
  - `npm run repo-health` → PASS (root `tsc -b` unaffected — no backend change). **No `--require-db` needed**
    (touches neither `@420ai/db` nor `apps/ingest`).

#### Manual evidence (headless Edge — CLAUDE.md)
- **VALIDATE** (`$EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`):
  - screenshot `/projects`, `/projects/<id>`, `/reports`, `/search`, `/machines`, `/monitor`.
  - **Token-leak**: `curl -s http://localhost:3000/projects | grep -c "$ADMIN_TOKEN"` → **0** (repeat per page).

#### UPDATE docs + sign-off
- **IMPLEMENT**: add a "Dashboard (read surfaces)" section to `docs/guide/usage.md`; on green gate note 12.2a
  in `SUMMARY.md` §6 + `docs/PRD.md` §25 M12, naming deferrals (rich markdown render, ts_headline bold,
  mutations → 12.2b).
- **VALIDATE**: `grep -c "Dashboard" docs/guide/usage.md` ≥ 1.

---

## TESTING STRATEGY

### Unit Tests (vitest — the repo's only frontend test layer)
- `lib/proxy.test.ts` — bearer added; `!res.ok` status forwarded; thrown fetch → 502. Mirror `ingest.test.ts`.
- `lib/format.test.ts` — `formatAgo`/`formatUsd`/`formatTokens`/`formatDate` pure assertions.
- **No React component tests** — the repo has no `@testing-library/react`/jsdom (only `lib/ingest.test.ts`
  exists). Do **not** add a test framework here; rely on `build:dashboard` + screenshots (M9 precedent).

### Integration Tests
- **None.** No backend change ⇒ no `*.int.test.ts`; no `--require-db`. The ingest int tests already cover
  every consumed endpoint.

### Edge Cases
- Ingest unreachable → page renders empty fallback; proxy 502; non-fatal UI.
- Malformed/unknown uuid → proxy forwards **404** → "not found" state.
- Empty archive → friendly empty tables.
- Empty search query → submit disabled.
- `ts_headline` HTML in snippet → rendered as text (redacted, XSS-safe).

---

## VALIDATION COMMANDS

### Level 1: Typecheck
- `npm run typecheck` (root `tsc -b`) → **exit 0** (unchanged — must stay green).
- `npm run typecheck:dashboard` (`tsc --noEmit`) → **exit 0** — the real type gate.

### Level 2: Unit suite
- `npm test` → all pass; the two new dashboard test files run.

### Level 3: Build gate
- `npm run build:dashboard` (`next build`) → builds clean (gates dashboard sign-off; catches what root
  `tsc -b` cannot).
- `npm run repo-health` → PASS.

### Level 4: Manual Validation (headless Edge)
```bash
npm run ingest:dev      # terminal A
npm run dashboard:dev   # terminal B (ADMIN_TOKEN/INGEST_URL in apps/dashboard/.env.local)
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
for p in monitor projects reports search machines; do
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot="/tmp/420-$p.png" "http://localhost:3000/$p";
done
curl -s http://localhost:3000/projects | grep -c "$ADMIN_TOKEN"   # → 0
```

### Level 5: Additional
- 404-not-502 surfaced: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/projects/not-a-uuid/summary"` → 404.

---

## ACCEPTANCE CRITERIA

- [ ] Persistent nav reaches all surfaces; Live Monitor still works.
- [ ] Every browser→ingest call proxies through a same-origin Route Handler; **`ADMIN_TOKEN` never in served
      HTML/JS** (grep == 0 on every page).
- [ ] Projects list + detail (summary, usage totals/by-model/over-time, sessions, git) render.
- [ ] Reports list + markdown view render (read only).
- [ ] Search queries the 12.1 index (type/project filters); redacted snippets only.
- [ ] Machines: read-only status/backlog/heartbeat + workspaces.
- [ ] Proxy forwards upstream status (404 vs 401 vs 400); 502 only on unreachable hop.
- [ ] `typecheck:dashboard` = 0; `build:dashboard` builds; `npm test` passes; `repo-health` PASS. **No
      change** to `apps/ingest`/`packages/db`/`packages/shared`/schema/migrations.
- [ ] Deferrals named (rich markdown, ts_headline bold, all mutations → 12.2b).

## COMPLETION CHECKLIST

- [ ] Phase 1 foundation landed + built before any page.
- [ ] Each surface: proxy → page → view → `build:dashboard` → screenshot, committed per surface.
- [ ] `proxy.test.ts` + `format.test.ts` pass; alerts-panel still renders (formatAgo move).
- [ ] Token-leak grep == 0 on every page; 404-vs-502 verified.
- [ ] `docs/guide/usage.md` updated; `SUMMARY.md`/PRD 12.2a noted with deferrals.
- [ ] Code reviewed (`/lril:code-review`) — watch the M9-class leak windows (`request.signal` on the stream
      proxy; no stray `setInterval`/listener without cleanup).

---

## NOTES

### Verifications run during planning (evidence)
1. **Proxy pattern read verbatim** from `monitor/route.ts`, `monitor/stream/route.ts`,
   `alerts/firings/[id]/ack/route.ts` — `force-dynamic`, try/catch→502, `!res.ok`→502, `signal:
   request.signal`, **Next 16 `params` is a `Promise` (awaited)**.
2. **Type-package boundary confirmed:** dashboard `package.json` depends on `@420ai/shared` only;
   `next.config.ts` transpiles `@420ai/shared` only. `ReportArtifactRow`/`ProjectRow`/`WorkspaceRow` are in
   **`packages/db`** with **`Date`** fields → mirrored locally with `string`. `SessionProjection`/
   `UsageTotals`/`UsageByModelRow`/`UsageOverTimeRow`/`ConnectorHealthRow`/`ProjectGitMetadata` are in
   `@420ai/shared` (projections.ts @16/38/46/53/60/71) with ISO `string` → imported directly.
   `ProjectEventSummary` not in shared → mirrored.
3. **UI primitives + helpers confirmed by reading source:** `Card*`, `Table*`, `Badge`+`badgeVariants`,
   `cn`, `DataCard`, `formatAgo` (alerts-panel @18-29), the `MonitorPage → LiveMonitor` composition.
4. **Endpoints confirmed** by reading `apps/ingest/src/routes/{projects,reports,projections,search,
   workspaces,monitor}.ts` + `auth.ts`: `GET /v1/projects`→`{projects:ProjectRow[]}`;
   `GET /v1/projects/:id/{summary,usage,usage/by-model,usage/over-time,git,sessions}`;
   `GET /v1/reports?type=&scopeId=`→`ReportArtifactRow[]`; `GET /v1/reports/:id`;
   `GET /v1/search?q=&type=&projectId=&limit=`→`SearchResults`; `GET /v1/workspaces`→`{workspaces:WorkspaceRow[]}`;
   `GET /v1/monitor`→`LiveMonitorSnapshot`. All admin-gated; all already implemented.
5. **Gate confirmed:** `repo-health` runs `typecheck:dashboard` + (sign-off) `build:dashboard`; this slice
   adds no backend code ⇒ no `--require-db`.

### Design decisions (object on review if you disagree)
- **Generalized proxy helper** over per-route copy-paste — keeps D8 token discipline in one audited place;
  forwards upstream status so pages distinguish 404/401/400 from a 502 unreachable hop.
- **Server-Component page + client view per surface** — mirrors M9 (real SSR first paint). No SWR/React-Query
  (deps unchanged).
- **Dashboard-local wire types** (not importing db types, not promoting to shared) — lowest blast radius and
  honest about `Date`→ISO `string`.
- **Markdown as preformatted text** this slice — deps frozen; rich renderer deferred.
- **`proxyStream` defined now** (used by 12.2b) so the foundation is complete in one place.

### Invariants preserved
- **Zero** backend change. D8 token discipline (server-only env reads; grep==0 gate). M9 leak-window
  discipline (`request.signal` on the stream proxy; new pages are request/response).

### Deferred (name in the PR; do NOT build here — most land in 12.2b)
- All mutations: project create/rename, workspace remap, report generate, **report compare**, catalog
  approve/reject, search reindex, pairing, export, settings (→ 12.2b).
- Rich Markdown + Mermaid rendering; `ts_headline` bold-highlight; list pagination; machine/token revoke
  (no endpoint); React component test harness.

### Confidence: 9.6 / 10
The load-bearing unknowns are all retired by reading source (proxy contract, page/client composition, UI
primitives, the shared-vs-db type boundary + `Date`→`string` wire reality, exact read-endpoint shapes). The
surface count is small (5), each additive and independently buildable, with a per-surface `build:dashboard`
gate. Residual 0.4: pure execution volume (a JSX/Tailwind slip that only `next build` catches — mitigated by
building per surface) and the exact `ProjectEventSummary` field set (grep `packages/db` to confirm before
rendering more than counts — cannot block the slice).
