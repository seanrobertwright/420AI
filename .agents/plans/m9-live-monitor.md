# Feature: Milestone 9 — Live Monitor (collector heartbeat → real-time observability API → Next.js dashboard)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Pay special attention to naming of
existing utils, types, and models — import from the right files (`@420ai/shared`, `@420ai/db`, `.js`
relative specifiers, `import type` for type-only imports). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **Branch:** `m9-live-monitor` (user-named "M9 - Live monitor", normalized to a valid kebab ref to
> match `m7`/`m8-…`). Branch off **`main`** AFTER `fix-m8-provider-config-test` (`617a19c`) merges —
> that fix restores a green `tsc -b` (M8 merged red via PR #7; see "Baseline" below). PR targets `main`.
> M9 depends only on M6 projections + M3 collector + M2 ingest (all in `main`); it does **not** depend on
> M8's AI code, but coexists with it.

> **Baseline (verified by the spike).** As of this planning session `main` (with M8, PR #7) did **not**
> pass `npm run typecheck` — `apps/ingest/src/analysis/provider.test.ts` set `maxOutputTokens` on two
> `AnalysisProviderConfig` literals after M8's review (`5a5803f`) moved that field to `AnalysisRequest`
> (TS2353 ×2). The fix lives on `fix-m8-provider-config-test`. **Do not start M9 until that fix is on
> `main`.** If for any reason it is not, M9 Task 0 applies it (drop the two stale lines from
> `provider.test.ts`). The whole plan assumes a green-typecheck baseline.

> **Scope decisions confirmed with the user during planning (these bound the milestone — honor them):**
> 1. **Full vertical slice: backend data layer AND the first Next.js dashboard UI.** The user explicitly
>    wants a UI to test the app visually, built with **theGridCN**. This is the **first frontend in the
>    repo** — a new `apps/dashboard` workspace.
> 2. **Add the collector→server heartbeat plumbing** so sync backlog + true online/offline are visible
>    server-side (today the collector's queue depth never leaves the machine).
> 3. **Status/derived states only — NO alert engine.** M9 computes & exposes health states
>    (`online`/`stale`/`offline`, `backlogHigh`); the alert *evaluation + delivery* engine is **M10**
>    ("hardening: operational alerts", PRD §25).
> 4. **Real-time via SSE** (Server-Sent Events), not polling. The snapshot REST endpoint still exists for
>    initial load + a degraded-mode poll fallback.
> 5. **Dashboard → ingest auth = server-side proxy.** Next.js Route Handlers / Server Components hold
>    `ADMIN_TOKEN` from env and call the ingest API; **the browser never sees the token.** No new
>    dashboard auth, no schema change for auth.

> **A spike retired every novel risk before this plan was written.** Read
> [`docs/research/m9-dashboard-spike.md`](../../docs/research/m9-dashboard-spike.md) (run in a throwaway
> worktree) BEFORE implementing the dashboard. It proves: a Next 16 app coexists with the root `tsc -b` +
> `repo-health` (0 errors, PASS), theGridCN installs/renders (with one caveat), Fastify SSE works with a
> deterministic test, and the server-side proxy keeps the token off the client. Its paste-ready configs
> (dashboard `package.json`/`tsconfig`/`next.config.ts`/`components.json`, the SSE handler + test recipe,
> the Route Handler proxy) are the source of truth for the dashboard tasks — **prefer the spike doc over
> this plan if they ever differ on a config detail.**

---

## Feature Description

M6 built deterministic **projections** over the event log; M7 rendered them to durable **report
artifacts**; M8 added the **AI interpretation** pipeline. None of it is *observable in real time* and
none of it has a **UI** — every milestone so far is backend-only, and the durable queue's **sync backlog
never leaves the collector machine**.

M9 is the **Live Monitor** (PRD §8.4, §10.1.1, §20; CONTEXT *Live Monitor* — "a real-time observability
view over active Collectors, Connectors, AI Coding Tool sessions, sync health, token usage, costs,
failures, and anomalies"). It adds four genuinely new mechanics:

1. **A collector→server heartbeat** (`apps/collector` + `apps/ingest` + `@420ai/shared` + `@420ai/db`) —
   the collector periodically POSTs its **queue depth** + collector version to a new machine-authed
   `POST /v1/heartbeat`; the server persists it on `machines`. This is the only way server-side code can
   see "sync backlog growing" and tell an **idle-but-alive** collector from an **offline** one
   (`machines.lastSeenAt` only refreshes on activity, so it can't).

2. **Monitor projections + derived status** (`@420ai/db` + `@420ai/shared`) — `machineStatuses` +
   `activeSessions` read repos (clock-free, mirroring `connectorHealth`), and a **pure, clock-injected**
   status-derivation helper in `@420ai/shared` mapping heartbeat/recency → `online | stale | offline`
   plus a `backlogHigh` flag. Reuses the existing `connectorHealth` projection verbatim.

3. **The monitor API: a snapshot endpoint + an SSE stream** (`apps/ingest`) — admin-gated `GET /v1/monitor`
   (the composed `LiveMonitorSnapshot`, route owns the clock like `routes/reports.ts` owns `generatedAt`)
   and `GET /v1/monitor/stream` (SSE pushing a fresh snapshot every few seconds; `reply.hijack()` +
   disconnect cleanup, per the spike).

4. **The first Next.js dashboard** (`apps/dashboard`, new workspace) — a self-hosted Next 16 + shadcn +
   **theGridCN** app whose **Live Monitor page** renders machines/connectors/active-sessions from the
   snapshot and updates live over SSE, talking to ingest exclusively through **server-side proxy Route
   Handlers** that hold the admin token.

This implements PRD §8.4 (dashboard live monitor), §10.1.1 ("last event N seconds ago" per connector +
liveness labels), §20 (operational-alert *signals* — collector offline / connector failing / sync backlog
growing — **surfaced as states**, with delivery deferred to M10), and §9 (Next.js + shadcn/theGridCN, with
the documented plain-shadcn fallback). The `ConnectorHealthRow` shape literally carries the comment
*"no collector heartbeat (M9)"* (`packages/shared/src/projections.ts:59-62`) — M6 pre-marked this exact
addition.

### Why this milestone is **High** complexity (the largest since M1)

Every prior milestone thickened one proven backend layer. M9 opens a **new workspace** (the first
frontend), adds a **new transport** (SSE), and threads a **new collector→server signal** through
`shared → db (migration) → ingest → collector`. The spike retired the integration unknowns, but the
surface area is genuinely large and spans all five workspaces.

- **Backend (low risk — proven M6 patterns).** Heartbeat persistence, monitor projections, snapshot
  route, and status derivation are clones of `connectorHealth`/`routes/projections.ts`/`machines.ts`. The
  one migration is a few nullable columns on `machines`. SSE is the only new server idiom and the spike
  proved it.
- **Frontend (de-risked by the spike, but new to the repo).** No frontend test infra exists. The gate is
  the dashboard's own `tsc --noEmit` lane + `next build` (build catches theGridCN barrel breakage and type
  errors) + a Level-4 manual "open the page, watch it update". theGridCN is **adopt-selectively**:
  self-contained 2D widgets only, build-verify every add.

### Explicitly deferred — do NOT build in M9

- **The alert engine** (threshold config, evaluation, notification dispatch) — PRD §20 / §25 milestone 10.
  M9 emits *states and flags*; M10 turns them into delivered alerts. (Precedence rule D3.)
- **True "backlog GROWING" rate-of-change.** M9 stores only the **latest** heartbeat, so it shows current
  depth + a `backlogHigh` threshold flag. Detecting the *derivative* ("growing") needs heartbeat history
  and belongs to the M10 alert engine. (Precedence rule D4.)
- **`connector.health` as an emitted event.** Connector health stays a **read-time projection** over
  `events` (it already is — `connectorHealth`). Do NOT add a `connector.health` event type or change the
  collector's parsers. (The README taxonomy lists it; the `EventType` union deliberately omits it.)
- **A heartbeat history table / time-series**, **WebSockets**, **multi-user dashboard auth / login**,
  **archive-export UI** (M10), **the other dashboard surfaces** (reports/projects/search/catalog/settings
  pages — M9 ships ONLY the Live Monitor page + the minimal shell to host it), **theGridCN 3D/Three.js
  components**, **mobile/responsive polish** beyond "it renders".
- **Any change to the M2 ingest wire types / fingerprint / encryption / `IngestBatch`.** The heartbeat is
  an **additive new** wire type + endpoint; the existing ingest contract is untouched (CLAUDE.md invariant).

## User Story

As an AI-heavy developer running collectors that capture, queue, and sync my AI coding sessions,
I want a **live dashboard** that shows me, in real time, which collectors are online, how big each sync
backlog is, which connectors are fresh or failing, and which sessions are active right now,
So that I can *see* the system working (or not) at a glance — verify a collector is alive, catch a growing
backlog or a failing connector early, and finally have a visual surface to dogfood the whole product.

## Problem Statement

After M8 the archive is rich but **invisible**: there is no UI at all, and the one signal that matters
most for "is it working right now" — the collector's **sync backlog** — never leaves the machine
(`QueueStore.stats()` is local-only, `apps/collector/src/queue/queue-store.ts:191`). `machines.lastSeenAt`
only updates when the collector happens to call an endpoint, so an idle-but-healthy collector is
indistinguishable from a dead one. PRD §8.4/§20 require a real-time monitor of collectors, connectors,
sessions, and sync health; none of that is observable, and there is no dashboard to observe it from.

## Solution Statement

Add a **machine-authed heartbeat** (`POST /v1/heartbeat`) that the collector sends on a throttled cadence
from its existing sync loop, carrying `queue.stats()` + collector version, persisted to new nullable
`machines` columns (one migration). Add clock-free **monitor projections** (`machineStatuses`,
`activeSessions`) and a **pure, clock-injected status-derivation** helper in `@420ai/shared`, reusing
`connectorHealth`. Expose an admin-gated **`GET /v1/monitor`** snapshot (route owns the clock) and a
**`GET /v1/monitor/stream`** SSE endpoint (per the spike's `reply.hijack()` pattern, interval injectable
for deterministic tests). Build the first **`apps/dashboard`** (Next 16 + shadcn + theGridCN, per the
spike's verified configs) with a **Live Monitor page** that loads the snapshot and subscribes to SSE,
talking to ingest only through **server-side proxy Route Handlers** that hold `ADMIN_TOKEN` (token never
reaches the browser). The SSE interval is injected via `BuildAppOptions` so integration tests are
deterministic; the dashboard is kept **out of the root `tsc -b` graph** (like `*.int.test.ts`) with its
own enforced typecheck/build lane.

## Feature Metadata

**Feature Type**: New Capability (first real-time transport + first frontend; new collector→server signal).
**Estimated Complexity**: **High.** One migration; spans all five workspaces; new `apps/dashboard`
workspace; SSE. De-risked by a hands-on spike that proved every integration assumption.
**Primary Systems Affected**: `packages/shared` (new `monitor.ts` view types + status derivation; heartbeat
wire types in `ingest.ts`; barrel), `packages/db` (migration `0003_*` adding `machines` columns; new
`machineStatuses`/`activeSessions`/`recordHeartbeat` repos; barrel), `apps/ingest` (heartbeat route;
monitor snapshot + SSE routes; schema; `BuildAppOptions.monitorStreamIntervalMs`; `server.ts`; int tests),
`apps/collector` (heartbeat client + throttled sender in the sync loop; CLI wiring), **new
`apps/dashboard`** (Next.js + shadcn + theGridCN; Live Monitor page; proxy Route Handlers), `.env.example`,
`README.md`, root `package.json` + `scripts/repo-health.mjs` (add the enforced dashboard typecheck lane).
**Dependencies**: **new in `apps/dashboard` only** (Next 16.2.9, React 19.2.7, Tailwind 4.3.1,
`@tailwindcss/postcss`, shadcn CLI 4.11.0, radix-ui, lucide-react, clsx, cva, tailwind-merge,
tw-animate-css — exact pins from the spike). No new dependency in the existing four workspaces (Node ≥ 24
global `fetch`/`AbortController` only). SSE uses raw Fastify (existing `fastify@5.8.5`).

---

## PRE-FLIGHT VERIFICATION (grounded against the codebase + a hands-on spike)

Every structural half is **[VERIFIED]** against code (file:line) or the spike.

1. **`connectorHealth(db, userId)` already exists and is the projection template — [VERIFIED].**
   `packages/db/src/repositories/projections.ts:259-285` returns per-connector `lastEventAt` (max ts),
   `eventCount`, `toolsFailed`, `parserVersions`, `models`, scoped to the user via the **machines join**
   (`innerJoin(machines, eq(events.machineId, machines.id))`, `where(eq(machines.userId, userId))`) so
   UNATTRIBUTED events still count. It is **clock-free** (returns `lastEventAt`; "N seconds ago" computed
   by the consumer). `machineStatuses`/`activeSessions` mirror exactly this scoping + clock-free contract.

2. **The admin-gated read-route pattern is proven — [VERIFIED].** `apps/ingest/src/routes/projections.ts`
   (esp. `GET /v1/connectors/health` :89-96): `adminAuthorized(app, request)`→401 (`auth.ts`),
   `findUserIdByEmail(app.db, DEFAULT_EMAIL)`→ empty result if no user, else the projection. `GET /v1/monitor`
   clones this. `DEFAULT_EMAIL = "seanrobertwright@gmail.com"` is the single-user resolution already used
   here and in `routes/reports.ts`.

3. **Machine auth + `lastSeenAt` touch is the heartbeat seam — [VERIFIED].** `apps/ingest/src/plugins/auth.ts:31-42`:
   `app.authenticate` resolves a bearer token → `machineId`, sets `request.machineId`, and calls
   `touchLastSeen(app.db, machineId)`. `POST /v1/heartbeat` reuses `app.authenticate` as a preHandler
   (machine-authed, exactly like `POST /v1/ingest`), so `lastSeenAt` is already touched; the heartbeat
   handler additionally writes `lastHeartbeatAt` + backlog + version. `touchLastSeen`/`createMachine`/
   `getMachineUserId` live in `packages/db/src/repositories/machines.ts`; `machines` schema is
   `schema.ts:36-47` (has `lastSeenAt`, no heartbeat columns yet — M9 adds them).

4. **The queue exposes exactly the backlog signal — [VERIFIED].** `apps/collector/src/queue/queue-store.ts:191-201`
   `stats(): { pending: number; inflight: number }`. The collector sync loop `runSyncLoop`
   (`apps/collector/src/sync/sync-worker.ts:89-112`) already owns `deps.queue`, `deps.url`, `deps.token`
   and an abort-aware `delay`. The heartbeat sender adds a throttled call here; `postHeartbeat` clones
   `postIngest`/`postDiscover` (`apps/collector/src/ingest-client.ts:56-93`: `fetch` + bearer + `expectOk`,
   throwing `IngestHttpError`).

5. **Dependency injection + the error handler are the proven `buildApp` pattern — [VERIFIED].**
   `apps/ingest/src/app.ts:18-56` injects deps via `BuildAppOptions` + `app.decorate` and registers route
   plugins; M9 adds `monitorStreamIntervalMs?` the same way and registers `heartbeatRoutes` + `monitorRoutes`.
   `server.ts:44-52` builds real deps from env (ingest listens on `INGEST_PORT ?? 8420`). The
   `setErrorHandler` (`app.ts:59-79`) masks ≥500 — the snapshot route is a plain read (no new typed error
   needed); the **SSE route runs all auth/guards BEFORE `reply.hijack()`** because `hijack()` bypasses the
   error handler (spike residual-risk #1).

6. **The dashboard integration is PROVEN by the spike — [VERIFIED].** `docs/research/m9-dashboard-spike.md`:
   with `apps/dashboard` present, `npm run typecheck` = 0 errors, `npm run repo-health` = PASS,
   `npm run build -w @420ai/dashboard` = success. theGridCN `@thegridcn/data-card` builds; SSE has two
   working deterministic test recipes; the proxy keeps the token off the client (0 occurrences in browser
   HTML). Exact version pins + paste-ready configs are in the spike doc §2, §4.

7. **The int-test harness + `--require-db` gate are proven — [VERIFIED].** `apps/ingest/src/app.int.test.ts`
   builds the app in-process, TRUNCATEs per test, pairs+ingests+drives flows. M9 adds a **machines column
   migration** ⇒ the migration must be applied to the test DB (`npm run db:migrate`) and the int tests
   exercise heartbeat + monitor against a real DB. `repo-health --require-db`
   (`scripts/repo-health.mjs`) FAILS if any `*.int.test.ts` self-skipped (asserts `ran>0, skipped===0`).

**Residual risks (small, contained, each mitigated):**
- **(a) SSE wired into the *real* `buildApp` vs the standalone probe** — share the auth plugin (guards
  before hijack), the error handler (bypassed after hijack → wrap snapshot computation in try/catch and
  emit an SSE `event: error` then continue), and disconnect cleanup. Mitigation: an int test using the
  spike's recipe B (`listen({port:0})` + `fetch` ReadableStream) with a **50 ms injected interval**, plus
  a disconnect-cleanup assertion via `reader.cancel()`.
- **(b) theGridCN per-component breakage** (the `hud` barrel is broken as shipped — missing siblings).
  Mitigation: adopt only self-contained 2D widgets (`data-card` verified), **build-verify every add**, and
  keep the plain-shadcn fallback (PRD §9). `next build` in the gate catches any barrel breakage.
- **(c) Dashboard type errors are invisible to root `tsc -b`** (it's excluded by design). Mitigation: an
  **enforced** dashboard `tsc --noEmit` lane added to `repo-health.mjs` (D9) — not just a convention.
- **(d) `events.ts` is `mode:"string"`** — the `activeSessions` recency filter compares `max(ts)` to a
  bound ISO param cast `::timestamptz` in a **value comparison** (HAVING), which is safe; the bound-param
  hazard is only for GROUP BY/ORDER BY *expressions* (CLAUDE.md Drizzle gotcha), not value comparisons.
- **(e) Heartbeat best-effort vs ingest exactly-once** — a heartbeat send failure must **not** crash or
  stall the sync loop and must **not** be queued/retried (it's a liveness ping, not data). Catch + ignore.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `docs/research/m9-dashboard-spike.md` (whole file) — Why: the verified dashboard configs, version pins,
  SSE handler+test recipe, proxy pattern, theGridCN verdict, and the 7 must-encode gotchas. **Authoritative
  for all dashboard/SSE tasks.**
- `packages/db/src/repositories/projections.ts` (`connectorHealth` 259-285; `sessionAggregateColumns`
  158-176; the machines-join scoping) — Why: the exact projection style `machineStatuses`/`activeSessions`
  mirror — clock-free, user-scoped via `machines`, `::int` count casts, `array_agg ... filter`,
  `mode:"string"` timestamps returned as ISO strings.
- `apps/ingest/src/routes/projections.ts` (whole file, esp. 89-96) — Why: the admin-gated read-route
  template + `DEFAULT_EMAIL`/`findUserIdByEmail` single-user resolution `GET /v1/monitor` clones.
- `apps/ingest/src/plugins/auth.ts` (whole file) — Why: `app.authenticate` (machine bearer → `machineId`
  + `touchLastSeen`) is the heartbeat preHandler; `adminAuthorized` (from `auth.ts`) gates the monitor reads.
- `apps/ingest/src/auth.ts` (`adminAuthorized`, `isUuid`) — Why: reuse the guards. Do NOT reimplement.
- `apps/ingest/src/app.ts` (whole file, 18-82) — Why: add `monitorStreamIntervalMs?` to `BuildAppOptions`
  + `app.decorate`; register `heartbeatRoutes` + `monitorRoutes` (after `interpretationRoutes`). The SSE
  route does guards before `reply.hijack()`; no new error-handler branch needed for the plain reads.
- `apps/ingest/src/server.ts` (whole file) — Why: ingest listens on `INGEST_PORT ?? 8420` (the dashboard's
  `INGEST_URL` default is `http://localhost:8420`); wire `monitorStreamIntervalMs` from an optional env.
- `apps/ingest/src/schemas.ts` (whole file — `as const` JSON-schema style) — Why: `heartbeatBodySchema`.
- `apps/ingest/src/app.int.test.ts` (harness + the M6/M7/M8 round-trips) — Why: the int test to extend —
  pair a machine, POST a heartbeat, assert it persisted; GET `/v1/monitor` asserts the snapshot; SSE test
  via recipe B with a 50 ms injected interval; 401 without admin / without machine token.
- `apps/collector/src/sync/sync-worker.ts` (whole file) — Why: `runSyncLoop` is where the throttled
  heartbeat sender goes; mirror the injected-deps + abort-aware `delay` idiom; keep it best-effort.
- `apps/collector/src/ingest-client.ts` (whole file) — Why: `postHeartbeat` clones `postIngest`/`postDiscover`
  (fetch + bearer + `expectOk` → `IngestHttpError`).
- `apps/collector/src/queue/queue-store.ts` (`stats()` 191-201; `QueueStats` type) — Why: the backlog source.
- `apps/collector/src/cli.ts` — Why: the entrypoint that wires `runSyncLoop` (read argv, logger, version);
  the collector version comes from the collector `package.json` (read once at the entrypoint, passed in —
  libraries stay silent/pure).
- `packages/db/src/schema.ts` (`machines` 36-47) — Why: the table the migration extends; mirror the column
  style (`timestamp(..., { withTimezone: true })`, `integer`, `text`, all nullable).
- `packages/db/src/repositories/machines.ts` (whole file) — Why: add `recordHeartbeat` + `machineStatuses`
  beside `touchLastSeen`/`createMachine`; mirror the `db.update(machines).set(...).where(eq(...))` style.
- `packages/shared/src/projections.ts` (`ConnectorHealthRow` 59-67) — Why: the view-type style + the
  literal "no collector heartbeat (M9)" marker; `monitor.ts` types live beside these in the barrel.
- `packages/shared/src/ingest.ts` — Why: the wire-type home (`IngestBatch`, `PairRequest`, etc.); add
  `HeartbeatRequest`/`HeartbeatResponse` here (additive — existing types untouched).
- `packages/shared/src/index.ts` + `packages/db/src/index.ts` — Why: the barrels to extend (exact export
  lists above; `shared/index.ts:1-12`, `db/index.ts:44-63`).
- `scripts/repo-health.mjs` — Why: add the enforced dashboard `tsc --noEmit` lane (D9). Read its existing
  steps (typecheck, vitest, NUL scan, stray-artifact scan, `--require-db`) before adding one.

### New Files to Create

```
packages/shared/src/
  monitor.ts              # PURE view types + status derivation:
                          #   MachineStatusRow, ActiveSessionRow, LiveMonitorSnapshot,
                          #   MonitorStatus = "online"|"stale"|"offline",
                          #   MONITOR_THRESHOLDS, deriveMachineStatus(m, nowMs) -> MonitorStatus,
                          #   isBacklogHigh(pending), MONITOR_VERSION
  monitor.test.ts         # pure tests: each status boundary (online/stale/offline incl. no-heartbeat
                          #   fallback to lastSeenAt), backlogHigh threshold, clock injection, empty input
packages/db/src/repositories/
  monitor.ts              # machineStatuses(db, userId) -> MachineStatusRow[] (clock-free);
                          #   activeSessions(db, userId, sinceIso) -> ActiveSessionRow[] (clock-free)
  monitor.int.test.ts     # skipIf(!DATABASE_URL_TEST): ingest + heartbeat -> machineStatuses/activeSessions
                          #   return the persisted/derived rows against a real DB
apps/ingest/src/routes/
  heartbeat.ts            # POST /v1/heartbeat (machine-authed via app.authenticate) -> recordHeartbeat -> 200
  monitor.ts              # GET /v1/monitor (snapshot; admin-gated; route owns the clock) +
                          #   GET /v1/monitor/stream (SSE; admin-gated; reply.hijack; injected interval)
apps/collector/src/
  heartbeat.ts            # maybeSendHeartbeat(deps, state, now): throttle decision + best-effort send
                          #   (pure-ish; unit-tested); postHeartbeat added to ingest-client.ts
  heartbeat.test.ts       # cadence/throttle + best-effort-on-failure (stubbed post) unit tests
apps/dashboard/           # NEW WORKSPACE — scaffold per spike §4 (paste-ready). Minimum set:
  package.json, tsconfig.json, next.config.ts, postcss.config.mjs, components.json, .gitignore
  src/app/layout.tsx, src/app/globals.css, src/app/page.tsx (redirect to /monitor)
  src/app/monitor/page.tsx          # server component: initial snapshot (server-side fetch) + <LiveMonitor/>
  src/components/live-monitor.tsx    # "use client": EventSource(/api/monitor/stream) -> live state
  src/components/monitor/*.tsx       # machine / connector / active-session cards+tables (shadcn + theGridCN)
  src/app/api/monitor/route.ts       # snapshot JSON proxy (force-dynamic; ADMIN_TOKEN; try/catch -> 502)
  src/app/api/monitor/stream/route.ts# SSE pass-through proxy (force-dynamic; streams upstream body)
  src/lib/ingest.ts                  # server-only helper: ingestUrl()/adminHeaders() from env
  src/lib/utils.ts                   # shadcn cn() (added by shadcn init)
  src/components/ui/*.tsx            # shadcn primitives (card, table, badge) added by the CLI
```

### Files to MODIFY

```
packages/shared/src/ingest.ts    # ADD HeartbeatRequest/HeartbeatResponse (existing wire types untouched)
packages/shared/src/index.ts     # export ./monitor.js (ingest.js already exported)
packages/db/src/schema.ts        # ADD nullable machines columns: last_heartbeat_at, queue_pending,
                                 #   queue_inflight, collector_version
packages/db/src/repositories/machines.ts  # ADD recordHeartbeat(db, machineId, {pending,inflight,version,now})
packages/db/src/index.ts         # export machineStatuses, activeSessions, recordHeartbeat (+ types)
apps/ingest/src/app.ts           # BuildAppOptions.monitorStreamIntervalMs; decorate; register heartbeat+monitor
apps/ingest/src/server.ts        # read MONITOR_STREAM_INTERVAL_MS (optional) -> buildApp
apps/ingest/src/schemas.ts       # heartbeatBodySchema
apps/ingest/src/ingest-client...  # (collector) postHeartbeat in apps/collector/src/ingest-client.ts
apps/collector/src/sync/sync-worker.ts  # call maybeSendHeartbeat in runSyncLoop (throttled, best-effort)
apps/collector/src/cli.ts        # pass collector version + heartbeat cadence/clock into the sync loop
.env.example                     # INGEST_URL (dashboard->ingest), MONITOR_STREAM_INTERVAL_MS,
                                 #   HEARTBEAT_INTERVAL_MS (collector); note ADMIN_TOKEN reused by dashboard
README.md                        # bump Status; brief M9 note (no convention re-paste)
package.json (root)              # scripts: "typecheck:dashboard", "build:dashboard"
scripts/repo-health.mjs          # run the dashboard tsc --noEmit lane (enforced; D9)
```

> **M9 DOES add a migration** (`packages/db/drizzle/0003_*`), unlike M8. Run `npm run db:generate` after
> editing `schema.ts`, review the SQL (must be only `ALTER TABLE machines ADD COLUMN … ` nullable, no
> data loss), commit it, and `npm run db:migrate` against the test DB before the int tests.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/research/m9-dashboard-spike.md` — the authoritative dashboard/SSE/proxy reference (above).
- `docs/PRD.md` §8.4 (dashboard live monitor surface), §10.1.1 (**liveness levels + "last event N seconds
  ago" must be displayed**; never fake real-time), §20 (operational alert signals — collector offline /
  connector failing / sync backlog growing; M9 = states, M10 = delivery), §9 (Next.js + shadcn/**theGridCN**
  with **plain-shadcn fallback**), §13.3 (cost-confidence labels if shown).
- `docs/CONTEXT.md` — name code after: **Live Monitor**, **Operational Alert** (states only here),
  **Connector Fidelity** / **Connector** (real-time support level), **Machine**, **Local Durable Queue**
  (the backlog), **Background Collector**.
- `.agents/system-reviews/m4-m6-review.md` — Why: the recurring lessons this plan must not relearn — the
  **conditional-gate / silent-skip** trap (now extended to the dashboard lane, D9), the
  **precedence-rule** discipline (state which instruction wins — D3/D4/D6/D9 below), the Drizzle
  `mode:"string"`/bound-param gotchas.
- `.agents/plans/m6-event-projections.md` + `.agents/plans/m8-ai-interpretation.md` — Why: the projection
  + `BuildAppOptions` injection + admin-route patterns M9 reuses; the "thread the anchor types end-to-end"
  discipline.
- theGridCN: <https://thegridcn.com/docs/install> (registry `@thegridcn` → `https://thegridcn.com/r/{name}.json`);
  Next.js App Router Route Handlers <https://nextjs.org/docs/app/building-your-application/routing/route-handlers>;
  EventSource MDN <https://developer.mozilla.org/en-US/docs/Web/API/EventSource>; Fastify reply.hijack
  <https://fastify.dev/docs/latest/Reference/Reply/#hijack>.

### Patterns to Follow

**Heartbeat wire types (additive; `@420ai/shared/ingest.ts` — existing types untouched):**
```ts
/** Collector liveness ping (M9). Additive to the M2 wire contract; IngestBatch is unchanged. */
export interface HeartbeatRequest {
  queuePending: number;     // QueueStore.stats().pending
  queueInflight: number;    // QueueStore.stats().inflight
  collectorVersion: string; // from the collector package.json, read at the entrypoint
}
export interface HeartbeatResponse { ok: true }
```

**Status derivation (PURE + clock-injected; `@420ai/shared/monitor.ts` — mirror the dependency-free,
no-`new Date()` shared style):**
```ts
export type MonitorStatus = "online" | "stale" | "offline";
export const MONITOR_VERSION = "m9-monitor-v1";
/** Tuned to the default 30 s heartbeat cadence (HEARTBEAT_INTERVAL_MS). */
export const MONITOR_THRESHOLDS = {
  staleMs: 90_000,        // > 3× cadence with no heartbeat -> stale (amber)
  offlineMs: 300_000,     // > 5 min -> offline (red)
  backlogHigh: 100,       // queuePending above this -> backlogHigh flag
} as const;

export interface MachineStatusRow {
  id: string; name: string; os: string | null; hostname: string | null;
  lastSeenAt: string | null; lastHeartbeatAt: string | null;
  queuePending: number | null; queueInflight: number | null; collectorVersion: string | null;
}
export interface ActiveSessionRow {
  sessionId: string; sourceConnector: string;
  startedAt: string | null; lastEventAt: string | null;
  eventCount: number; models: string[]; projectPath: string | null; gitBranch: string | null;
}
export interface LiveMonitorSnapshot {
  generatedAt: string;                 // route-owned clock
  machines: (MachineStatusRow & { status: MonitorStatus; backlogHigh: boolean })[];
  connectors: ConnectorHealthRow[];    // reused verbatim from projections.ts
  activeSessions: ActiveSessionRow[];
}

/** now is injected (ms epoch) so this is deterministic + testable (CLAUDE.md). */
export function deriveMachineStatus(
  m: Pick<MachineStatusRow, "lastHeartbeatAt" | "lastSeenAt">, nowMs: number,
): MonitorStatus {
  // Prefer the dedicated heartbeat signal; fall back to lastSeenAt for pre-M9 machines
  // that have never sent one. (Precedence D5.)
  const ref = m.lastHeartbeatAt ?? m.lastSeenAt;
  if (!ref) return "offline";
  const age = nowMs - Date.parse(ref);
  if (age > MONITOR_THRESHOLDS.offlineMs) return "offline";
  if (age > MONITOR_THRESHOLDS.staleMs) return "stale";
  return "online";
}
export const isBacklogHigh = (pending: number | null): boolean =>
  (pending ?? 0) > MONITOR_THRESHOLDS.backlogHigh;
```
> `monitor.ts` imports `ConnectorHealthRow` from `./projections.js` (type-only). It is pure: no I/O, no
> `new Date()` (the caller passes `nowMs`). Findings/derivation are deterministic + unit-tested at the
> boundaries.

**Monitor projections (clock-free; mirror `connectorHealth` scoping + the `mode:"string"` ISO contract):**
```ts
// packages/db/src/repositories/monitor.ts (illustrative)
export async function machineStatuses(db: DbClient, userId: string): Promise<MachineStatusRow[]> {
  return db.select({
    id: machines.id, name: machines.name, os: machines.os, hostname: machines.hostname,
    lastSeenAt: machines.lastSeenAt, lastHeartbeatAt: machines.lastHeartbeatAt,
    queuePending: machines.queuePending, queueInflight: machines.queueInflight,
    collectorVersion: machines.collectorVersion,
  }).from(machines).where(eq(machines.userId, userId)).orderBy(machines.name);
  // NOTE: timestamptz columns come back as JS Date via the driver here (these are NOT mode:"string");
  // normalize to ISO in the mapping (.toISOString()) so the wire shape matches MachineStatusRow (string).
}

export async function activeSessions(
  db: DbClient, userId: string, sinceIso: string,
): Promise<ActiveSessionRow[]> {
  const rows = await db.select({
    sessionId: events.sessionId,
    sourceConnector: sql<string>`max(${events.sourceConnector})`,
    startedAt: sql<string | null>`min(${events.ts})`,
    lastEventAt: sql<string | null>`max(${events.ts})`,
    eventCount: sql<number>`count(${events.fingerprint})::int`,
    models: sql<string[]>`coalesce(array_agg(distinct ${events.model}) filter (where ${events.model} is not null), '{}')`,
    projectPath: sql<string | null>`max(${events.projectPath})`,
    gitBranch: sql<string | null>`max(${events.gitBranch})`,
  })
    .from(events)
    .innerJoin(machines, eq(events.machineId, machines.id))
    .where(eq(machines.userId, userId))
    .groupBy(events.sessionId)
    // value comparison (NOT a GROUP BY expression) — a bound ISO param cast ::timestamptz is safe.
    .having(sql`max(${events.ts}) >= ${sinceIso}::timestamptz`)
    .orderBy(sql`max(${events.ts}) desc`);
  return rows.map((r) => ({ ...r, models: r.models ?? [] }));
}
```
> GOTCHAs: (1) `machines.*Seen/Heartbeat` are plain `timestamp(..,{withTimezone:true})` (driver → Date) —
> `.toISOString()` them; `events.ts` is `mode:"string"` (already ISO — do NOT re-coerce). (2) Scope via
> the `machines` join exactly like `connectorHealth` (unattributed events still count). (3) The `since`
> window is passed in as ISO by the route — the projection stays clock-free.

**`recordHeartbeat` (beside `touchLastSeen`; `db.update` style):**
```ts
// packages/db/src/repositories/machines.ts (illustrative)
export async function recordHeartbeat(
  db: DbClient, machineId: string,
  hb: { queuePending: number; queueInflight: number; collectorVersion: string; now?: Date },
): Promise<void> {
  await db.update(machines).set({
    lastHeartbeatAt: hb.now ?? new Date(),
    queuePending: hb.queuePending, queueInflight: hb.queueInflight,
    collectorVersion: hb.collectorVersion,
  }).where(eq(machines.id, machineId));
}
```

**Heartbeat route (machine-authed; mirror `routes/ingest.ts` preHandler wiring):**
```ts
// apps/ingest/src/routes/heartbeat.ts (illustrative)
app.post<{ Body: HeartbeatRequest }>("/v1/heartbeat",
  { preHandler: app.authenticate, schema: { body: heartbeatBodySchema } },
  async (request, reply) => {
    await recordHeartbeat(app.db, request.machineId, {
      queuePending: request.body.queuePending,
      queueInflight: request.body.queueInflight,
      collectorVersion: request.body.collectorVersion,
    });
    return reply.code(200).send({ ok: true } satisfies HeartbeatResponse);
  });
```
> `app.authenticate` already 401s a missing/invalid token and `touchLastSeen`s — do NOT re-auth. The body
> schema (`schemas.ts`, `as const`) makes a malformed body a 400 before the handler.

**Snapshot route (admin-gated; route OWNS the clock — like `routes/reports.ts` `generatedAt`):**
```ts
// apps/ingest/src/routes/monitor.ts (illustrative)
app.get("/v1/monitor", async (request, reply) => {
  if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
  const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
  if (!userId) return reply.code(200).send(emptySnapshot(new Date().toISOString()));
  return reply.code(200).send(await buildSnapshot(app.db, userId, new Date()));  // see buildSnapshot below
});
// buildSnapshot(db, userId, now): compose machineStatuses + connectorHealth + activeSessions(now - ACTIVE_WINDOW),
//   apply deriveMachineStatus(m, now.getTime()) + isBacklogHigh per machine. ACTIVE_WINDOW default 15 min.
//   Pure composition over the repos; the ONLY clock read is `now` passed from the route.
```

**SSE stream route (admin-gated; guards BEFORE hijack; interval injected for tests — spike §6):**
```ts
// apps/ingest/src/routes/monitor.ts (illustrative)
app.get("/v1/monitor/stream", async (request, reply) => {
  if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
  const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
  });
  reply.hijack();                                   // AFTER all guards — hijack bypasses the error handler
  const push = async () => {
    try {
      const snap = userId ? await buildSnapshot(app.db, userId, new Date()) : emptySnapshot(new Date().toISOString());
      reply.raw.write(`data: ${JSON.stringify(snap)}\n\n`);
    } catch (err) {                                 // error handler is bypassed post-hijack — emit + continue
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "snapshot failed" })}\n\n`);
      request.log.error(err);
    }
  };
  await push();                                     // initial snapshot immediately
  const timer = setInterval(push, app.monitorStreamIntervalMs); // injected; default 3000, tests 50
  request.raw.on("close", () => clearInterval(timer));          // LOAD-BEARING: stop on disconnect
});
```
> Per the spike: `reply.hijack()` is required so Fastify won't also serialize a body; each event is
> `data: <json>\n\n`; clear the interval on `request.raw.on("close")`. `app.monitorStreamIntervalMs` is
> decorated from `BuildAppOptions.monitorStreamIntervalMs ?? 3000` so the int test sets 50 ms.

**Collector heartbeat sender (best-effort; throttled; clock-injected; in `runSyncLoop`):**
```ts
// apps/collector/src/heartbeat.ts (illustrative)
export interface HeartbeatState { lastSentMs: number }
export async function maybeSendHeartbeat(
  deps: { url: string; token: string; queue: QueueStore; collectorVersion: string;
          intervalMs: number; post?: typeof postHeartbeat; now: () => Date },
  state: HeartbeatState,
): Promise<void> {
  const nowMs = deps.now().getTime();
  if (nowMs - state.lastSentMs < deps.intervalMs) return;     // throttle to the cadence
  state.lastSentMs = nowMs;
  const { pending, inflight } = deps.queue.stats();
  try {
    await (deps.post ?? postHeartbeat)(deps.url, deps.token,
      { queuePending: pending, queueInflight: inflight, collectorVersion: deps.collectorVersion });
  } catch { /* best-effort liveness ping — never crash/stall/queue the loop (residual risk e) */ }
}
// postHeartbeat in ingest-client.ts clones postIngest: fetch POST /v1/heartbeat + bearer + expectOk.
// runSyncLoop: construct one HeartbeatState; call maybeSendHeartbeat(...) once per loop iteration
//   (the existing ~2 s idle cadence makes the 30 s throttle exact enough). Inject now + intervalMs +
//   collectorVersion via SyncLoopDeps; cli.ts reads the version from the collector package.json.
```

**Dashboard — server-side proxy Route Handlers (spike §7; token never in browser):**
```ts
// apps/dashboard/src/app/api/monitor/route.ts — snapshot JSON proxy
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const res = await fetch(`${ingestUrl()}/v1/monitor`, { headers: adminHeaders(), cache: "no-store" });
    if (!res.ok) return NextResponse.json({ error: "ingest error", status: res.status }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch { return NextResponse.json({ error: "ingest unreachable" }, { status: 502 }); }
}
// apps/dashboard/src/app/api/monitor/stream/route.ts — SSE pass-through (STREAM the upstream body)
export const dynamic = "force-dynamic";
export async function GET() {
  let upstream: Response;
  try { upstream = await fetch(`${ingestUrl()}/v1/monitor/stream`, { headers: adminHeaders(), cache: "no-store" }); }
  catch { return new Response("ingest unreachable", { status: 502 }); }
  if (!upstream.ok || !upstream.body) return new Response("ingest error", { status: 502 });
  return new Response(upstream.body, {                       // pipe the stream through unchanged
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
// src/lib/ingest.ts (server-only): ingestUrl() = process.env.INGEST_URL ?? "http://localhost:8420";
//   adminHeaders() = { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ""}` }.  NEVER a NEXT_PUBLIC_* var.
```
> The browser does `new EventSource("/api/monitor/stream")` (same-origin, no auth header needed); the
> Next server adds the bearer on the server→ingest hop and streams the upstream `ReadableStream` straight
> through. `force-dynamic` + try/catch→502 per spike gotchas #5.

**Dashboard config** — copy the spike's paste-ready `package.json`, `tsconfig.json` (standalone, **not**
referenced by root tsconfig), `next.config.ts` (`turbopack.root` → repo root; `transpilePackages:
["@420ai/shared"]`), `postcss.config.mjs`, `globals.css`, `components.json` (with the `@thegridcn`
registry). Import shared types with `import type { ConnectorHealthRow, LiveMonitorSnapshot } from
"@420ai/shared"`.

**Library files never log / `process.exit`** (CLAUDE.md): `monitor.ts` (shared + db), `heartbeat.ts`
(collector lib), `recordHeartbeat`, and the route handlers stay silent (throw typed errors / write SSE);
only `cli.ts`/`server.ts` log + read argv/env. The collector heartbeat sender swallows its own errors
(best-effort) rather than logging from a library.

> **Spike-snippet fidelity:** the dashboard/SSE/proxy snippets above must agree with
> `docs/research/m9-dashboard-spike.md` (the SSE handler §6, the proxy §7, the configs §4). If a detail
> differs, the **spike doc wins** — it is the executed, verified artifact.

---

## KEY DESIGN DECISIONS (read before coding)

### D1 — Heartbeat is an additive wire type + endpoint; the M2 contract is untouched
`HeartbeatRequest`/`HeartbeatResponse` are **new** types; `IngestBatch` and the existing routes are
unchanged. `POST /v1/heartbeat` is machine-authed via the existing `app.authenticate` (which already
`touchLastSeen`s). This respects the CLAUDE.md "M2 ingest wire types are load-bearing" invariant —
adding a sibling endpoint is not changing the contract.

### D2 — One migration: nullable columns on `machines` (no new table)
`0003_*` adds `last_heartbeat_at timestamptz`, `queue_pending integer`, `queue_inflight integer`,
`collector_version text` — all **nullable** (pre-M9 machines simply have nulls; `deriveMachineStatus`
falls back to `lastSeenAt`). No heartbeat-history table (current depth is enough for M9; trend → M10).
Run `db:generate`, review the SQL is additive-only, `db:migrate` the test DB before int tests.

### D3 — States only; the alert ENGINE is M10 (precedence over PRD §20 "alerts")
PRD §20 lists operational alerts and §25 milestone 10 owns "operational alerts". **M9 computes and
exposes** `status` (`online`/`stale`/`offline`), `backlogHigh`, and `toolsFailed` (already in
`connectorHealth`) so the UI can color them. **M9 does NOT** evaluate thresholds into alert records or
deliver notifications — that is M10. When in doubt: surface a state, do not dispatch an alert.

### D4 — Show current backlog + `backlogHigh`; "backlog GROWING" (derivative) is M10
M9 stores only the **latest** heartbeat, so it shows `queuePending`/`queueInflight` + a threshold flag.
True rate-of-change ("growing") needs heartbeat history and is part of the M10 alert engine. State this
in the route/snapshot comments so no one tries to compute a trend from a single sample.

### D5 — Machine liveness is heartbeat-first, `lastSeenAt`-fallback (precedence)
`lastSeenAt` updates on ANY authenticated request, so it cannot distinguish idle-but-alive from offline.
`deriveMachineStatus` therefore keys off `lastHeartbeatAt` and only falls back to `lastSeenAt` when a
machine has never sent a heartbeat (pre-M9 / just-paired). Document this so the two timestamps are not
conflated.

### D6 — Clock-free projections + a route-owned clock + an injected SSE interval (precedence: "mirror
`connectorHealth`" vs "the monitor is real-time")
`machineStatuses`/`activeSessions` are **clock-free** (the route passes `now`/`sinceIso`), exactly like
`connectorHealth`. The **route** owns the wall clock (`new Date()` for `generatedAt` and the active
window), like `routes/reports.ts` owns `generatedAt`. The **SSE interval** is injected via
`BuildAppOptions.monitorStreamIntervalMs` (default 3000; tests 50) so streaming tests are deterministic.
Real-time is the *transport*; honesty is the *labels* (`lastEventAt` → "N s ago", never faked — PRD §10.1.1).

### D7 — SSE: all guards BEFORE `reply.hijack()`; errors after hijack are emitted, not thrown
`reply.hijack()` removes the response from Fastify's lifecycle, so the global `setErrorHandler` no longer
applies. Therefore: do auth + user resolution + write the 200 head **before** hijack; **after** hijack,
wrap each snapshot build in try/catch and emit an SSE `event: error` frame (the connection stays open and
recovers on the next tick). Always `clearInterval` on `request.raw.on("close")`.

### D8 — Dashboard talks to ingest ONLY through server-side proxy Route Handlers
The browser never holds `ADMIN_TOKEN`. Route Handlers (`/api/monitor`, `/api/monitor/stream`) and Server
Components read `process.env.ADMIN_TOKEN`/`INGEST_URL` and call ingest; the SSE handler streams the
upstream body through. `force-dynamic` + try/catch→502 (a refused upstream throws, it does not return
`!res.ok`). Never expose the token via `NEXT_PUBLIC_*`.

### D9 — The dashboard is OUT of the root `tsc -b` graph and gets its OWN ENFORCED lane
The dashboard needs `moduleResolution: bundler` + `jsx`, incompatible with the root NodeNext/composite
graph, so its `tsconfig.json` is **not referenced** by the root `tsconfig.json` (mirrors how
`*.int.test.ts` are excluded). Consequence: **root `tsc -b` will NEVER catch dashboard type errors.** To
avoid the system-review "silent-skip" trap, add `typecheck:dashboard` (`tsc --noEmit -w @420ai/dashboard`)
to `scripts/repo-health.mjs` as an **enforced** step, and `build:dashboard` to the milestone sign-off +
Level-4 (build catches theGridCN barrel breakage). A convention is not enough — wire it into the gate.

### D10 — theGridCN: adopt selectively, build-verify every add, keep the shadcn fallback (PRD §9)
Use theGridCN for **self-contained 2D widgets** (`@thegridcn/data-card` is verified to build); compose
machine/connector/session lists from plain shadcn `card`/`table`/`badge` where a theGridCN equivalent is a
barrel. **Build-verify every `npx shadcn add @thegridcn/<x>`** before committing (the `hud` barrel ships
broken — missing sibling modules — and fails `next build`). Never pull the 3D/Three.js components.

### D11 — `MONITOR_VERSION` stamps the snapshot shape (PRD §23 spirit)
The snapshot carries `MONITOR_VERSION` (in `metrics`/a field) so a future dashboard can detect a
shape/derivation change, consistent with the repo's version-stamping discipline (`REPORT_VERSION`,
`AI_REPORT_VERSION`).

---

## IMPLEMENTATION PLAN

### Phase 1: Shared contracts (pure, dependency-free)
Heartbeat wire types + monitor view types + status derivation in `@420ai/shared`; barrel exports. Pure,
unit-tested, zero infra. Establishes the vocabulary every later layer imports.

### Phase 2: DB layer (migration + repos)
Add nullable `machines` columns + `0003_*` migration; `recordHeartbeat`; `machineStatuses`/`activeSessions`
projections; barrel. Int-tested against a real DB.

### Phase 3: Ingest API (heartbeat + monitor + SSE)
`heartbeatBodySchema`; `POST /v1/heartbeat`; `GET /v1/monitor`; `GET /v1/monitor/stream`;
`BuildAppOptions.monitorStreamIntervalMs`; `server.ts` env; route registration. Int-tested (incl. SSE).

### Phase 4: Collector (heartbeat sender)
`postHeartbeat` client; `maybeSendHeartbeat` (throttled, best-effort, clock-injected); wire into
`runSyncLoop`; `cli.ts` passes version + cadence. Unit-tested; covered by the push integration test.

### Phase 5: Dashboard (new workspace + Live Monitor page)
Scaffold `apps/dashboard` per the spike; proxy Route Handlers; the Live Monitor page + client SSE
component + shadcn/theGridCN cards/tables; root scripts + the enforced repo-health lane.

### Phase 6: Validation & docs
`db:up`/`db:migrate`; `repo-health --require-db`; `build:dashboard`; Level-4 manual end-to-end; `.env.example`
+ `README` status.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently validatable.

### Task 0 — CONFIRM a green baseline
- **VALIDATE**: `git checkout main && git pull && npm ci && npm run typecheck` → exit 0. If it FAILS with
  the `provider.test.ts` TS2353, ensure `fix-m8-provider-config-test` is merged first (or apply it). Then
  `git checkout -b m9-live-monitor`.

### Task 1 — ADD heartbeat wire types (`packages/shared/src/ingest.ts`)
- **IMPLEMENT**: `HeartbeatRequest` + `HeartbeatResponse` (above). Do not touch existing types.
- **VALIDATE**: `npx tsc -b packages/shared` → 0 errors.

### Task 2 — CREATE `packages/shared/src/monitor.ts` + `monitor.test.ts`
- **IMPLEMENT**: `MonitorStatus`, `MONITOR_VERSION`, `MONITOR_THRESHOLDS`, `MachineStatusRow`,
  `ActiveSessionRow`, `LiveMonitorSnapshot`, `deriveMachineStatus(m, nowMs)`, `isBacklogHigh`. Pure;
  `import type { ConnectorHealthRow } from "./projections.js"`.
- **PATTERN**: `packages/shared/src/projections.ts` (view-type style) + the no-`new Date()` shared rule.
- **TEST**: each status boundary (online/stale/offline), no-heartbeat→lastSeenAt fallback, neither→offline,
  `backlogHigh` threshold, clock injection determinism.
- **VALIDATE**: `npx vitest run packages/shared/src/monitor.test.ts` → green.

### Task 3 — UPDATE `packages/shared/src/index.ts`
- **IMPLEMENT**: `export * from "./monitor.js";` (`ingest.js` already exported).
- **VALIDATE**: `npm run typecheck` → 0 errors.

### Task 4 — ADD `machines` columns + migration (`packages/db/src/schema.ts`)
- **IMPLEMENT**: `lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })`,
  `queuePending: integer("queue_pending")`, `queueInflight: integer("queue_inflight")`,
  `collectorVersion: text("collector_version")` — all nullable.
- **GOTCHA**: nullable only; no default-now (heartbeat sets them). `import { integer }` if not present.
- **VALIDATE**: `npm run db:generate` → review `drizzle/0003_*.sql` is **only** `ALTER TABLE machines ADD
  COLUMN …`; commit it.

### Task 5 — ADD `recordHeartbeat` (`packages/db/src/repositories/machines.ts`)
- **IMPLEMENT**: the `db.update(machines).set({...}).where(eq(machines.id, machineId))` above; `now?` injectable.
- **VALIDATE**: `npx tsc -b packages/db` → 0 errors.

### Task 6 — CREATE `packages/db/src/repositories/monitor.ts` + `monitor.int.test.ts`
- **IMPLEMENT**: `machineStatuses(db, userId)` (normalize Date→ISO) + `activeSessions(db, userId, sinceIso)`
  (clock-free; machines-join scoping; `having max(ts) >= sinceIso::timestamptz`).
- **PATTERN**: `connectorHealth` (`projections.ts:259`) for scoping; `sessionAggregateColumns` for the
  aggregate columns.
- **TEST (int, skipIf)**: ingest a session (sets events + machine), `recordHeartbeat`, assert
  `machineStatuses` returns the persisted backlog/version, and `activeSessions(now-15m)` includes the just-
  ingested session but a stale `sinceIso` excludes it. Hand-compute expected values (numbers are the contract).
- **VALIDATE**: with DB up: `npx vitest run packages/db/src/repositories/monitor.int.test.ts` → green, not skipped.

### Task 7 — UPDATE `packages/db/src/index.ts`
- **IMPLEMENT**: export `machineStatuses`, `activeSessions`, `recordHeartbeat` (+ no new types needed; view
  types come from `@420ai/shared`).
- **VALIDATE**: `npm run typecheck` → 0 errors.

### Task 8 — ADD `heartbeatBodySchema` (`apps/ingest/src/schemas.ts`)
- **IMPLEMENT**: `as const` object requiring `queuePending`/`queueInflight` (integer, min 0) +
  `collectorVersion` (string, minLength 1); `additionalProperties: false`.
- **VALIDATE**: `npx tsc -b apps/ingest` → 0 errors.

### Task 9 — CREATE `apps/ingest/src/routes/heartbeat.ts`
- **IMPLEMENT**: `POST /v1/heartbeat` with `preHandler: app.authenticate` + `schema.body` → `recordHeartbeat`
  → `{ ok: true }`.
- **PATTERN**: `routes/ingest.ts` (preHandler wiring). Do NOT re-auth (the preHandler does it).
- **VALIDATE**: typecheck; covered by Task 12 int test.

### Task 10 — CREATE `apps/ingest/src/routes/monitor.ts` (+ `buildSnapshot`/`emptySnapshot` helpers)
- **IMPLEMENT**: `GET /v1/monitor` (admin-gated; route-owned clock; `buildSnapshot` composes
  `machineStatuses` + `connectorHealth` + `activeSessions(now-ACTIVE_WINDOW)` and applies
  `deriveMachineStatus`/`isBacklogHigh`); `GET /v1/monitor/stream` (SSE per D7, `app.monitorStreamIntervalMs`).
- **PATTERN**: `routes/projections.ts` (admin gate + `DEFAULT_EMAIL`/`findUserIdByEmail`); spike §6 (SSE).
- **GOTCHA**: guards BEFORE `reply.hijack()`; `clearInterval` on close; emit `event: error` on a post-hijack
  failure. `ACTIVE_WINDOW` = 15 min (document it).
- **VALIDATE**: typecheck; Task 12 int test.

### Task 11 — WIRE the ingest app (`app.ts` + `server.ts`)
- **IMPLEMENT**: `BuildAppOptions.monitorStreamIntervalMs?`; `app.decorate("monitorStreamIntervalMs",
  opts.monitorStreamIntervalMs ?? 3000)` (+ module augmentation in `plugins/auth.ts`’s `declare module` or a
  local one); `app.register(heartbeatRoutes)` + `app.register(monitorRoutes)` after `interpretationRoutes`.
  `server.ts`: read `MONITOR_STREAM_INTERVAL_MS` (optional positive int via the existing `parsePositiveInt`)
  → `buildApp`.
- **VALIDATE**: `npm run typecheck` → 0 errors.

### Task 12 — EXTEND `apps/ingest/src/app.int.test.ts`
- **IMPLEMENT**: build the app with `monitorStreamIntervalMs: 50`. Pair a machine; `POST /v1/heartbeat`
  (machine token) → 200; `GET /v1/monitor` (admin) asserts the machine appears with `status: "online"` +
  the backlog + an active session after ingest; `GET /v1/monitor/stream` via **recipe B**
  (`listen({port:0})` + `fetch` reading the ReadableStream) asserts ≥2 `data:` snapshots arrive, then
  `reader.cancel()`; assert 401 for `/v1/monitor` without admin and `/v1/heartbeat` without a machine token.
- **PATTERN**: existing harness (TRUNCATE per test — add nothing new to truncate except the heartbeat
  columns live on `machines`, already truncated); spike §6 recipe B.
- **VALIDATE**: with DB up: `npx vitest run apps/ingest/src/app.int.test.ts` → green, **0 skipped**.

### Task 13 — ADD `postHeartbeat` (`apps/collector/src/ingest-client.ts`)
- **IMPLEMENT**: clone `postIngest`: `POST {base}/v1/heartbeat` + bearer + `expectOk`, body
  `HeartbeatRequest`, return `HeartbeatResponse`.
- **VALIDATE**: `npx tsc -b apps/collector` → 0 errors.

### Task 14 — CREATE `apps/collector/src/heartbeat.ts` + `heartbeat.test.ts`
- **IMPLEMENT**: `maybeSendHeartbeat(deps, state)` (throttle via injected `now` + `intervalMs`; best-effort
  try/catch; reads `queue.stats()`; calls injected `post`).
- **TEST**: (1) no send before `intervalMs` elapses; (2) sends after; (3) a `post` rejection does NOT throw
  and does NOT prevent the next send. Inject `now` + a stub `post`.
- **VALIDATE**: `npx vitest run apps/collector/src/heartbeat.test.ts` → green.

### Task 15 — WIRE the sender into `runSyncLoop` + `cli.ts`
- **IMPLEMENT**: `SyncLoopDeps` gains `heartbeatIntervalMs?` (default 30000), `now?: () => Date` (default
  `() => new Date()`), `collectorVersion`, `postHeartbeat?`. In the loop, construct one `HeartbeatState` and
  call `maybeSendHeartbeat(...)` each iteration (before/after `delay`). `cli.ts` reads the collector
  `package.json` version (entrypoint, not a library) and passes it + the cadence.
- **GOTCHA**: best-effort — never let a heartbeat failure change the loop's `outcome`/abort behavior.
- **VALIDATE**: `npm run typecheck`; `npx vitest run apps/collector` → green (existing sync-worker tests
  still pass; add a loop-level assertion if cheap).

### Task 16 — SCAFFOLD `apps/dashboard` (per spike §4)
- **IMPLEMENT**: create the files in "New Files" using the spike's paste-ready `package.json`,
  `tsconfig.json` (standalone), `next.config.ts`, `postcss.config.mjs`, `components.json` (with `@thegridcn`
  registry), `.gitignore`, `globals.css`, `layout.tsx`, `page.tsx` (redirect → `/monitor`). Add to the npm
  workspace; `npm install` from root.
- **GOTCHA**: do NOT add `apps/dashboard` to the root `tsconfig.json` references. `turbopack.root` → repo
  root; `transpilePackages: ["@420ai/shared"]`. Pin Next/React/react-dom exactly (no caret).
- **VALIDATE**: `npm install` resolves clean; `npm run typecheck` (root `tsc -b`) STILL exits 0 (dashboard
  excluded); `npm run repo-health` STILL PASSes.

### Task 17 — shadcn + theGridCN components
- **IMPLEMENT**: `cd apps/dashboard && npx shadcn@latest init --template next --preset nova --css-variables
  --yes`; add `card table badge` (plain) and `@thegridcn/data-card` (build-verified). Compose stat tiles
  from `data-card`; machine/connector/session lists from `card`+`table`+`badge`.
- **GOTCHA (D10)**: build-verify each theGridCN add; do NOT use `@thegridcn/hud` (broken barrel) or any 3D
  component.
- **VALIDATE**: `npm run build -w @420ai/dashboard` → success after each add.

### Task 18 — Proxy Route Handlers + `src/lib/ingest.ts`
- **IMPLEMENT**: `src/lib/ingest.ts` (server-only `ingestUrl()`/`adminHeaders()`), `api/monitor/route.ts`
  (snapshot JSON proxy), `api/monitor/stream/route.ts` (SSE pass-through). Both `force-dynamic` + try/catch→502.
- **GOTCHA (D8)**: never `NEXT_PUBLIC_*` the token; stream the upstream body unchanged for SSE.
- **VALIDATE**: `npm run build -w @420ai/dashboard` → success.

### Task 19 — Live Monitor page + client SSE component
- **IMPLEMENT**: `src/app/monitor/page.tsx` (server component: server-side fetch the initial snapshot via
  `ingestUrl()/v1/monitor` with `adminHeaders()`, render the sections, pass initial data to
  `<LiveMonitor/>`); `src/components/live-monitor.tsx` (`"use client"`: `new EventSource("/api/monitor/stream")`,
  parse `data:` JSON into `LiveMonitorSnapshot`, re-render machines/connectors/active-sessions; show "last
  event N s ago" computed client-side from `lastEventAt`; close the source on unmount).
- **PATTERN**: `import type { LiveMonitorSnapshot } from "@420ai/shared"`.
- **VALIDATE**: `npm run typecheck -w @420ai/dashboard` → 0 errors; `npm run build -w @420ai/dashboard` → success.

### Task 20 — Root scripts + enforced repo-health lane (D9)
- **IMPLEMENT**: root `package.json` scripts `"typecheck:dashboard": "npm run typecheck -w @420ai/dashboard"`,
  `"build:dashboard": "npm run build -w @420ai/dashboard"`. Add the `typecheck:dashboard` step to
  `scripts/repo-health.mjs` (fail the gate on dashboard type errors).
- **VALIDATE**: `npm run repo-health` runs and PASSes WITH the dashboard lane included.

### Task 21 — `.env.example` + `README.md`
- **IMPLEMENT**: `.env.example` gains `INGEST_URL=http://localhost:8420` (dashboard→ingest),
  `MONITOR_STREAM_INTERVAL_MS=3000` (optional), `HEARTBEAT_INTERVAL_MS=30000` (optional), and a note that
  the dashboard reuses `ADMIN_TOKEN`. `README.md`: bump Status to M9; one short Live Monitor paragraph (no
  convention re-paste).
- **VALIDATE**: `npm run repo-health` → PASS.

### Task 22 — Full deterministic validation (see VALIDATION COMMANDS Levels 1–3)
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS, int
  tests ran (N>0, 0 skipped); `npm run typecheck:dashboard` → 0; `npm run build:dashboard` → success.

### Task 23 — agent-browser acceptance gate (the end-to-end UI gate)
- **IMPLEMENT**: bring up the Level-4 stack (db + ingest + a collector/seed + `npm run dev -w @420ai/dashboard`).
- **RUN**: the `agent-browser` skill (or `browse`/`gstack`) to perform the Level-4 assertions — online card +
  backlog, **live SSE DOM update** after a heartbeat/ingest, online→stale→offline transition, and
  `ADMIN_TOKEN` absent from page source. Save screenshots to `.agents/qa/m9/`.
- **GOTCHA**: this is an agent-invoked acceptance gate (needs the running stack), NOT a `repo-health` step —
  label it honestly at sign-off.
- **VALIDATE**: all four assertions pass; screenshots captured as evidence.

---

## TESTING STRATEGY

### Unit Tests (always run; no infra)
- `packages/shared/src/monitor.test.ts` — status boundaries, fallback, `backlogHigh`, clock injection.
- `apps/collector/src/heartbeat.test.ts` — throttle cadence + best-effort-on-failure (injected `now`/`post`).

### Integration Tests (`*.int.test.ts`, `skipIf(!DATABASE_URL_TEST)`; run with DB up)
- `packages/db/src/repositories/monitor.int.test.ts` — `machineStatuses`/`activeSessions` against a real
  DB after ingest + `recordHeartbeat`; hand-computed expectations; `since`-window inclusion/exclusion.
- `apps/ingest/src/app.int.test.ts` (extended) — heartbeat round-trip; `/v1/monitor` snapshot shape +
  derived `status`; `/v1/monitor/stream` SSE via recipe B (50 ms interval) with `reader.cancel()`; 401 cases.

### Dashboard build (the deterministic gate — no React test infra in M9)
- `npm run typecheck -w @420ai/dashboard` (enforced in repo-health) + `npm run build -w @420ai/dashboard`
  (catches type errors + theGridCN barrel breakage). Optionally a Node-only unit test of `src/lib/ingest.ts`
  (env→headers) if trivial; the Route Handlers are validated by build + the acceptance gate below.

### agent-browser acceptance gate (the end-to-end UI gate — agent-invoked, NOT headless CI)
The build gate proves the dashboard *compiles*; it cannot prove the **live UI works**. The one path no
other test reaches is the full **browser → Next proxy → EventSource → DOM live-update** chain (the ingest
SSE int test only covers SSE in isolation). Cover it with the **`agent-browser`** skill (or the lighter
`browse`/`gstack` daemon) against the running Level-4 stack. This is an **acceptance/dogfood gate**: it
needs the running stack (dashboard + ingest + DB + seeded data) and an agent — it is **not** part of the
automated `repo-health` gate (honest labeling per CLAUDE.md's "skipped ≠ passed"; it is a manual-trigger
acceptance step, run at milestone sign-off). Save screenshots to `.agents/qa/m9/` as evidence.

Scripted assertions (see Level 4 for the exact run):
- navigate `/monitor`; a machine card shows **online** + a backlog count; connectors show "last event N s ago".
- POST a heartbeat / ingest an event against the running ingest → the DOM **updates live without a refresh**
  within the SSE interval (proves the browser→proxy→SSE→DOM chain).
- stop the collector → the machine flips **online → stale → offline** within the thresholds.
- view page source → **`ADMIN_TOKEN` appears 0 times** (the D8 security invariant, asserted in a browser).
- **Code-level Playwright E2E is explicitly deferred** (net-new CI browser infra + flaky SSE) — a future
  hardening item, not M9.

### Edge Cases (must be covered)
- Machine with **no heartbeat yet** → `deriveMachineStatus` falls back to `lastSeenAt`; never crashes on nulls.
- **No user** (`findUserIdByEmail` undefined) → `/v1/monitor` returns an empty snapshot (200), SSE streams
  empty snapshots.
- **Empty / stale active window** → `activeSessions` returns `[]` for an old `sinceIso`.
- **SSE client disconnect** → interval cleared (no leak); **post-hijack snapshot error** → `event: error`
  frame, connection survives.
- **Heartbeat send failure** (ingest down) → loop continues; data ingest unaffected; next heartbeat retries.
- **Ingest down from the dashboard** → proxy returns 502; the page renders the last snapshot / an error state.

---

## VALIDATION COMMANDS

Execute from the repo root. Every command states its pass signal.

### Level 1: Syntax & Style (repo-root build — catches cross-project/test-only imports)
- `npm run typecheck` → **exit 0** (root `tsc -b`; the dashboard is excluded by design — see Level 1b).

### Level 1b: Dashboard lane (root `tsc -b` will NEVER catch these — D9)
- `npm run typecheck:dashboard` → **exit 0**.
- `npm run build:dashboard` → **success** (`next build` compiles; theGridCN components resolve).

### Level 2: Unit tests
- `npx vitest run packages/shared/src/monitor.test.ts apps/collector/src/heartbeat.test.ts` → **all pass**.

### Level 3: Integration tests (DB up)
- `npm run db:up && npm run db:migrate` (applies `0003_*`).
- `npm run repo-health -- --require-db` → **PASS**, and the report shows the `*.int.test.ts` layer **ran
  (N>0, 0 skipped)** — including `monitor.int.test.ts` and the extended `app.int.test.ts`. A plain green
  `repo-health` with int tests skipped is NOT acceptance (CLAUDE.md).

### Level 4: agent-browser acceptance gate (the end-to-end visual gate the user asked for)
Setup (the running stack the agent drives):
1. `npm run db:up && npm run db:migrate`; set `.env` (`DATABASE_URL`, `ADMIN_TOKEN`, optionally
   `INGEST_PORT`, `INGEST_URL`).
2. `npm run ingest:dev` (ingest on :8420).
3. Pair a collector and run it (`apps/collector` CLI) against a real `~/.claude/...` session so events +
   heartbeats flow; OR seed via the int-test path (then POST `/v1/heartbeat` + ingest to drive live updates).
4. `npm run dev -w @420ai/dashboard`.

Run the **`agent-browser`** skill (or `browse`/`gstack`) to perform + screenshot these assertions
(evidence → `.agents/qa/m9/`):
- open `http://localhost:3000/monitor` → a machine card shows **online** + a live backlog count; connectors
  show "last event N s ago"; an active session appears.
- with the page open, POST a heartbeat / ingest a new event against ingest → the DOM **updates without a
  refresh** within the SSE interval (the full browser→proxy→EventSource→DOM chain).
- stop the collector (or stop sending heartbeats) → within `staleMs`/`offlineMs` the machine flips
  **online → stale → offline**.
- capture page source → assert **`ADMIN_TOKEN` occurs 0 times** (D8).

> This gate is **agent-invoked and needs the running stack** — it is the acceptance/dogfood gate, distinct
> from the deterministic `repo-health` gate (Levels 1–3). Run it at milestone sign-off; do not claim it as
> a CI gate.

### Level 5: Additional checks
- `npm run db:generate` after Task 4 shows **no further drift** (the only migration is `0003_*`, additive).
- `git grep -n "NEXT_PUBLIC" apps/dashboard` → **no match for the admin token**.

---

## ACCEPTANCE CRITERIA

- [ ] `POST /v1/heartbeat` (machine-authed) persists `lastHeartbeatAt` + backlog + version; reused by the monitor.
- [ ] `GET /v1/monitor` returns a `LiveMonitorSnapshot` (machines w/ derived `status` + `backlogHigh`,
      connectors, active sessions); admin-gated (401 otherwise); empty snapshot for no-user.
- [ ] `GET /v1/monitor/stream` streams snapshots over SSE; guards before hijack; clears interval on disconnect.
- [ ] The collector sends throttled, best-effort heartbeats from its sync loop; a heartbeat failure never
      affects data ingest.
- [ ] `apps/dashboard` exists as a workspace; `npm run typecheck` (root) still 0 errors; `repo-health` PASS
      with the **enforced** dashboard typecheck lane; `build:dashboard` succeeds.
- [ ] The Live Monitor page renders machines/connectors/active-sessions and **updates live over SSE**;
      "last event N s ago" is honest (from `lastEventAt`); `ADMIN_TOKEN` never reaches the browser.
- [ ] theGridCN is used for at least one widget, build-verified; broken barrels avoided; shadcn fallback in place.
- [ ] One additive migration (`0003_*`, nullable `machines` columns); `db:generate` shows no drift after.
- [ ] **`repo-health -- --require-db` PASS with the int layer RUN (N>0, 0 skipped)** — incl. monitor +
      heartbeat + SSE tests.
- [ ] **agent-browser acceptance gate passed** (Level 4): online card + live backlog, **live SSE DOM
      update** after a heartbeat/ingest, online→stale→offline transition, `ADMIN_TOKEN` absent from page
      source; screenshots saved to `.agents/qa/m9/`.
- [ ] No change to the M2 ingest wire types / fingerprint / encryption / `IngestBatch`.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately.
- [ ] `npm run typecheck` (root) = 0; `typecheck:dashboard` = 0; `build:dashboard` = success.
- [ ] `repo-health -- --require-db` PASS, int tests ran (0 skipped).
- [ ] agent-browser acceptance gate (Level 4): live SSE updates visible; online→stale→offline; token off
      the client; screenshots in `.agents/qa/m9/`.
- [ ] `0003_*` migration committed; no schema drift.
- [ ] README status bumped; `.env.example` updated.
- [ ] `/lril:code-review` clean before commit (per the SUMMARY build loop).

---

## NOTES

- **Branch / baseline**: `m9-live-monitor` off `main` after `fix-m8-provider-config-test` merges (green
  typecheck). PR → `main`.
- **Why SSE over polling**: the user chose live updates; the snapshot REST endpoint remains for initial
  load + a degraded poll fallback if SSE drops.
- **Why heartbeat-first liveness (D5)**: `lastSeenAt` can't tell idle-alive from dead; the heartbeat is the
  purpose-built signal. The fallback keeps pre-M9/just-paired machines sensible.
- **Confidence**: **9.4/10** for one-pass success. The spike retired every integration unknown
  (theGridCN/Next-in-monorepo/SSE/auth — all GO/CONDITIONAL-GO with paste-ready configs); the backend is
  proven M6 patterns + a trivial additive migration. The residual −0.6 is the genuinely new surface area
  (first frontend, SSE-in-real-`buildApp`, per-component theGridCN verification) — each bounded by a
  prescribed test/build gate plus the **agent-browser acceptance gate**, which closes the one coverage gap
  no other test reaches (the full browser→proxy→EventSource→DOM live-update chain), not by an unknown.
- **UI testing (Task 23, Level 4)**: an `agent-browser`-driven acceptance gate is the end-to-end UI check
  (agent-invoked, needs the running stack — honestly NOT a `repo-health`/CI gate). Code-level Playwright
  E2E is deferred to hardening (net-new CI browser infra + flaky SSE).
- **Deferred to M10** (do not scope-creep): the alert engine + delivery, backlog-trend ("growing"),
  heartbeat history, the other dashboard surfaces, archive-export UI, multi-user dashboard auth.
