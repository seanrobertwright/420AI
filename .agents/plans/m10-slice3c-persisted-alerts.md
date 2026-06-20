# Feature: Persisted Alert Engine — firing history/ack + heartbeat time-series (V1 close-out Slice 3C — PRD §20/§23)

The following plan should be complete, but it is important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files (`.js` specifiers, `import type`).

> **Conventions are NOT re-pasted here.** [`CLAUDE.md`](../../CLAUDE.md) (repo root) is the source of
> truth for module/TS/naming rules, the library-no-logging boundary, the testing layers, the validation
> GATE (incl. `--require-db`), the **Drizzle/SQL gotchas**, and the **Frontend-workspace** rules. Read it
> first. This plan links to it rather than duplicating it — do not let a snippet here drift from `CLAUDE.md`.

> **Scope note — this is sub-slice 3C of the M10 hardening bundle.** Per the V1 close-out roadmap in
> [`SUMMARY.md`](../../SUMMARY.md) the M10 bundle is four sub-slices, order **3b → 3a → 3c → 3d**.
> **3b (replay metadata) and 3a (exports) are DONE.** This is **3c — the persisted alert engine**. The
> remaining sub-slice — **3d catalog signing (§10.4)** — is OUT OF SCOPE here and gets its own plan.

> **Scope boundary (decided with the user, 2026-06-19):**
> 1. **Evaluate-on-read, NO background dispatcher.** Firing state is reconciled inside the existing
>    `buildSnapshot` read path (serving both `GET /v1/monitor` and the SSE tick). This deliberately avoids
>    a long-lived `setInterval` evaluator — the exact long-lived-resource/teardown class `CLAUDE.md` and the
>    M9 review repeatedly flag. Because V1 ships **no notification delivery**, "firing history advances when
>    the monitor is observed" is the correct semantics, not a compromise. (See D1.)
> 2. **`deriveAlerts` is FROZEN.** The new "backlog growing" derivative is produced by a NEW pure function
>    layered *beside* `deriveAlerts`, then merged + re-sorted. `deriveAlerts(snapshot)`'s body/behaviour is
>    unchanged (only an internal sort is extracted to an exported `sortAlerts` helper it still calls). (See D2.)
> 3. **Ack ships API + dashboard button.** `POST /v1/alerts/firings/:id/ack` plus an Ack button on the
>    `/monitor` Alerts panel. (See D7.)

---

## Feature Description

