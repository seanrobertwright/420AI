# Feature: M14 Slice 14.3 — Desktop polish (connectorHealth panel + admin-email nav)

> Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (proxy discipline, frontend workspace lanes,
> validation gate) — this plan links, not re-pastes. Milestone definition + scope:
> [`m14-general-ai-chat-capture.md`](./m14-general-ai-chat-capture.md) (slice 14.3, D-M14-3).

## Feature Description

Close the remaining category-B "desktop polish" deferrals with **two purely-additive frontend
items** (no backend, no Rust, no control-protocol change):

1. **Surface per-connector health in the desktop panel.** The desktop's `SyncHealth.tsx` already
   fetches the `LiveMonitorSnapshot` and holds `snapshot.connectors: ConnectorHealthRow[]`, but
   renders it only as a **count** (`<Stat label="connectors" value={snapshot.connectors.length} />`,
   `SyncHealth.tsx:219`). Render it as a per-connector table (last event, event count, tool
   failure ratio) — the data is already on the wire.
2. **Admin email in the dashboard nav.** Add a same-origin `/api/auth/me` proxy Route Handler and
   display the returned email in `app-nav.tsx` next to the Logout button. `GET /v1/auth/me` already
   exists on ingest and returns `{ email }`; the browser never holds the token (proxy discipline).

### Scope change from the milestone doc (settled with the user during planning)

- **connectorHealth via Path B, NOT "widen `ConnectorInfo`/`mapConnectorInfo`."** The milestone
  doc's implementation hint is architecturally wrong: `ConnectorInfo` travels the **control
  protocol** (stdio between the Tauri Rust shell and the collector **sidecar**), but `connectorHealth`
  is a **Postgres event-aggregation** computed in `packages/db` — the sidecar has **no DB access**
  and cannot produce a `ConnectorHealthRow`. Widening `ConnectorInfo` would require piping
  event-derived health into the sidecar it doesn't have, **plus** a `CONTROL_PROTOCOL_VERSION` bump
  (`m12-control-v3` → `v4`) **plus** a Rust serde mirror update. The same health is **already on the
  desktop** via the monitor HTTP snapshot (`LiveMonitorSnapshot.connectors`), so Path B renders it
  with **zero wire change, no version bump, no sidecar plumbing**. This plan supersedes the doc's
  hint for the *mechanism*; the *goal* (health visible in the desktop panel) is unchanged.
- **GUI unpair is DROPPED — it already shipped in M11 Slice 4.** `server::unpair` → `keychain::clear()`
  → registered in `lib.rs` → `bridge.ts` wrapper → a working **Unpair button in `Settings.tsx`**
  (`Settings.tsx:480-487`). The milestone doc's "deferral" row was stale. No code; the milestone doc
  is corrected in Task 5.

## User Story

As the self-hosting admin
I want to see each connector's health in the desktop app and my admin identity in the dashboard nav
So that I can spot a failing/stale connector locally and confirm which account I'm logged in as —
without curl or reading server logs.

## Problem / Solution

**Problem:** two thin visibility gaps. The desktop already fetches per-connector health but throws
it away as a bare count; the dashboard shows a Logout button but never says *who* is logged in.

**Solution:** additive rendering only. (1) A connector health table inside the existing
`SyncHealth.tsx` server-view block, reusing its already-imported `Table`/`Badge` primitives and its
`formatAgo()` helper. (2) A one-line `/api/auth/me` GET proxy (mirroring `api/catalog/route.ts`) +
a client fetch in `AppNav` that shows the email. Zero backend diff; proxy discipline per `CLAUDE.md`.

## Feature Metadata

**Feature Type**: Enhancement (frontend-only, additive)
**Estimated Complexity**: Low
**Primary Systems Affected**: `apps/desktop` (webview) + `apps/dashboard` only
**Dependencies**: none new (uses existing `@420ai/shared` types + `/v1/auth/me`)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ BEFORE IMPLEMENTING

**Item 1 — connectorHealth (desktop):**

- `apps/desktop/src/components/SyncHealth.tsx` (whole file) — the panel to edit. Already: fetches
  `snapshot` via `getMonitorSnapshot()` (`:77`); has `formatAgo(iso, nowMs)` (`:36-47`) for
  `lastEventAt`; computes `const nowMs = Date.now()` (`:111`); imports `Table`/`TableBody`/`TableCell`/
  `TableHead`/`TableHeader`/`TableRow` (`:12-19`), `Badge` (`:10`), `cn` (`:20`). The `SummaryRow`
  count to keep is `:219`. Mirror the **Alerts `<Table>`** (`:161-186`) for the new connector table.