The M10 operational-alerts slice (shipped) is **stateless**: `deriveAlerts(snapshot)` re-derives a ranked
alert list on every read, and an alert's `since` is *evidence-time* (last heartbeat / last event), **not** a
firing-start. There is no memory that *"this collector has been offline since 14:12"*, no acknowledgement,
and no way to detect *"backlog is **growing**"* — only *"backlog is high"* (a point-in-time depth), because
the machine row stores only the **latest** heartbeat sample (`schema.ts` machines comment, verbatim: *"we
store only the LATEST sample … backlog-GROWING / heartbeat history is M10, D4"*).

This slice adds the **persisted alert engine** the op-alerts plan named as the natural follow-up
(`.agents/plans/m10-operational-alerts.md` NOTES: *"a `machine_heartbeats` time-series table for 'backlog
growing', an `alerts` firing/resolved table with ack"*). Three capabilities:

1. **Heartbeat time-series** — a new append-only `machine_heartbeats` table. `recordHeartbeat` keeps
   updating the machine's latest-sample columns (M9 read path unchanged) **and** appends a sample, pruning
   beyond a retention window. This makes *trend* computable.
2. **`sync.backlog_growing`** — a new pure `deriveBacklogTrendAlerts(...)` over the recent samples, emitted
   beside `deriveAlerts`'s output and merged into the snapshot's `alerts`.
3. **Firing history + ack** — a new `alert_firings` table. After deriving alerts, `buildSnapshot` reconciles
   them against the persisted open firings (idempotent upsert + resolve-the-absent), so each firing carries a
   real `firstFiredAt` / `lastSeenAt` / `resolvedAt` and an `ackedAt`. The snapshot gains an `alertFirings`
   field; the dashboard renders it with an **Ack** button.

The mechanism is a **direct clone of the M10 attribution repository** (`attribution.ts`): upsert-by-unique
+ status transitions + a `PATCH`/`POST :id` admin route returning the updated row — no new architectural
primitive.

## User Story

```
As a self-hosting developer watching the Live Monitor
I want alerts to remember when they started firing, to tell me when a backlog is GROWING (not just high),
   and to let me acknowledge one so it stops drawing my eye
So that I can triage operational problems over time — see how long a collector has been down and silence
   what I've already seen — instead of a stateless list that forgets everything between page loads.
```

## Problem Statement

PRD §20 requires V1 operational alerts including **"sync backlog growing"** — a *derivative*, impossible
from the single latest heartbeat sample M9 persists. And a stateless alert list cannot answer *"since when?"*
or *"I've seen this — stop nagging."* The op-alerts slice explicitly deferred firing history, ack, and the
backlog-growing condition to *"the natural second M10 slice"* (its NOTES). Without persistence there is no
firing-start, no acknowledgement, and no trend — the monitor re-computes from zero on every read.

## Solution Statement

Mirror the **already-shipped `attribution.ts` upsert/status/transition mechanism**, adding two tables and a
reconcile step rather than inventing machinery:

1. **`machine_heartbeats`** (append-only) — `recordHeartbeat` appends a sample + prunes; a new
   `recentBacklogSamples` projection reads the recent window grouped by machine.
2. **A new pure `deriveBacklogTrendAlerts(machines, samplesByMachine)`** in `@420ai/shared` emits
   `sync.backlog_growing` (warning) when a machine's pending backlog rose by ≥ a threshold across the window
   and the machine isn't offline. It is merged with the frozen `deriveAlerts` output via an exported
   `sortAlerts` helper.
3. **`alert_firings`** — `reconcileAlertFirings(db, userId, alerts, now)` (evaluate-on-read, in
   `buildSnapshot`): idempotently upserts one **open** firing per alert (a **partial unique index** on
   `(user_id, alert_key) WHERE status='open'` is the idempotency backbone — proven by the planning spike
   below), and resolves open firings whose key is no longer derived. `ackAlertFiring` sets `acked_at`.
4. **Snapshot + dashboard** — `LiveMonitorSnapshot` gains `alertFirings: AlertFiring[]`; `MONITOR_VERSION`
   bumps `m10-monitor-v1` → `m10-monitor-v2`; the Alerts panel renders firings with an Ack button (proxied,
   admin-token-on-the-server-hop).

**Zero change to `deriveAlerts`'s behaviour, zero change to the fingerprint, no collector change** (the
time-series append is server-side in `recordHeartbeat`). The reconcile WRITE rides the read; **no long-lived
dispatcher** is introduced.

## Feature Metadata

**Feature Type**: New Capability (persisted layer around the stateless M10 alerts)
**Estimated Complexity**: **Medium–Large** (2 new tables + 1 generated migration; 1 new shared module + 1
extended shared module; 3 new DB repo functions + 2 extended; 1 new ingest route + `buildSnapshot` rewrite;
1 new dashboard proxy route + Alerts-panel rework). No new npm dependency.
**Primary Systems Affected**: `packages/shared` (new `alert-firings.ts` + extended `alerts.ts`/`monitor.ts`),
`packages/db` (2 tables + migration + reconcile/ack/samples repos + `recordHeartbeat`), `apps/ingest`
(`buildSnapshot` reconcile + ack route), `apps/dashboard` (Alerts panel + ack proxy)
**Dependencies**: **None new.** Uses `drizzle-kit generate` (the established migration workflow).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The mechanism to clone (attribution = the textbook analog)**
- `packages/db/src/repositories/attribution.ts` (whole, 358 lines) — **THE pattern this slice mirrors.**
  `computeSessionGitSuggestions` (186–273) does `insert(...).onConflictDoNothing({target})` + a guarded
  `update ... where status='suggested'`; `addManualLink` (281–304) does `onConflictDoUpdate({target, set})`;
  `setLinkStatus` (307–326) updates by `(id,userId)` then re-selects + maps → returns the typed row. Your
  `reconcileAlertFirings`/`ackAlertFiring` follow these idioms exactly (upsert, status transition, return
  the mapped row). Note: every query is **scoped by `userId`**.
- `apps/ingest/src/routes/git.ts` (whole, 146 lines) — the admin-gated mutation route pattern. The
  `PATCH /v1/git-links/:id` handler (129–145) is the **direct template** for `POST /v1/alerts/firings/:id/ack`:
  `adminAuthorized` → `isUuid(params.id)` else 404 → `findUserIdByEmail` → repo call → `undefined`→404 →
  send the row. Copy this control-flow verbatim.

**The alert subsystem (frozen contract + extension points)**
- `packages/shared/src/alerts.ts` (whole, 132 lines) — `AlertCode`, `AlertSeverity`, `OperationalAlert`,
  `ALERT_VERSION`, `ALERT_THRESHOLDS`, `deriveAlerts`, the private `SEVERITY_RANK`. You ADD
  `"sync.backlog_growing"` to `AlertCode`; ADD `BacklogSample`, `BACKLOG_TREND_WINDOW_MS`,
  `BACKLOG_TREND_THRESHOLDS`, `deriveBacklogTrendAlerts`; EXPORT a `sortAlerts` helper (extract the existing
  `.slice().sort(...)` tail of `deriveAlerts`, line 129–131, and have `deriveAlerts` call it — **behaviour
  unchanged**, D2). The module doc-comment (3–23) explicitly says the persisted engine is a deferred slice —
  update it to reflect that this slice adds the trend-derivative beside (not inside) `deriveAlerts`.
- `packages/shared/src/alerts.test.ts` (whole, 154 lines) — the **exact unit-test idiom** (hand-built
  `LiveMonitorSnapshot` fixture via `emptyMonitorSnapshot(...)` + spread; `machine(...)`/`connector(...)`
  factories; no real clock). Your new trend/sort/key cases mirror it.
- `packages/shared/src/monitor.ts` (whole, 99 lines) — `LiveMonitorSnapshot` (58–65), `MONITOR_VERSION`
  (23), `emptyMonitorSnapshot` (97–99), `MONITOR_THRESHOLDS` (26–30). You ADD `alertFirings: AlertFiring[]`
  to the snapshot; BUMP `MONITOR_VERSION` to `"m10-monitor-v2"`; ADD `alertFirings: []` to
  `emptyMonitorSnapshot`. Add `import type { AlertFiring } from "./alert-firings.js";`.
- `apps/ingest/src/routes/monitor.ts` (whole, 128 lines) — **the read path you rewrite.** `buildSnapshot`
  (33–56) composes the snapshot; you fetch `recentBacklogSamples`, merge backlog-growing, **reconcile
  firings (the new WRITE)**, and attach `alertFirings`. The SSE `push` (107–122) calls `buildSnapshot` every
  `monitorStreamIntervalMs` (default **3000ms**, `app.ts:21`) — so reconcile runs per tick (D1, write-amp
  is trivial for a single user; documented). The no-user path (78, 113) returns `emptyMonitorSnapshot` (no
  reconcile — nothing to persist).

**Heartbeat write path (time-series append)**
- `packages/db/src/repositories/machines.ts` (whole, 68 lines) — `recordHeartbeat` (37–51) updates the
  machine's latest-sample columns. You ADD a `machineHeartbeats` insert + a retention prune **inside** it,
  computing `now` once and reusing it for both writes. `hb.now` is already injectable (40) — keep it.
- `apps/ingest/src/routes/heartbeat.ts` (whole, 27 lines) — confirms the heartbeat route calls
  `recordHeartbeat` only; **no route change needed** (the time-series append is internal to the repo).
- `packages/db/src/repositories/monitor.ts` (whole, 99 lines) — the projections repo. You ADD
  `recentBacklogSamples(db, userId, since)`. Note the **Drizzle gotcha** doc (4–19): `machines.*` plain
  `timestamptz` columns come back as JS `Date` → normalize with `.toISOString()`. `machine_heartbeats.ts`
  is the same (plain timestamptz) → same `.toISOString()` on read. `machineStatuses` (22–50) is the
  Date→ISO pattern to mirror.
- `packages/db/src/repositories/monitor.int.test.ts` (whole, 146 lines) — the int-test idiom
  (`describe.skipIf(!TEST_URL)`, `TRUNCATE … RESTART IDENTITY CASCADE`, seed users/machines/events). Extend
  with `recentBacklogSamples` + the `recordHeartbeat`-appends-a-sample assertions.

**Schema + migration + barrels**
- `packages/db/src/schema.ts` — the table definitions. `machines` (37–57), `users` (31–35),
  `sessionGitLinks` (349–371, the closest table shape: userId-scoped, status text, unique index). You ADD
  `machineHeartbeats` + `alertFirings` (exact source in Task 5) and `import { sql } from "drizzle-orm";`
  (needed for the partial-index `.where()` predicate — currently only `drizzle-orm/pg-core` + types are
  imported).
- `packages/db/src/index.ts` (whole, 90 lines) — the `@420ai/db` barrel. ADD the `machineHeartbeats` +
  `alertFirings` table exports (3–17 block) and the new repo functions
  (`reconcileAlertFirings`/`listAlertFirings`/`ackAlertFiring`/`recentBacklogSamples`) + `recordHeartbeat`
  is already exported (29).
- `packages/shared/src/index.ts` (whole, 17 lines) — ADD `export * from "./alert-firings.js";` after
  `./alerts.js` (line 10).
- `packages/db/drizzle/` — migrations `0000…0005` + `meta/_journal.json` + `meta/000N_snapshot.json`.
  Latest is `0005_uneven_doorman.sql`. You run `npm run db:generate` to emit `0006_*.sql` + snapshot +
  journal entry from the `schema.ts` diff. **Do NOT hand-write it** (the snapshot must stay in sync). The
  planning spike (NOTES) already confirmed the exact emitted SQL.

**Dashboard (proxy + panel + ack button)**
- `apps/dashboard/src/components/live-monitor.tsx` (whole, 74 lines) — the `"use client"` SSE root;
  `MonitorView` renders inside it, so the Alerts panel (and its Ack button) live in the client subtree.
- `apps/dashboard/src/components/monitor/monitor-view.tsx` (whole, 213 lines) — renders `AlertsPanel`
  (57). You change that to pass `firings={snapshot.alertFirings}`. `formatAgo` (17–28) and `STATUS_BADGE`
  (30–34) are the colour/relative-time idioms to reuse.
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` (whole, 78 lines) — the panel you rework to
  render `AlertFiring[]` (first-fired/last-seen columns + Ack button). `SEVERITY_BADGE` (29–33) stays.
- `apps/dashboard/src/app/api/monitor/route.ts` (whole, 25 lines) + `apps/dashboard/src/lib/ingest.ts`
  (whole, 19 lines) — the **proxy pattern** (`ingestUrl()` + `adminHeaders()` add the bearer on the
  server→ingest hop; `force-dynamic`; refused-upstream `try/catch` → 502). The ack proxy mirrors this with
  `method:"POST"`. **`lib/ingest.ts` is server-only** — only the Route Handler imports it; the browser hits
  the same-origin proxy (D8 token-never-in-browser invariant).
- `apps/dashboard/src/app/monitor/page.tsx` (whole, 29 lines) — the Server Component that fetches the
  initial snapshot (its GET triggers the **first** reconcile on page load).

**Auth + wiring**
- `apps/ingest/src/auth.ts` — `adminAuthorized(app, request)` + `isUuid(s)` (used by every admin route).
- `apps/ingest/src/app.ts` — route registration (where `gitRoutes`/`monitorRoutes` are wired); register the
  new `alertRoutes` the same way. `DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000` lives here (line 21).

### New Files to Create

- `packages/shared/src/alert-firings.ts` — the persisted-firing wire type + key helper:
  `AlertFiring`, `AlertFiringStatus`, `alertKey(alert)`, `ALERT_FIRINGS_RESOLVED_WINDOW_MS`. **Imports only
  `import type { AlertCode, AlertSeverity, OperationalAlert } from "./alerts.js"`** (keep `@420ai/shared`
  dependency-free + clock-free).
- `packages/db/src/repositories/alert-firings.ts` — `reconcileAlertFirings`, `listAlertFirings`,
  `ackAlertFiring`.
- `apps/ingest/src/routes/alerts.ts` — the `POST /v1/alerts/firings/:id/ack` admin route.
- `apps/dashboard/src/app/api/alerts/firings/[id]/ack/route.ts` — the same-origin ack proxy (POST).
- `packages/db/src/repositories/alert-firings.int.test.ts` — reconcile/ack/idempotency int tests.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) — **§20** (Alerts — the six V1 conditions; this slice adds
  **"sync backlog growing"** + firing history/ack; the still-deferred ones are listed in NOTES), **§10.1.1**
  (liveness "last event N seconds ago"), **§23** (version stamps — `MONITOR_VERSION` is a derivation-shape
  stamp, bumped here).
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — glossary. Name code after **"Operational Alert"**. **GAP
  (Task 17):** add **"Alert Firing"**, **"Heartbeat Sample"**, and **"Backlog Growing"** entries so the new
  tables/fields are named after documented terms, not invented ones.
- [`.agents/plans/m10-operational-alerts.md`](./m10-operational-alerts.md) — the prior slice. Its NOTES
  name THIS slice ("a `machine_heartbeats` time-series table … an `alerts` firing/resolved table with ack")
  and its taxonomy table (190–195) is the `since`/severity contract you extend. Its **Deferred conditions**
  (217–227) are what this slice does (backlog growing) vs. still defers (auth-failure, archive-unreachable,
  catalog-approval).
- [`.agents/plans/m10-slice3b-replay-metadata.md`](./m10-slice3b-replay-metadata.md) /
  [`m10-operational-alerts.md`](./m10-operational-alerts.md) — the two most recent slice plans; mirror their
  task density + the "Drizzle gotchas obeyed by construction" discipline.
- Drizzle [partial indexes](https://orm.drizzle.team/docs/indexes-constraints) +
  [`onConflictDoUpdate` `targetWhere`](https://orm.drizzle.team/docs/insert#on-conflict-do-update) — the
  partial-unique-index + `targetWhere` upsert this slice rests on (verified by the planning spike).

### Patterns to Follow

Follow `CLAUDE.md` (source of truth). The repo-specific ones that bite here:

**Upsert-by-unique + status transition (the attribution clone)** — `reconcileAlertFirings` uses
`insert(...).onConflictDoUpdate({ target:[userId, alertKey], targetWhere: sql\`status='open'\`, set:{...} })`
(the partial-index upsert) then an `update(...).set({status:'resolved'}).where(... notInArray(alertKey,
keys))`. `ackAlertFiring` mirrors `setLinkStatus` (update by `(id,userId)` → re-select → map).

**Library files never log/exit** (`CLAUDE.md`) — the new repo functions throw at most; the route catches.
`deriveBacklogTrendAlerts`/`sortAlerts`/`alertKey` are pure + clock-free (no `new Date()` in `@420ai/shared`).

**Drizzle/SQL gotchas (`CLAUDE.md`)** — apply carefully here:
- `machine_heartbeats.ts` is plain `timestamptz` (Date) → normalize on read with `.toISOString()` (mirror
  `machineStatuses`). It is **NOT** `mode:"string"`, so `events.ts`'s "already ISO" rule does NOT apply —
  you coerce. The recent-samples query does **no aggregate** (`min/max/date_trunc`) — it selects raw rows
  ordered by `ts`, so there is no Postgres-text-timestamp hazard; only the per-row Date→ISO normalize.
- `queue_pending`/`queue_inflight` are plain `integer` columns selected directly → JS numbers (no
  `numeric`→string wrap; no `::int` needed — that cast only matters for `count(*)`/`sum` aggregates, which
  this slice does not add).
- `alert_firings.since` is stored as **`text`** (an opaque ISO *display label* carried from the derived
  alert — never compared temporally), sidestepping any Date/string-coercion on write. `first_fired_at`/
  `last_seen_at`/`resolved_at`/`acked_at` ARE real `timestamptz` (Date), written from the injected `now`
  and normalized to ISO on read; the resolved-window filter compares `resolved_at` to a `Date` bound.
- The partial-unique conflict target REQUIRES `targetWhere` (a plain `target` without it does not match a
  partial index → Postgres rejects the upsert). The planning spike confirmed drizzle-kit emits
  `... WHERE "alert_firings"."status" = 'open'` for both the index and (via `targetWhere`) the `ON CONFLICT`.

**`notInArray(col, [])` → `sql\`true\``** (verified in `drizzle-orm/sql/expressions/conditions.js:82`): when
**no** alerts are derived, the resolve step's `notInArray(alertKey, [])` is `true`, so it resolves ALL open
firings — **no empty-array special-case needed** (unlike `inArray([])` → `false`).

**Frontend workspace** (`CLAUDE.md`) — `apps/dashboard` is **out of root `tsc -b`**; the panel + proxy are
checked only by `typecheck:dashboard` / `build:dashboard`. Reuse the hand-written `Card`/`Badge`/`Table`/
`cn` primitives — do **not** run `npx shadcn`. Next is **16.2.9**, so the `[id]` Route Handler's `params`
is a **Promise** — `async function POST(_req, { params }: { params: Promise<{ id: string }> }) { const { id }
= await params; … }`.

**Additive shape change + version stamp** — adding `alertFirings` to `LiveMonitorSnapshot` bumps
`MONITOR_VERSION` `m10-monitor-v1` → `m10-monitor-v2`. Keep `emptyMonitorSnapshot` in sync (`alertFirings:
[]`). The two `app.int.test.ts` assertions at **`:1023`** and **`:1114`** (`expect(...monitorVersion).toBe(
"m10-monitor-v1")`) MUST update to `"m10-monitor-v2"` or the suite goes red.

> **Spike-snippet fidelity:** the partial-unique migration + `targetWhere` upsert were **run during
> planning** (NOTES). The emitted SQL is pinned there; if `db:generate` produces anything different
> (e.g. a non-partial unique index), STOP — the schema `.where(sql\`…\`)` predicate was dropped.

---

## DESIGN DECISIONS (resolve conflicts up front)

- **D1 — Evaluate-on-read; NO background dispatcher (user decision).** Firing reconcile runs inside
  `buildSnapshot` (both `GET /v1/monitor` and each SSE tick). Rationale: (a) an `offline` firing must be
  detected in the **absence** of input — a pure heartbeat-triggered reconcile cannot see it — so the trigger
  must run without an event; evaluate-on-read uses the observer's read as that trigger; (b) V1 ships **no
  notification delivery**, so firing history only needs to be correct *when observed*; (c) it introduces
  **no long-lived resource** (the M9 SSE-leak class `CLAUDE.md` flags). Cost: `buildSnapshot` becomes a
  WRITER, and the SSE path reconciles every 3 s per open dashboard — trivial for a single-user self-hosted
  app (≤ ~20 idempotent upserts/min). A throttle (reconcile at most every N s) is a **deferred refinement**
  (NOTES), not built here.
- **D2 — `deriveAlerts` is FROZEN; backlog-growing layers beside it (user decision).** `deriveAlerts(
  snapshot)`'s body and behaviour are unchanged — only its trailing `.slice().sort(...)` is extracted to an
  exported `sortAlerts(alerts)` that `deriveAlerts` still calls (identical output, stable sort). The new
  `deriveBacklogTrendAlerts(machines, samplesByMachine)` is a SEPARATE pure function; the route does
  `sortAlerts([...deriveAlerts(built), ...deriveBacklogTrendAlerts(...)])`. Adding `"sync.backlog_growing"`
  to the `AlertCode` *type union* does not touch the `deriveAlerts` function.
- **D3 — One **open** firing per `(user, alertKey)` via a PARTIAL unique index.** `alert_key` is a stable
  per-alert identity: machine alerts → `\`${code}:${machineId}\``, connector alerts → `\`${code}:${
  connector}\``. The partial unique index `(user_id, alert_key) WHERE status='open'` guarantees idempotent
  reconcile under concurrent reads (two ticks → one inserts, the other takes the `DO UPDATE` branch). A
  **resolved** firing does NOT occupy the partial index, so a later re-fire inserts a NEW open row with a
  fresh `first_fired_at` (a new incident) — the intended semantics.
- **D4 — `first_fired_at` is the firing-start (the thing the stateless version lacked); `since` stays
  evidence-time.** The upsert sets `first_fired_at`/`last_seen_at` on insert; the `DO UPDATE` set touches
  ONLY `last_seen_at`/`message`/`severity`/`since` — `first_fired_at` is never overwritten, so it records
  when the firing opened. `since` (text) is carried verbatim from the derived alert as a display label.
- **D5 — Resolve = "open firing whose key is no longer derived".** `update … set status='resolved',
  resolved_at=now where user_id=? and status='open' and alert_key not in (currentKeys)`. With zero current
  alerts, `notInArray([])` → `true` resolves all open firings (verified). Idempotent: a second reconcile's
  `where status='open'` matches nothing already-resolved.
- **D6 — `recordHeartbeat` appends a sample + prunes; the M9 read path is untouched.** It still updates the
  machine latest-sample columns (so `machineStatuses`/`deriveMachineStatus` are unchanged) AND inserts a
  `machine_heartbeats` row, then deletes that machine's samples older than `HEARTBEAT_RETENTION_MS`. The
  prune is a cheap indexed delete bounding growth (~1 row / 30 s cadence → ~2 880/machine/day, pruned to the
  retention window). The collector does NOT change.
- **D7 — Ack ships API + dashboard button (user decision).** `POST /v1/alerts/firings/:id/ack` (admin-gated,
  `isUuid`→404, returns the updated `AlertFiring`) + an Ack button on the panel via the same-origin POST
  proxy. Ack sets `acked_at` on the (still-open) firing — it stops drawing the eye but does NOT resolve it;
  resolution happens only when the condition clears. A re-fire after resolve is a fresh row with
  `acked_at=null` (re-nags, correctly).
- **D8 — Token-never-in-browser (carried from M9).** The Ack button hits the same-origin proxy Route
  Handler, which adds `ADMIN_TOKEN` on the server→ingest hop. NEVER a `NEXT_PUBLIC_*` token; the served HTML
  has 0 occurrences of the admin token (asserted in Level-4).

### Resolved conflicting guidance (do not reconcile by guesswork at implement time)
- **"`buildSnapshot` is read-only / clock owned by the route" (M9 D6) vs. "reconcile is a WRITE":** D1
  supersedes for this slice — `buildSnapshot` now performs the reconcile write, still using the route-owned
  `now`. The no-user path stays write-free (returns `emptyMonitorSnapshot`).
- **"`deriveAlerts` is the alert engine" vs. "backlog-growing is a new alert":** D2 — `deriveAlerts` stays
  frozen; backlog-growing is produced by a sibling pure function and merged. The persisted firing list
  (`alertFirings`) is the new authoritative surface; `alerts` (the derived list) remains on the snapshot
  unchanged for back-compat (the op-alerts int test still asserts `body.alerts`).

---

## IMPLEMENTATION PLAN

### Phase 0: Migration-generation check (already run during planning — re-confirm)
Edit `schema.ts` (Task 5), run `npm run db:generate`, and CONFIRM the emitted `0006_*.sql` matches the
spike output in NOTES (two `CREATE TABLE`, the FKs, and crucially the **partial** unique index
`… WHERE "alert_firings"."status" = 'open'`). Purely additive — no `DROP`/`ALTER`.

### Phase 1: Shared foundation (pure, no deps)
`alerts.ts`: add `"sync.backlog_growing"`, `BacklogSample`, trend thresholds, `deriveBacklogTrendAlerts`,
export `sortAlerts`. New `alert-firings.ts`: `AlertFiring` + `alertKey` + resolved-window const.
`monitor.ts`: `alertFirings` on the snapshot + `MONITOR_VERSION` bump + `emptyMonitorSnapshot`. Barrel.

### Phase 2: Schema + migration
Add `machineHeartbeats` + `alertFirings` to `schema.ts` (+ `import { sql }`); generate `0006_*.sql`.

### Phase 3: DB repositories
`recordHeartbeat` appends a sample + prunes; `recentBacklogSamples` projection; the
`reconcileAlertFirings`/`listAlertFirings`/`ackAlertFiring` repo; barrel exports.

### Phase 4: Ingest wiring
`buildSnapshot` fetches samples, merges backlog-growing, reconciles firings, attaches `alertFirings`; the
new `alerts.ts` ack route; register it in `app.ts`.

### Phase 5: Dashboard
The ack proxy Route Handler; the Alerts panel renders firings + Ack button; `monitor-view` passes firings.

### Phase 6: Testing & validation + docs
Unit (trend/sort/key), int (reconcile/ack/idempotency/time-series), end-to-end (`app.int.test.ts` version +
firing + ack), glossary + SUMMARY, full `repo-health -- --require-db` + dashboard lanes.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently validatable.

### 1. EXTEND `packages/shared/src/alerts.ts` — backlog-growing + `sortAlerts`
- **IMPLEMENT**:
  - Add `"sync.backlog_growing"` to the `AlertCode` union (line 29–33).
  - Add `export interface BacklogSample { ts: string; queuePending: number; }` (ts ISO, sorted asc by caller).
  - Add `export const BACKLOG_TREND_WINDOW_MS = 10 * 60_000;` (10-min lookback) and
    `export const BACKLOG_TREND_THRESHOLDS = { minSamples: 3, minGrowth: 50 } as const;` with JSDoc: *"a
    deliberately simple, tunable trend heuristic — a recent-window slope model is a deferred refinement,
    sibling of `connector.failing`'s honest-limit note."*
  - Add `export function deriveBacklogTrend(samples: BacklogSample[]): boolean` — `if (samples.length <
    BACKLOG_TREND_THRESHOLDS.minSamples) return false; const first = samples[0]!, last =
    samples[samples.length-1]!; return last.queuePending - first.queuePending >=
    BACKLOG_TREND_THRESHOLDS.minGrowth;` (pure, clock-free; samples are pre-windowed + sorted asc by the
    repo).
  - Add `export function deriveBacklogTrendAlerts(machines: LiveMonitorSnapshot["machines"],
    samplesByMachine: Map<string, BacklogSample[]>): OperationalAlert[]` — for each machine with `status !==
    "offline"`, `const s = samplesByMachine.get(m.id) ?? []; if (deriveBacklogTrend(s))` push `{ code:
    "sync.backlog_growing", severity: "warning", message: \`Collector "${m.name}" sync backlog is growing
    (${s[0]!.queuePending}→${s[s.length-1]!.queuePending} pending)\`, machineId: m.id, machineName: m.name,
    since: s[s.length-1]!.ts }`. (Offline machines emit no samples anyway; the guard mirrors the
    backlog-high offline suppression in `deriveAlerts`.)
  - EXTRACT the sort: add `export function sortAlerts(alerts: OperationalAlert[]): OperationalAlert[] {
    return alerts.slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]); }` and
    change `deriveAlerts`'s return (line 129–131) to `return sortAlerts(alerts);` — **identical behaviour**
    (stable sort, Node ≥ 24).
- **PATTERN**: the existing `deriveAlerts` structure + the `sync.backlog_high` push (102–111) — same fields,
  same offline-suppression idea.
- **IMPORTS**: existing (`LiveMonitorSnapshot`/`MonitorStatus` from `./monitor.js`). NO new import; NO clock.
- **GOTCHA**: keep `deriveBacklogTrendAlerts` OUT of `deriveAlerts` (D2 — frozen). Non-null assertions on
  `samples[i]` are guarded by the `minSamples >= 3` / `length` checks. No `new Date()`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 2. CREATE `packages/shared/src/alert-firings.ts` — the firing wire type + key
- **IMPLEMENT**:
  - `export type AlertFiringStatus = "open" | "resolved";`
  - `export interface AlertFiring { id: string; alertKey: string; code: AlertCode; severity: AlertSeverity;
    message: string; machineId: string | null; machineName: string | null; connector: string | null; since:
    string | null; status: AlertFiringStatus; firstFiredAt: string; lastSeenAt: string; resolvedAt: string |
    null; ackedAt: string | null; }`
  - `export function alertKey(a: Pick<OperationalAlert, "code" | "machineId" | "connector">): string {
    return \`${a.code}:${a.machineId ?? a.connector ?? "*"}\`; }` — JSDoc: *"stable per-alert identity; the
    partial-unique reconcile key (D3). A machine alert keys on machineId, a connector alert on connector."*
  - `export const ALERT_FIRINGS_RESOLVED_WINDOW_MS = 60 * 60_000;` — JSDoc: *"resolved firings stay visible
    on the snapshot for this long, then drop from `listAlertFirings`."*
- **IMPORTS**: `import type { AlertCode, AlertSeverity, OperationalAlert } from "./alerts.js";` ONLY.
- **PATTERN**: `packages/shared/src/alerts.ts` types; `SessionGitLink` shape in `git.ts` (a typed
  side-record row).
- **GOTCHA**: clock-free, dependency-free (the `@420ai/shared` invariant). `alertKey` is pure.
- **VALIDATE**: `npm run typecheck` (exit 0 after Task 3 wires the barrel/monitor).

### 3. UPDATE `packages/shared/src/monitor.ts` + barrel
- **IMPLEMENT**: (a) `import type { AlertFiring } from "./alert-firings.js";`. (b) add `alertFirings:
  AlertFiring[];` to `LiveMonitorSnapshot` (after `alerts`, line 64). (c) bump `MONITOR_VERSION =
  "m10-monitor-v2"` (line 23). (d) add `alertFirings: []` to `emptyMonitorSnapshot` (line 98). (e) in
  `packages/shared/src/index.ts`, add `export * from "./alert-firings.js";` after line 10.
- **PATTERN**: the existing `alerts: OperationalAlert[]` field + its `emptyMonitorSnapshot` entry — mirror
  exactly for `alertFirings`.
- **GOTCHA**: `import type` (erased — no runtime cycle with `alert-firings.ts` importing from `alerts.ts`).
  Bumping `MONITOR_VERSION` is the D11 shape-stamp — it WILL break the two `app.int.test.ts` assertions
  (Task 16); that is expected and required.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 4. ADD the two tables — `packages/db/src/schema.ts`
- **IMPLEMENT**: add `import { sql } from "drizzle-orm";` (below the `drizzle-orm/pg-core` import). Append
  after `sessionGitLinks` (line 371):
  ```ts
  /**
   * M10 3c heartbeat time-series (PRD §20). Append-only sync-backlog samples so
   * "backlog GROWING" is a real trend (the machines row keeps only the LATEST
   * sample — schema comment above). recordHeartbeat appends here + prunes beyond
   * HEARTBEAT_RETENTION_MS. Plain timestamptz (Date) → normalize to ISO on read.
   */
  export const machineHeartbeats = pgTable(
    "machine_heartbeats",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      machineId: uuid("machine_id").notNull().references(() => machines.id),
      ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
      queuePending: integer("queue_pending").notNull(),
      queueInflight: integer("queue_inflight").notNull(),
    },
    (t) => [index("machine_heartbeats_by_machine_ts").on(t.machineId, t.ts)],
  );

  /**
   * M10 3c persisted Operational-Alert firings (PRD §20). Evaluate-on-read
   * reconcile (D1) upserts ONE open firing per (user, alert_key) — the PARTIAL
   * unique index below is the idempotency backbone (D3). first_fired_at records
   * when the firing opened (the stateless deriveAlerts could not). `since` is an
   * opaque ISO display label (text — never compared temporally).
   */
  export const alertFirings = pgTable(
    "alert_firings",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      userId: uuid("user_id").notNull().references(() => users.id),
      alertKey: text("alert_key").notNull(),
      code: text("code").notNull(),
      severity: text("severity").notNull(),
      message: text("message").notNull(),
      machineId: uuid("machine_id").references(() => machines.id),
      machineName: text("machine_name"),
      connector: text("connector"),
      since: text("since"),
      status: text("status").notNull().default("open"),
      firstFiredAt: timestamp("first_fired_at", { withTimezone: true }).notNull().defaultNow(),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
      ackedAt: timestamp("acked_at", { withTimezone: true }),
    },
    (t) => [
      // At most ONE open firing per (user, alert_key) — the reconcile idempotency key (D3).
      uniqueIndex("alert_firings_open_key").on(t.userId, t.alertKey).where(sql`${t.status} = 'open'`),
      index("alert_firings_by_user_status").on(t.userId, t.status),
    ],
  );
  ```
- **PATTERN**: `sessionGitLinks` (349–371, userId-scoped + status text + indexes); `gitCommits` (287–319,
  FK + index style).
- **GOTCHA**: `machineId` on `alert_firings` is NULLABLE (connector firings have none). `since` is `text`
  (D-gotcha — no Date coercion on write). The `.where(sql\`…\`)` makes the unique index PARTIAL — this is
  the load-bearing bit; do not drop it. snake_case SQL names, camelCase TS keys.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 5. GENERATE the migration — `packages/db/drizzle/0006_*.sql`
- **IMPLEMENT**: from the repo root, `npm run db:generate`. Emits `0006_<name>.sql` + `meta/0006_snapshot.json`
  + a `_journal.json` entry.
- **PATTERN**: prior generated migrations (`0005`). Commit SQL + snapshot + journal together.
- **GOTCHA**: **CONFIRM** the emitted SQL matches the planning spike (NOTES): two `CREATE TABLE`, three FKs,
  `CREATE UNIQUE INDEX "alert_firings_open_key" … WHERE "alert_firings"."status" = 'open'` (the **partial**
  predicate present), `alert_firings_by_user_status`, `machine_heartbeats_by_machine_ts`. **No `DROP`/`ALTER
  COLUMN`.** If the `WHERE` is missing, the schema `.where(sql\`…\`)` was dropped — STOP. Do NOT hand-edit.
- **VALIDATE**: open `0006_*.sql`, verify the partial index line; `npm run db:up && npm run db:migrate`
  applies cleanly (exit 0).

### 6. APPEND a sample + prune — `packages/db/src/repositories/machines.ts` (`recordHeartbeat`)
- **IMPLEMENT**: import `and`, `lt` from `drizzle-orm` (already imports `eq`); import `machineHeartbeats`
  from `../schema.js`; import `HEARTBEAT_RETENTION_MS` from `@420ai/shared` (Task 6a). Add a const
  `export const HEARTBEAT_RETENTION_MS = 24 * 60 * 60_000;` — put it in `@420ai/shared` `alert-firings.ts`
  (it is heartbeat-retention config, clock-free) **OR** local to `machines.ts`. Recommended: local in
  `machines.ts` (it is a DB-layer prune bound, not a wire constant) — `const HEARTBEAT_RETENTION_MS = 24 *
  60 * 60_000;`. Rewrite `recordHeartbeat`:
  ```ts
  export async function recordHeartbeat(db, machineId, hb): Promise<void> {
    const now = hb.now ?? new Date();
    await db.update(machines).set({
      lastHeartbeatAt: now, queuePending: hb.queuePending,
      queueInflight: hb.queueInflight, collectorVersion: hb.collectorVersion,
    }).where(eq(machines.id, machineId));
    // M10 3c: append the time-series sample (trend source) + prune beyond retention.
    await db.insert(machineHeartbeats).values({
      machineId, ts: now, queuePending: hb.queuePending, queueInflight: hb.queueInflight,
    });
    await db.delete(machineHeartbeats).where(
      and(eq(machineHeartbeats.machineId, machineId),
          lt(machineHeartbeats.ts, new Date(now.getTime() - HEARTBEAT_RETENTION_MS))),
    );
  }
  ```
- **PATTERN**: the existing `recordHeartbeat` update (37–51) — keep its signature + `hb.now` injectability
  (the int tests rely on it).
- **GOTCHA**: compute `now` ONCE and use it for the update, the sample `ts`, AND the prune bound (so a test
  injecting `now` is fully deterministic). `lt(machineHeartbeats.ts, Date)` — `ts` is plain timestamptz, so
  a `Date` bound compares correctly. Keep updating the machine latest columns (M9 read path unchanged).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 7. ADD `recentBacklogSamples` — `packages/db/src/repositories/monitor.ts`
- **IMPLEMENT**: import `and, gte` (already imports `eq, sql`); import `machineHeartbeats`; import
  `type BacklogSample` from `@420ai/shared`. Add:
  ```ts
  /**
   * Recent backlog samples per machine for the trend derivative (M10 3c). Clock-free:
   * the route passes `since` (a Date = now - BACKLOG_TREND_WINDOW_MS). Scoped by userId
   * via the machines join. ts is plain timestamptz → Date → ISO. Sorted asc so the
   * pure deriveBacklogTrend can read first/last directly.
   */
  export async function recentBacklogSamples(
    db: DbClient, userId: string, since: Date,
  ): Promise<Map<string, BacklogSample[]>> {
    const rows = await db
      .select({
        machineId: machineHeartbeats.machineId,
        ts: machineHeartbeats.ts,
        queuePending: machineHeartbeats.queuePending,
      })
      .from(machineHeartbeats)
      .innerJoin(machines, eq(machineHeartbeats.machineId, machines.id))
      .where(and(eq(machines.userId, userId), gte(machineHeartbeats.ts, since)))
      .orderBy(machineHeartbeats.machineId, machineHeartbeats.ts);
    const byMachine = new Map<string, BacklogSample[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machineId) ?? [];
      list.push({ ts: r.ts.toISOString(), queuePending: r.queuePending });
      byMachine.set(r.machineId, list);
    }
    return byMachine;
  }
  ```
- **PATTERN**: `machineStatuses` (22–50) — the user-scoped `machines` join + Date→ISO `.toISOString()`.
- **GOTCHA**: `r.ts` is a JS `Date` (plain timestamptz, NOT `mode:"string"`) → `.toISOString()`. `gte(ts,
  since)` with a `Date` bound is correct (no `mode:"string"` aggregate-text hazard — this is a raw-row
  select, not `min/max`). `queuePending` is plain `integer` → JS number (no `Number()` wrap).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 8. CREATE `packages/db/src/repositories/alert-firings.ts` — reconcile / list / ack
- **IMPLEMENT**:
  ```ts
  import { and, eq, gte, notInArray, or, sql } from "drizzle-orm";
  import { alertKey, ALERT_FIRINGS_RESOLVED_WINDOW_MS, type AlertFiring, type OperationalAlert,
    type AlertCode, type AlertSeverity } from "@420ai/shared";
  import type { DbClient } from "../client.js";
  import { alertFirings } from "../schema.js";

  const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

  function toFiring(r: { /* the selected columns, Date ts */ … }): AlertFiring { /* Date→ISO map */ }

  /** Evaluate-on-read reconcile (D1/D3/D4/D5). Upsert open firings, resolve the absent, return current. */
  export async function reconcileAlertFirings(
    db: DbClient, userId: string, alerts: OperationalAlert[], now: Date,
  ): Promise<AlertFiring[]> {
    const keys = alerts.map(alertKey);
    for (const a of alerts) {
      await db.insert(alertFirings).values({
        userId, alertKey: alertKey(a), code: a.code, severity: a.severity, message: a.message,
        machineId: a.machineId ?? null, machineName: a.machineName ?? null, connector: a.connector ?? null,
        since: a.since, status: "open", firstFiredAt: now, lastSeenAt: now,
      }).onConflictDoUpdate({
        target: [alertFirings.userId, alertFirings.alertKey],
        targetWhere: sql`${alertFirings.status} = 'open'`,
        set: { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since },
      });
    }
    await db.update(alertFirings)
      .set({ status: "resolved", resolvedAt: now })
      .where(and(eq(alertFirings.userId, userId), eq(alertFirings.status, "open"),
                 notInArray(alertFirings.alertKey, keys)));
    return listAlertFirings(db, userId, now);
  }

  /** Open firings + firings resolved within ALERT_FIRINGS_RESOLVED_WINDOW_MS. Open+unacked first. */
  export async function listAlertFirings(db: DbClient, userId: string, now: Date): Promise<AlertFiring[]> {
    const cutoff = new Date(now.getTime() - ALERT_FIRINGS_RESOLVED_WINDOW_MS);
    const rows = await db.select({ /* all columns */ }).from(alertFirings)
      .where(and(eq(alertFirings.userId, userId),
                 or(eq(alertFirings.status, "open"),
                    and(eq(alertFirings.status, "resolved"), gte(alertFirings.resolvedAt, cutoff)))));
    return rows.map(toFiring).sort((a, b) =>
      (rank(a) - rank(b)) ||
      (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
      (Date.parse(a.firstFiredAt) - Date.parse(b.firstFiredAt)));
    // rank(f): open&&!acked=0, open&&acked=1, resolved=2
  }

  /** Ack a firing (sets acked_at; does NOT resolve it). Scoped by userId; returns the mapped row. */
  export async function ackAlertFiring(
    db: DbClient, userId: string, id: string, now: Date,
  ): Promise<AlertFiring | undefined> {
    const [u] = await db.update(alertFirings).set({ ackedAt: now })
      .where(and(eq(alertFirings.id, id), eq(alertFirings.userId, userId)))
      .returning({ id: alertFirings.id });
    if (!u) return undefined;
    const [row] = await db.select({ /* all columns */ }).from(alertFirings)
      .where(eq(alertFirings.id, id)).limit(1);
    return row ? toFiring(row) : undefined;
  }
  ```
  Fill in the explicit column selections + the `toFiring` Date→ISO mapper (`firstFiredAt: r.firstFiredAt
  .toISOString()`, `resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null`, `ackedAt` likewise;
  `code: r.code as AlertCode`, `severity: r.severity as AlertSeverity`, `status: r.status as
  AlertFiringStatus`). Define `rank(f)` inline.
- **PATTERN**: `attribution.ts` — `onConflictDoUpdate` (281–304), `setLinkStatus` update→re-select→map
  (307–326), the `as`-cast of a `text` column to its union type (`toLink`, 126–146).
- **GOTCHA**: the `targetWhere` is MANDATORY for the partial index (a bare `target` won't match → upsert
  fails). `notInArray(alertKey, keys)` with `keys=[]` → `sql\`true\`` → resolves all open (correct, D5). The
  `since` value is `a.since` (string|null → text column). `machineId: a.machineId ?? null` (a connector
  alert's undefined → null FK). Library throws, never logs.
- **VALIDATE**: `npm run typecheck` (exit 0).

### 9. EXPORT the new symbols — `packages/db/src/index.ts`
- **IMPLEMENT**: add `machineHeartbeats, alertFirings` to the `from "./schema.js"` export block (3–17). Add
  `export { recentBacklogSamples } from "./repositories/monitor.js";` (or extend the existing line 31). Add
  `export { reconcileAlertFirings, listAlertFirings, ackAlertFiring } from "./repositories/alert-firings.js";`.
- **PATTERN**: the existing barrel groupings (the `attribution.js` export block, 81–89).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 10. REWIRE `buildSnapshot` + reconcile — `apps/ingest/src/routes/monitor.ts`
- **IMPLEMENT**: extend the `@420ai/shared` import with `deriveBacklogTrendAlerts, sortAlerts,
  BACKLOG_TREND_WINDOW_MS`; extend the `@420ai/db` import with `recentBacklogSamples, reconcileAlertFirings`.
  Rewrite `buildSnapshot`:
  ```ts
  async function buildSnapshot(db, userId, now): Promise<LiveMonitorSnapshot> {
    const nowMs = now.getTime();
    const sinceIso = new Date(nowMs - ACTIVE_WINDOW_MS).toISOString();
    const trendSince = new Date(nowMs - BACKLOG_TREND_WINDOW_MS);
    const [machines, connectors, sessions, samplesByMachine] = await Promise.all([
      machineStatuses(db, userId), connectorHealth(db, userId),
      activeSessions(db, userId, sinceIso), recentBacklogSamples(db, userId, trendSince),
    ]);
    const machineRows = machines.map((m) => ({
      ...m, status: deriveMachineStatus(m, nowMs), backlogHigh: isBacklogHigh(m.queuePending),
    }));
    const built: LiveMonitorSnapshot = {
      monitorVersion: MONITOR_VERSION, generatedAt: now.toISOString(),
      machines: machineRows, connectors, activeSessions: sessions, alerts: [], alertFirings: [],
    };
    const alerts = sortAlerts([
      ...deriveAlerts(built),
      ...deriveBacklogTrendAlerts(machineRows, samplesByMachine),
    ]);
    const alertFirings = await reconcileAlertFirings(db, userId, alerts, now);
    return { ...built, alerts, alertFirings };
  }
  ```
- **PATTERN**: the existing `buildSnapshot` (33–56) — the `built`/`deriveAlerts` two-step; D6 route-owns-the-
  clock (`now`).
- **GOTCHA**: `deriveAlerts(built)` reads `built.machines`/`built.connectors` (the empty `alerts`/
  `alertFirings` are ignored). The reconcile is the new WRITE (D1) — it runs on BOTH the `GET` (79) and the
  SSE `push` (107–122) paths since both call `buildSnapshot`; the SSE `try/catch` already wraps it. The
  **no-user paths** (78, 113) return `emptyMonitorSnapshot` and DO NOT reconcile — leave them unchanged
  (`alertFirings: []` comes from the shared helper).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 11. CREATE the ack route — `apps/ingest/src/routes/alerts.ts`
- **IMPLEMENT**:
  ```ts
  import type { FastifyInstance } from "fastify";
  import { ackAlertFiring, findUserIdByEmail } from "@420ai/db";
  import { adminAuthorized, isUuid } from "../auth.js";

  const DEFAULT_EMAIL = "seanrobertwright@gmail.com";

  /** M10 3c — admin-gated alert-firing acknowledgement (mirrors PATCH /v1/git-links/:id). */
  export default async function alertRoutes(app: FastifyInstance): Promise<void> {
    app.post<{ Params: { id: string } }>("/v1/alerts/firings/:id/ack", async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "alert firing not found" });
      }
      const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
      if (!userId) return reply.code(404).send({ error: "alert firing not found" });
      const firing = await ackAlertFiring(app.db, userId, request.params.id, new Date());
      if (!firing) return reply.code(404).send({ error: "alert firing not found" });
      return reply.code(200).send(firing);
    });
  }
  ```
- **PATTERN**: `routes/git.ts` `PATCH /v1/git-links/:id` (129–145) — copy the guard ladder verbatim. No body
  schema (ack carries no payload).
- **GOTCHA**: `isUuid` BEFORE the DB call (a malformed id is a 404, never a cast-500 — the M6–M9 invariant).
  The route owns the clock (`new Date()`), like the others.
- **VALIDATE**: `npm run typecheck` (exit 0 after Task 12 registers it).

### 12. REGISTER the route — `apps/ingest/src/app.ts`
- **IMPLEMENT**: import `alertRoutes from "./routes/alerts.js";` and register it alongside `monitorRoutes`/
  `gitRoutes` (the same `app.register(...)` block).
- **PATTERN**: the existing route registrations (where `monitorRoutes`/`gitRoutes` are wired, ~56–67).
- **GOTCHA**: match the existing registration style (prefix/options). Confirm no double-prefix (`/v1` is in
  the path string, like the other routes).
- **VALIDATE**: `npm run typecheck` (exit 0).

### 13. CREATE the ack proxy — `apps/dashboard/src/app/api/alerts/firings/[id]/ack/route.ts`
- **IMPLEMENT**:
  ```ts
  import { NextResponse } from "next/server";
  import { ingestUrl, adminHeaders } from "@/lib/ingest";

  export const dynamic = "force-dynamic";

  /** Same-origin ack proxy (D8): the browser POSTs here; the Next server adds the admin bearer. */
  export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    try {
      const res = await fetch(`${ingestUrl()}/v1/alerts/firings/${id}/ack`, {
        method: "POST", headers: adminHeaders(), cache: "no-store",
      });
      if (!res.ok) {
        return NextResponse.json({ error: "ingest error", status: res.status }, { status: 502 });
      }
      return NextResponse.json(await res.json());
    } catch {
      return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
    }
  }
  ```
- **PATTERN**: `app/api/monitor/route.ts` (the GET proxy) — same `ingestUrl()`/`adminHeaders()`/`force-
  dynamic`/`try-catch→502`, with `method:"POST"`.
- **GOTCHA**: **Next 16.2.9 → `params` is a `Promise`** — `await params` (a non-awaited `params.id` is a
  runtime error). `lib/ingest.ts` is server-only — fine here (Route Handler). The browser never sees the
  token (D8).
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0).

### 14. REWORK the Alerts panel → firings + Ack — `apps/dashboard/src/components/monitor/alerts-panel.tsx`
- **IMPLEMENT**: add `"use client";` at the top (it now has an onClick handler). Change the prop to
  `{ firings, nowMs }: { firings: AlertFiring[]; nowMs: number }` (import `type { AlertFiring }` from
  `@420ai/shared`; keep `AlertSeverity`). Empty state when `firings.length === 0` → "No active alerts."
  Otherwise a `Table` with columns: **Severity** (`Badge` via `SEVERITY_BADGE`), **Alert** (`f.message`),
  **Scope** (`f.machineName ?? f.connector ?? "—"`), **First fired** (`formatAgo(f.firstFiredAt, nowMs)`),
  **Last seen** (`formatAgo(f.lastSeenAt, nowMs)`), **Action**:
  - `f.status === "resolved"` → muted "resolved";
  - `f.ackedAt` → muted "acked";
  - else an Ack `<button onClick={() => ack(f.id)}>` (a minimal styled button; reuse `cn` + Tailwind).
  `async function ack(id: string) { await fetch(\`/api/alerts/firings/${id}/ack\`, { method: "POST" }); }`
  — on success the next SSE snapshot (≤ 3 s) carries `ackedAt` set (reconcile preserves the firing). OPTIONAL
  optimistic local state (`useState` set of acking ids) to grey the button immediately; keep minimal.
  Resolved rows MAY render with a muted/struck style.
- **PATTERN**: the current `alerts-panel.tsx` table (50–74) + `monitor-view.tsx` `formatAgo`/badge idioms.
- **GOTCHA**: dashboard is **out of root `tsc -b`** — run `typecheck:dashboard`/`build:dashboard` explicitly.
  Do NOT add a shadcn primitive (a plain `<button>` with Tailwind suffices). The ack `fetch` hits the
  **same-origin** proxy (never ingest directly — the token stays server-side, D8). Keep the component
  presentational beyond the single ack POST.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0).

### 15. PASS firings to the panel — `apps/dashboard/src/components/monitor/monitor-view.tsx`
- **IMPLEMENT**: change `<AlertsPanel alerts={snapshot.alerts} nowMs={nowMs} />` (57) to
  `<AlertsPanel firings={snapshot.alertFirings} nowMs={nowMs} />`.
- **PATTERN**: existing prop pass-through in `MonitorView`.
- **GOTCHA**: `snapshot.alertFirings` is always present (shared type guarantees it; `emptyMonitorSnapshot`
  → `[]`). The derived `snapshot.alerts` is no longer rendered (kept on the wire for back-compat).
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard` (both exit 0).

### 16. EXTEND the shared unit tests — `packages/shared/src/alerts.test.ts`
- **IMPLEMENT**: add cases (hand-built fixtures, no clock):
  - `deriveBacklogTrend`: `[]`→false; 2 samples→false (below `minSamples`); 3 samples rising by ≥`minGrowth`
    →true; 3 samples rising by <`minGrowth`→false; 3 samples flat/declining→false.
  - `deriveBacklogTrendAlerts`: a machine with a rising window → one `sync.backlog_growing` (warning, `since`
    = last sample ts, message contains `"→"`); an `offline` machine with rising samples → none (suppressed);
    a machine with no samples → none.
  - `sortAlerts`: a `[warning, critical]` input → `critical` first; stable within a severity.
  - `alertKey`: a machine alert → `\`${code}:${machineId}\``; a connector alert → `\`${code}:${connector}\``.
- **PATTERN**: the existing `alerts.test.ts` `machine(...)`/`connector(...)`/`snapshot(...)` factories +
  `describe`/`it`/`expect`.
- **GOTCHA**: build `samplesByMachine` as a `new Map<string, BacklogSample[]>()`; samples sorted asc.
- **VALIDATE**: `npx vitest run packages/shared/src/alerts.test.ts` (all pass).

### 17. CREATE the firing int tests — `packages/db/src/repositories/alert-firings.int.test.ts`
- **IMPLEMENT**: `describe.skipIf(!process.env.DATABASE_URL_TEST)`. Seed a user + machine (the
  `monitor.int.test.ts` `TRUNCATE … RESTART IDENTITY CASCADE` + insert idiom — include
  `alert_firings, machine_heartbeats` in the TRUNCATE list). Cases:
  1. **Open**: `reconcileAlertFirings(db, userId, [offlineAlert], t0)` → returns one firing, `status:"open"`,
     `firstFiredAt` ≈ t0, `ackedAt:null`, `alertKey === "collector.offline:<machineId>"`.
  2. **Idempotent re-fire**: reconcile the SAME alert at t1>t0 → still ONE row (partial unique held),
     `firstFiredAt` UNCHANGED, `lastSeenAt` advanced to t1. (Query the table count == 1.)
  3. **Resolve**: reconcile with `[]` at t2 → the firing is `status:"resolved"`, `resolvedAt` ≈ t2; a second
     reconcile `[]` is a no-op (still resolved). With `[]`, `notInArray([])`→true resolved it (D5).
  4. **Re-fire after resolve**: reconcile the same alert again at t3 → a NEW open row (count of rows for that
     key == 2; the open one has `firstFiredAt` ≈ t3, `ackedAt:null`).
  5. **Ack**: `ackAlertFiring(db, userId, openId, t4)` → returns the row with `ackedAt` ≈ t4, still
     `status:"open"`; acking an unknown id → `undefined`; acking another user's firing → `undefined` (scoped).
  6. **List window**: a firing resolved > `ALERT_FIRINGS_RESOLVED_WINDOW_MS` ago is excluded from
     `listAlertFirings`; an open one is always included.
- **PATTERN**: `monitor.int.test.ts` setup; `attribution`-style row assertions.
- **GOTCHA**: `*.int.test.ts` — excluded from `tsc -b`, type-stripped by vitest, **self-skips** without
  `DATABASE_URL_TEST`; only proves anything under `--require-db`. Pass explicit `Date` instances for `now`
  (t0…t4) for determinism. Build the `OperationalAlert` fixtures inline (code/severity/machineId/since).
- **VALIDATE**: `npm run repo-health -- --require-db` (this case runs, 0 skipped).

### 18. EXTEND the monitor int tests — `packages/db/src/repositories/monitor.int.test.ts`
- **IMPLEMENT**: add the `machine_heartbeats` table to the `TRUNCATE` list (line 30). Add cases:
  - `recordHeartbeat` appends a `machine_heartbeats` sample (query the table → 1 row with the backlog) AND
    still updates the machine latest columns (existing assertion unaffected).
  - `recentBacklogSamples(db, userId, since)` returns the seeded samples for the machine, sorted asc, ISO
    `ts`, grouped by machineId; a sample older than `since` is excluded; another user's samples don't leak.
  - prune: after a `recordHeartbeat` with `now` far past an old injected sample, samples older than
    `HEARTBEAT_RETENTION_MS` are deleted. (Insert an old sample directly, then `recordHeartbeat` with a new
    `now`, assert the old one is gone.)
- **PATTERN**: the existing `recordHeartbeat`/`machineStatuses` cases (77–114).
- **GOTCHA**: seed samples either via `recordHeartbeat({ now })` or a direct `insert(machineHeartbeats)`
  with explicit `ts` Dates. `recentBacklogSamples`'s `since` is a `Date`.
- **VALIDATE**: `npm run repo-health -- --require-db` (runs, 0 skipped).

### 19. UPDATE the end-to-end monitor test — `apps/ingest/src/app.int.test.ts`
- **IMPLEMENT**: (1) update the two `monitorVersion` assertions: **`:1023`** and **`:1114`** →
  `"m10-monitor-v2"`. (2) In the M9 monitor block: after a fresh heartbeat, assert
  `Array.isArray(body.alertFirings)` and it contains NO open `collector.offline` for the online machine.
  (3) Add a focused case: `recordHeartbeat` with an injected OLD `now` (older than
  `MONITOR_THRESHOLDS.offlineMs` = 5 min) → `GET /v1/monitor` → `body.alertFirings` contains an OPEN firing
  `code:"collector.offline"` with a `firstFiredAt`; then `POST /v1/alerts/firings/${firing.id}/ack` → 200,
  the returned firing has `ackedAt` set; a follow-up `GET` shows that firing with `ackedAt` non-null. (4)
  Optionally assert a `404` for `POST /v1/alerts/firings/<random-uuid>/ack`.
- **PATTERN**: the existing M9 block (`POST /v1/heartbeat` then `GET /v1/monitor` then inspect `body`).
- **GOTCHA**: the route reads the REAL wall clock (D6), so seed an OLD heartbeat via `recordHeartbeat`'s
  injectable `now` to make `offline` deterministic (do NOT sleep). The ack id comes from the prior `GET`'s
  `alertFirings[0].id`. This test is `app.int.test.ts` → runs under `--require-db`.
- **VALIDATE**: `npm run repo-health -- --require-db` (runs, 0 skipped).

### 20. ADD glossary entries — `docs/CONTEXT.md`
- **IMPLEMENT**: near "Operational Alert", add: **"Alert Firing"** — *"A persisted record that an Operational
  Alert is (or was) active: it carries when it first fired, when it was last seen, whether it resolved, and
  whether it was acknowledged. Reconciled on read against the live-derived alerts (PRD §20)."* **"Heartbeat
  Sample"** — *"One time-stamped collector sync-backlog reading appended to the heartbeat time-series, the
  source for the 'backlog growing' trend (distinct from the single latest sample on the machine row)."*
  **"Backlog Growing"** — *"An Operational-Alert condition that fires when a collector's pending sync backlog
  rises across the recent window — a derivative, vs. 'backlog high' which is a point-in-time depth."*
- **PATTERN**: the terse one-sentence glossary style.
- **GOTCHA**: docs only; the NUL/artifact scan in `repo-health` covers it.
- **VALIDATE**: `npm run repo-health` (docs scanned).

### 21. UPDATE `SUMMARY.md` (status + roadmap)
- **IMPLEMENT**: mark sub-slice **3c — Persisted alert engine** done in the V1 close-out roadmap (§6.3): note
  it shipped `machine_heartbeats` (time-series) + `alert_firings` (firing/ack) + `sync.backlog_growing`,
  evaluate-on-read reconcile (no background dispatcher), `MONITOR_VERSION` → `m10-monitor-v2`, migration
  `0006`; note **3d catalog signing** is the last remaining M10 sub-slice. Update §0 status if it still says
  the persisted alert engine "remains".
- **PATTERN**: the existing SUMMARY status prose + the sub-slice list.
- **VALIDATE**: `npm run repo-health` (docs scanned).

### 22. GATE — full `repo-health -- --require-db` + dashboard lanes
- **IMPLEMENT**: nothing new; run the gate with the test DB up and the dashboard lanes.
- **GOTCHA**: this slice touches `@420ai/db` (2 tables + 3 repos + migration) AND `apps/ingest` (route +
  reconcile), so the integration layer MUST actually run — a plain `repo-health` PASS (int self-skipped) is
  NOT sufficient (`CLAUDE.md` "Validation is a GATE"; skipped ≠ passed). Plus the dashboard is out of root
  `tsc -b`, so `build:dashboard` must pass separately.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS (int ran,
  0 skipped); `npm run build:dashboard` → exit 0.

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, always run — no infra)
- `packages/shared/src/alerts.test.ts` — `deriveBacklogTrend` thresholds (minSamples/minGrowth boundaries),
  `deriveBacklogTrendAlerts` (rising → alert; offline → suppressed; no samples → none; message `"→"` +
  `since`), `sortAlerts` (critical-first, stable), `alertKey` (machine vs connector). The pure core — runs
  in `npm test` with no DB.

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST` — run under `--require-db`)
- `alert-firings.int.test.ts` — open / idempotent re-fire (partial unique holds, `first_fired_at` stable) /
  resolve (incl. `notInArray([])` resolves all) / re-fire-after-resolve (new row) / ack (sets `acked_at`,
  scoped, unknown→undefined) / resolved-window list filter.
- `monitor.int.test.ts` — `recordHeartbeat` appends a sample + prunes; `recentBacklogSamples` (ordered, ISO,
  grouped, user-scoped, windowed).
- `app.int.test.ts` — `monitorVersion === "m10-monitor-v2"`; an offline machine yields an OPEN
  `collector.offline` firing with `first_fired_at`; the ack endpoint sets `acked_at` (200) and a random uuid
  → 404; SSE frame still parses.

### Edge Cases (must be covered)
- Zero derived alerts → all open firings resolve (`notInArray([])` → true).
- Two reconciles for the same alert → ONE open row; `first_fired_at` unchanged, `last_seen_at` advances.
- Re-fire after resolve → a NEW open row (fresh `first_fired_at`, `acked_at=null`).
- Connector alert firing → `machine_id` NULL, `alert_key = "connector.failing:<connector>"`.
- Backlog rising but machine offline → no `sync.backlog_growing` (and no samples anyway).
- `< minSamples` heartbeat samples → no trend alert (no false positive on a fresh collector).
- Ack on another user's / unknown firing id → 404 (scoped + existence-checked).
- No-user monitor read → `emptyMonitorSnapshot` with `alertFirings: []`, NO reconcile write.
- Pre-migration rows unaffected (additive tables only; `events`/`machines` untouched).

---

## VALIDATION COMMANDS

All commands run from the **repo root**. Each is a GATE.

### Level 1: Syntax & Types (repo-root build — catches cross-project/test-only imports)
- `npm run typecheck` → **exit 0** (root `tsc -b`; the four backend workspaces).
- `npm run typecheck:dashboard` → **exit 0** (the dashboard's enforced lane — root `tsc -b` will NEVER
  catch its type errors; the new panel + ack proxy live here).

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/alerts.test.ts` → all pass (trend/sort/key).
- `npm test` → full `vitest run`; units always run, int self-skips. **Must be green.**

### Level 3: Integration Tests (the DB-backed layer must ACTUALLY run)
- `npm run db:up && npm run db:migrate` → applies `0006_*.sql` cleanly (exit 0; the partial index creates).
- `npm run repo-health -- --require-db` → **PASS, and the `*.int.test.ts` layer ran with 0 skipped.** This
  slice touches `@420ai/db` + `apps/ingest`, so a plain `repo-health` PASS is NOT sufficient (skipped ≠
  passed). **Milestone sign-off gate.**

### Level 4: Manual / Visual Validation
- `npm run build:dashboard` → **exit 0** (also catches theGridCN barrel breakage; gates sign-off).
- Run ingest + dashboard (`npm run ingest:dev`; `npm run dashboard:dev` with `ADMIN_TOKEN`/`INGEST_URL` in
  `apps/dashboard/.env.local`), open `/monitor`. Pair a collector and send a fresh heartbeat → "No active
  alerts." Seed an OLD heartbeat (or stop heart-beating > 5 min) → a red `collector.offline` firing appears
  with a "First fired" time; click **Ack** → within ≤ 3 s the row shows "acked". Restore the heartbeat →
  the firing resolves (drops after the resolved-window).
- **Screenshot evidence** (gstack daemon is unreliable here — use headless Edge per `CLAUDE.md`):
  `"$EDGE" --headless=new --disable-gpu --screenshot="<abs>.png" http://localhost:3000/monitor`.
- **Token-leak assertion (D8, carried from M9):** `grep -c "$ADMIN_TOKEN"` on the served `/monitor` HTML and
  on the ack-proxy response == 0.

### Level 5: Code-review gate (separate layer)
- `npm run repo-health -- --require-db` green AND run `/lril:code-review` before commit. This slice adds **no
  new long-lived resource** (the reconcile rides the existing read; no new timer/stream) — so the M9
  SSE-leak class does not recur; review focuses on: the `targetWhere` partial-upsert correctness, the
  resolve `notInArray` semantics, `first_fired_at` never being overwritten, userId-scoping on every firing
  query, and the dashboard token-never-in-browser path.

---

## ACCEPTANCE CRITERIA

- [ ] `machine_heartbeats` (append-only) is written by `recordHeartbeat` (+ pruned); `recentBacklogSamples`
      returns ordered, ISO-normalized, user-scoped samples — proven by an int test.
- [ ] `deriveBacklogTrendAlerts` emits `sync.backlog_growing` (warning) when backlog rises ≥ threshold over
      the window and the machine isn't offline; `deriveAlerts`'s behaviour is UNCHANGED (only `sortAlerts`
      extracted) — proven by unit tests.
- [ ] `alert_firings` reconciles evaluate-on-read: one OPEN firing per `(user, alert_key)` (partial unique),
      `first_fired_at` stable across re-fires, absent alerts resolve, re-fire-after-resolve is a new row —
      proven by int tests under `--require-db`.
- [ ] `POST /v1/alerts/firings/:id/ack` sets `acked_at`, is admin-gated + userId-scoped + `isUuid`→404; the
      dashboard Ack button calls it via the same-origin proxy (token never in the browser).
- [ ] `LiveMonitorSnapshot.alertFirings` is populated by `GET /v1/monitor` and rides the SSE stream;
      `emptyMonitorSnapshot` carries `alertFirings: []`; `MONITOR_VERSION === "m10-monitor-v2"` everywhere
      (constant + both `app.int.test.ts` assertions).
- [ ] `0006_*.sql` is generated (not hand-written), purely additive, with the **partial** unique index
      `… WHERE … status = 'open'`; `db:migrate` applies cleanly; snapshot + journal committed together.
- [ ] No background dispatcher / new long-lived resource introduced; no collector change; no fingerprint
      change.
- [ ] `npm run typecheck`, `npm run typecheck:dashboard`, `npm test`, `npm run build:dashboard` exit 0;
      `npm run repo-health -- --require-db` PASSES with the int layer run, **0 skipped**.
- [ ] `docs/CONTEXT.md` defines "Alert Firing" / "Heartbeat Sample" / "Backlog Growing"; `SUMMARY.md` marks
      3c done and names 3d as the last M10 sub-slice.
- [ ] `/lril:code-review` run before commit; findings addressed.

## COMPLETION CHECKLIST

- [ ] Phase-0 migration-generation check done (emitted SQL matches the spike — partial index present).
- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] Root `tsc -b` exits 0; full `vitest run` green; new units present and passing.
- [ ] `repo-health -- --require-db` PASS (int layer exercised, 0 skipped); `build:dashboard` green.
- [ ] Migration + snapshot + journal committed together; `db:migrate` clean.
- [ ] Token-leak assertion holds (0 occurrences in served HTML + ack response).
- [ ] Glossary + SUMMARY updated; deferred §20 conditions + the reconcile-throttle refinement named (not
      implied as covered).