- `packages/shared/src/projections.ts:59-68` — `ConnectorHealthRow` (VERIFIED fields):
  `sourceConnector: string`, `lastEventAt: string | null`, `eventCount: number`, `toolCalls: number`
  (completed+failed — the failure-ratio denominator), `toolsFailed: number`, `parserVersions: string[]`,
  `models: string[]`. Barrel-exported via `export * from "./projections.js"` (`index.ts:10`), and
  re-exported through `monitor.ts` on `LiveMonitorSnapshot.connectors` (`monitor.ts:64`).
- `apps/desktop/src/components/ui/table.tsx`, `.../badge.tsx` — the hand-written primitives (no new
  ones needed).

**Item 2 — admin-email nav (dashboard):**

- `apps/dashboard/src/components/app-nav.tsx` (whole file) — `"use client"` nav island. Currently
  "carries NO data and NO token." Returns `null` on `/login` (`:31`). Logout button at `:62-68` with
  `ml-auto`. The email span goes just before Logout; the client fetch guards on the same
  not-`/login` condition.
- `apps/dashboard/src/app/api/catalog/route.ts:14-18` — the exact GET-proxy pattern the new
  `/api/auth/me` route mirrors: `export const dynamic = "force-dynamic"` + `export async function
  GET() { return proxyJson("/v1/catalog"); }`.
- `apps/dashboard/src/lib/proxy.ts:23-48` — `proxyJson(path, init?)`: adds the admin bearer via
  `adminHeaders()` server-side, forwards upstream status on `!res.ok`, thrown hop → 502. Reused
  unchanged.
- `apps/ingest/src/routes/auth.ts:44-49` — `GET /v1/auth/me`: `adminAuthorized` gate → 401 or
  `{ email: app.adminEmail }` (single-admin; `app.adminEmail` from `ADMIN_EMAIL` env). No Fastify
  response schema — shape is inline `{ email: string }`.
- `apps/dashboard/src/middleware.ts:14-19` — allowlist: `pathname.startsWith("/api/auth/")` is
  public, so `/api/auth/me` is reachable (logged-out → forwarded 401; logged-in → cookie carried →
  200). VERIFIED no `/api/auth/me` route exists yet (only `login`, `logout`).
- `apps/dashboard/src/app/layout.tsx` — server component rendering `<AppNav />`. **Left untouched**
  (the client-fetch approach keeps the layout out of it).

### New Files to Create

- `apps/dashboard/src/app/api/auth/me/route.ts` — GET proxy to `/v1/auth/me` (one-liner mirror).

### Files to Update

- `apps/desktop/src/components/SyncHealth.tsx` — add a `ConnectorsTable` sub-component + render it in
  the `snapshot ? (...)` block; keep the count `<Stat>`.
- `apps/dashboard/src/components/app-nav.tsx` — client `useEffect` fetch of `/api/auth/me`; render
  the email span before Logout.
- `.agents/plans/m14-general-ai-chat-capture.md` — correct the 14.3 line: connectorHealth via the
  monitor snapshot (not `ConnectorInfo` widening); GUI unpair shipped in M11 Slice 4.

### Patterns to Follow

- **Proxy discipline** (`CLAUDE.md` "Frontend workspace"): browser → same-origin Route Handler →
  `proxyJson` adds the admin bearer server-side. Never a `NEXT_PUBLIC_*` token. The email is fetched
  through `/api/auth/me`, never by exposing the token.
- **Graceful degrade** (`SyncHealth.tsx:143-150`): the server section already degrades to an error
  line when the admin token is unset / ingest is down — the connector table lives inside the
  existing `snapshot ? (...)` branch, so it inherits that. The nav email fetch swallows a non-OK
  response (shows nothing rather than an error).
- **Relative time**: reuse `formatAgo(iso, nowMs)` already in `SyncHealth.tsx` — do NOT add a second
  time helper. `lastEventAt` is `string | null`; `formatAgo` already handles `null → "—"`.
- **No new long-lived resources**: the nav email is a one-shot `fetch` on mount (no interval/stream),
  and `AppNav` persists across client navigation (never unmounts), so the M9 teardown discipline
  isn't triggered. (An `AbortController` on unmount is optional cleanliness, not required.)

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom.

### 1. UPDATE `apps/desktop/src/components/SyncHealth.tsx` — connector health table

- **IMPLEMENT**: a `ConnectorsTable` sub-component (sibling of `SummaryRow`/`Stat`) taking
  `{ connectors, nowMs }: { connectors: ConnectorHealthRow[]; nowMs: number }`. Render:
  - Empty state: `connectors.length === 0` → `<p class="text-muted-foreground text-sm">No connector
    activity.</p>` (mirror the Alerts empty state at `:158-159`).
  - Else a `<Table>` mirroring the Alerts table (`:161-186`) with headers `Connector` /
    `Last event` / `Events` / `Tool failures`. Row `key={c.sourceConnector}`. Cells:
    - `c.sourceConnector` (font-medium).
    - `formatAgo(c.lastEventAt, nowMs)` (muted).
    - `c.eventCount` (tabular-nums).
    - failure ratio: `c.toolsFailed`/`c.toolCalls` shown as e.g. `2 / 40` (muted); when
      `c.toolCalls === 0` show `—`. Optionally wrap in a `Badge` with `SEVERITY_BADGE.critical`
      when `toolsFailed > 0`, else plain text (guard divide-by-zero — do the check on `toolCalls`,
      never compute `toolsFailed/toolCalls` for display without it).
- **IMPORTS**: add `ConnectorHealthRow` to the existing `import type { ... } from "@420ai/shared"`
  block (`:3-8`). All UI primitives (`Table*`, `Badge`, `cn`) are already imported.
- **WIRE IN**: inside the `snapshot ? ( <> ... </> )` branch (`:151-189`), after the Alerts `<div>`,
  add a `<div>` with an uppercase label `Connectors` (mirror `:155-157`) wrapping
  `<ConnectorsTable connectors={snapshot.connectors} nowMs={nowMs} />`. Keep the count `<Stat>` at
  `:219` unchanged.
- **GOTCHA**: `lastEventAt` is `string | null` — `formatAgo` already returns `"—"` for `null`; do
  not pre-guard. Do NOT re-coerce/re-format the ISO string (it is already ISO on the wire from the
  server projection — the `mode:"string"` aggregate normalization happened server-side in `db`).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0)

### 2. CREATE `apps/dashboard/src/app/api/auth/me/route.ts` — GET proxy

- **IMPLEMENT** (mirror `api/catalog/route.ts:14-18`):
  ```ts
  import { proxyJson } from "@/lib/proxy";

  /**
   * Admin identity probe (M14 14.3). GET → /v1/auth/me → { email }. The admin bearer (the
   * logged-in admin's session cookie) is added on the server→ingest hop only (D8); the browser
   * never holds the token. Reachable while logged out (middleware allows /api/auth/*) — ingest
   * returns 401 with no session, which the nav swallows.
   */
  export const dynamic = "force-dynamic";

  export async function GET() {
    return proxyJson("/v1/auth/me");
  }
  ```
- **GOTCHA**: no `NextRequest` param needed (GET has no body). Do NOT add auth logic here —
  `proxyJson`/`adminHeaders` handle the bearer; `middleware.ts` handles gating.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0)

### 3. UPDATE `apps/dashboard/src/components/app-nav.tsx` — show the email

- **IMPLEMENT**: add `import { useEffect, useState } from "react";`. Inside `AppNav`, after the
  `pathname` line, add `const [email, setEmail] = useState<string | null>(null);` and:
  ```ts
  useEffect(() => {
    if (pathname === "/login") return; // no probe on the standalone login surface
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { email?: string } | null) => {
        if (alive && d?.email) setEmail(d.email);
      })
      .catch(() => {}); // swallow — a missing email just isn't shown
    return () => {
      alive = false;
    };
  }, [pathname]);
  ```
  Render, immediately before the Logout `<button>` (which keeps its `ml-auto`), a muted email span
  shown only when present:
  ```tsx
  {email ? (
    <span className="text-muted-foreground ml-auto mr-3 font-mono text-xs" title={email}>
      {email}
    </span>
  ) : null}
  ```
  Then REMOVE `ml-auto` from the Logout button's className (the email span now owns the left
  auto-margin). If `email` is null, add `ml-auto` back to Logout so it still right-aligns — cleanest
  is: keep `ml-auto` on Logout and DROP it from the span (Logout stays right-anchored; the span sits
  just left of it). Pick the latter to avoid a layout regression when `email` is null.