---

## NOTES

**Spikes RUN during planning (evidence, not optimism):**
- **Partial-unique migration generation** — temporarily added `machine_heartbeats` + `alert_firings`
  (with `.where(sql\`status = 'open'\`)`) to `schema.ts` and ran `npm run db:generate` (drizzle-kit
  0.31.10). It emitted, verbatim:
  `CREATE UNIQUE INDEX "alert_firings_open_key" ON "alert_firings" USING btree ("user_id","alert_key") WHERE "alert_firings"."status" = 'open';`
  plus the two `CREATE TABLE`s + three FKs + the two non-unique indexes — **purely additive, no DROP/ALTER**.
  Then reverted the schema + removed the generated `0006`. This proves the load-bearing idempotency backbone
  (the executor's Task 5 must reproduce this exact partial-index line).
- **`targetWhere` support** — `drizzle-orm` **0.45.2** `pg-core/query-builders/insert.d.ts` exposes
  `targetWhere?: SQL` (the partial-index `ON CONFLICT` predicate) and the index builder exposes
  `where(condition: SQL): this` — both required for the evaluate-on-read upsert. Confirmed present.
- **`notInArray([])` codegen** — `drizzle-orm/sql/expressions/conditions.js:82` returns `sql\`true\`` for an
  empty array, so the resolve step needs no empty-array branch (zero alerts → resolve all open). Confirmed.
- **Next version** — `apps/dashboard` runs **Next 16.2.9**, so the `[id]` Route Handler's `params` is a
  `Promise` (must be awaited). Confirmed via `next/package.json`.
- **SSE cadence** — `DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000` (`app.ts:21`): reconcile-on-read writes
  ~1 idempotent upsert-batch / 3 s per open dashboard — trivial at single-user scale (D1).

**Verified symbols/harness (read, not recalled):** `attribution.ts` (`onConflictDoUpdate`/`setLinkStatus`
shapes), `git.ts` (`PATCH /:id` guard ladder), `monitor.ts` route (`buildSnapshot`), `machines.ts`
(`recordHeartbeat` + injectable `now`), `monitor.int.test.ts` (TRUNCATE seed idiom), the two barrels, the
`app.int.test.ts` `monitorVersion` assertion lines (`:1023`, `:1114`), the dashboard proxy + `live-monitor`
client root.

**Deliberately deferred (name in the PR, do NOT build here):**
- **3d catalog signing (§10.4)** — the last M10 sub-slice (separate plan).
- **Reconcile throttle** — at single-user scale the per-SSE-tick reconcile is fine; a "reconcile at most
  every N s" guard (or moving reconcile off the SSE path) is a refinement if multi-user/perf ever matters.
- **Recent-window connector failure rate** — `connector.failing` stays a lifetime ratio (the op-alerts
  honest-limit); a windowed variant is still deferred.
- **Still-deferred §20 conditions** — "ingest authentication failure" (needs 401 tracking),
  "Central Archive unreachable" (collector-side signal; approximated by `collector.offline`), "catalog
  update requires approval" (the 3d catalog-signing slice). This slice closes **"backlog growing"** + firing
  history/ack; it does NOT silently imply §20 is fully covered.
- **Notification delivery** (email/push) — out of V1 scope; it is *why* evaluate-on-read is sufficient (D1).

**Why no `deriveAlerts` change (D2 restated):** the persisted layer reads `deriveAlerts`'s output verbatim
and merges a sibling trend-derivative; the only edit to `alerts.ts` is extracting the existing sort into an
exported `sortAlerts` that `deriveAlerts` still calls — byte-identical output. The pure snapshot function
stays the testable, clock-free core; persistence + the wall clock live in the route/repo layer.

---

## Confidence Score

**9.5/10** for one-pass success. The mechanism is a direct clone of the **shipped** `attribution.ts`
upsert/status/return pattern + the `git.ts` admin `:id` route, over two **additive** tables generated by the
standard drizzle-kit workflow. The single highest risk — whether drizzle-kit emits the **partial** unique
index and whether `onConflictDoUpdate` can target it (`targetWhere`) — was **retired by actually running the
generation spike during planning** (output pinned in NOTES) and reading the `drizzle-orm` type defs. Every
referenced symbol, signature, test-seed idiom, and assertion line number was verified by reading source, and
the cross-cutting ripples (the `MONITOR_VERSION` bump touching `app.int.test.ts:1023/1114`; the
`reports`-style required-field propagation does NOT apply here since the firing insert is internal) are
called out explicitly.

The **−0.5** is two small, test-gated judgement calls, not unknowns: (1) the `deriveBacklogTrend` threshold
(`minGrowth: 50`, `minSamples: 3`, 10-min window) is a first-cut heuristic that may need tuning against real
backlog data (sibling of `connector.failing`'s lifetime-ratio caveat) — wrong thresholds make the alert
noisy/quiet, not broken; and (2) the evaluate-on-read reconcile makes `GET /v1/monitor` a writer, an
intentional architectural choice (D1) whose write-amplification is trivial for single-user but is the one
place a reviewer should sanity-check. Both are behaviour-tunable, not one-pass blockers; `tsc -b` +
`repo-health -- --require-db` + the int tests gate the rest.