- **GOTCHA**: the early `if (pathname === "/login") return null;` (`:31`) runs BEFORE hooks in the
  current code — moving a `useState`/`useEffect` after a conditional `return` violates the Rules of
  Hooks. Put BOTH hooks ABOVE the `if (pathname === "/login") return null;` guard, and guard the
  fetch body on `pathname` instead (as written above). VERIFY the `return null` stays after the hook
  declarations.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0) AND `npm run build:dashboard` (exit 0 —
  catches JSX/Rules-of-Hooks-adjacent build errors)

### 4. UPDATE the milestone doc

- **IMPLEMENT** in `.agents/plans/m14-general-ai-chat-capture.md` (slice 14.3 bullet, ~`:79-81`):
  note connectorHealth is surfaced via the **monitor snapshot** in `SyncHealth.tsx` (not
  `ConnectorInfo` widening — architecturally the sidecar has no DB), and that **GUI unpair already
  shipped in M11 Slice 4** (so it is not part of 14.3).
- **VALIDATE**: `npx prettier --check .agents/plans/m14-general-ai-chat-capture.md`

---

## TESTING STRATEGY

Both items are pure render / one-shot-fetch UI over already-verified data paths, and the two files
edited (`SyncHealth.tsx`, `app-nav.tsx`) have **no co-located tests today** (the desktop/dashboard
apps carry no jsdom/testing-library harness — adding one would be inventing infra, an anti-pattern
per `CLAUDE.md`). There is **no new extractable pure logic** (`formatAgo` already exists and is used
elsewhere). Therefore:

- **No new unit tests.** The enforcement is the type lanes + build + manual validation below.
- **Regression safety** comes from `typecheck:desktop` / `typecheck:dashboard` / `build:dashboard`
  (all in `repo-health`) and the full `vitest run` (proves nothing broke elsewhere).

If a reviewer insists on a testable unit, the only candidate is extracting the failure-ratio /
divide-by-zero formatting into a tiny pure helper in `SyncHealth.tsx` and testing it — optional, not
required for sign-off.

---

## VALIDATION COMMANDS (GATES — run from repo root)

1. **Level 1 — root typecheck**: `npm run typecheck` (exit 0). Both apps are OUT of this graph, so
   this only proves the 4 backend workspaces still compile (no regression from the shared-type import).
2. **Level 1b — frontend lanes**: `npm run typecheck:desktop` AND `npm run typecheck:dashboard` AND
   `npm run build:dashboard` (each exit 0). These are the ONLY enforcement for the edited files.
3. **Level 2 — unit**: `npm test` (all pass; no new tests, proves no regression).
4. **Level 3 — gate**: `npm run repo-health` (PASS — runs root typecheck [3/6], dashboard lane
   [4/6], desktop lane [5/6], vitest, hygiene scans). **Zero `@420ai/db`/`apps/ingest` diff**, so the
   `--require-db` int layer is untouched by this slice — but per `CLAUDE.md`, still run
   `npm run repo-health -- --require-db` before *milestone* sign-off (not required for this slice's
   commit).
5. **Lint + format** (CI-only, per memory — `repo-health` does NOT run these): `npm run lint` and
   `npx prettier --check` on the changed files.
6. **Level 4 — manual** (desktop needs `cargo tauri dev` + a paired stack; dashboard needs
   `npm run dashboard:dev` with `ADMIN_TOKEN`/`INGEST_URL`):
   - Desktop `Sync & Health` panel shows a per-connector table (connector id, last-event relative
     time, event count, tool-failure ratio); with ingest down it still degrades to the existing
     error line.
   - Dashboard nav shows the admin email next to Logout on any gated page; `grep -c "$ADMIN_TOKEN"`
     on the served `/monitor` HTML == 0 (token never in the browser).
   - Full desktop build (local Windows sign-off, needs Rust): `npm run build:desktop`.

---

## ACCEPTANCE CRITERIA

- [ ] Desktop `SyncHealth.tsx` renders a per-connector health table (last event via `formatAgo`,
      event count, tool-failure ratio with divide-by-zero guarded), keeping the summary count `<Stat>`.
- [ ] `/api/auth/me` proxy exists and returns ingest's `{ email }` (401 forwarded when logged out).
- [ ] Dashboard nav displays the admin email next to Logout; layout right-alignment unchanged when
      the email is absent.
- [ ] `ConnectorInfo`/`mapConnectorInfo`/the control protocol are UNCHANGED;
      `CONTROL_PROTOCOL_VERSION` is NOT bumped (Path B). No Rust diff.
- [ ] GUI unpair is NOT re-implemented (already shipped M11 Slice 4); milestone doc corrected.
- [ ] Admin token never in served HTML; the email goes through the same-origin proxy.
- [ ] All gates pass: root typecheck, `typecheck:desktop`, `typecheck:dashboard`, `build:dashboard`,
      `vitest`, `repo-health`, `lint`, `prettier --check`.

## COMPLETION CHECKLIST

- [ ] Tasks 1–4 done in order, each task's VALIDATE passed
- [ ] `npm run repo-health` PASS
- [ ] `npm run lint` + `npx prettier --check` on changed files clean
- [ ] Hooks declared before the `return null` guard in `app-nav.tsx` (Rules of Hooks)
- [ ] `git diff` touches only `apps/desktop`, `apps/dashboard`, and the milestone doc (no backend,
      no Rust, no `packages/`)

---

## NOTES

- **Spikes run during planning (evidence for the confidence score):**
  - Read `SyncHealth.tsx` end-to-end — confirmed `snapshot.connectors` is fetched and rendered only
    as a count (`:219`), `formatAgo` exists (`:36-47`), `nowMs` computed (`:111`), and all `Table`/
    `Badge`/`cn` primitives already imported (`:10-20`). The connector table adds **zero new imports**
    beyond the `ConnectorHealthRow` type.
  - Verified `ConnectorHealthRow` fields at source (`projections.ts:59-68`) and its barrel export
    (`index.ts:10` `export * from "./projections.js"`), reachable structurally via
    `LiveMonitorSnapshot.connectors` (`monitor.ts:64`).
  - Read `GET /v1/auth/me` at source (`auth.ts:44-49`) — confirmed it returns `{ email: app.adminEmail }`
    behind `adminAuthorized` (401 otherwise), single-admin, no Fastify schema.
  - Read `proxyJson` (`proxy.ts:23-48`) and the catalog GET route (`catalog/route.ts:14-18`) — the
    new route is a verified one-liner mirror; `dynamic = "force-dynamic"` belongs on the route file.
  - Verified `middleware.ts` allowlist (`startsWith("/api/auth/")`, `:19`) makes `/api/auth/me`
    reachable, and that NO `/api/auth/me` route exists yet (only `login`, `logout`).
  - Verified the validation lanes: `typecheck:desktop`/`typecheck:dashboard`/`build:dashboard` are
    real scripts (root `package.json:37-39`) and repo-health runs the desktop lane at `[5/6]` and the
    dashboard lane at `[4/6]` (`scripts/repo-health.mjs:117-146`). `build:desktop` needs cargo → local
    Windows sign-off, not a portable gate.
- **Scope guard (D-M14-3):** 14.3's *goal* (health in the desktop panel + admin-email in nav) is
  delivered; the doc's `ConnectorInfo`-widening *mechanism* is superseded by Path B (user-approved
  during planning), and GUI unpair is dropped as already-shipped. Machine/token revoke UI and
  editable settings stay in the deferral bucket.
- **Rules of Hooks** is the one real footgun (Task 3): the existing `if (pathname === "/login")
  return null;` must NOT sit above the new `useState`/`useEffect`. This is caught by
  `build:dashboard` (Next's React compiler) and `npm run lint` (`react-hooks/rules-of-hooks`), both
  in the gate.
- **Confidence: 9.5/10** — both items are additive frontend over data/endpoints verified at source,
  patterns copied 1:1 from adjacent in-file precedent (the Alerts `<Table>`; the catalog GET proxy;
  the logout client fetch). Residual risk is JSX/Rules-of-Hooks/`next build` quirks — every one
  caught by a gate command (`typecheck:desktop`, `build:dashboard`, `lint`). No DB, no wire, no Rust,
  no fingerprint proximity; the smallest possible blast radius (2 edits + 1 new one-liner + 1 doc).
