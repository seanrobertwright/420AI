# Feature: M10 — Operational Alerts (derived projection over the Live Monitor)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types, and models. Import from the right files
(`.js` specifiers, `import type`), and treat **`CLAUDE.md` as the source of truth for all conventions**
(module/TS/naming, library-no-logging, testing layers, the validation GATE, the Drizzle gotchas, and the
Frontend-workspace rules). This plan links to those rules rather than re-pasting them — do not let a
snippet here drift from `CLAUDE.md`.

> **Scope note — this is the FIRST of several M10 slices.** M10 ("MVP hardening", PRD §25.10) is a
> *bundle*: exports, catalog signing, operational alerts, replay metadata. Per the user decision and the
> forward-guidance in [`.agents/system-reviews/m7-m9-review.md`](../system-reviews/m7-m9-review.md), this
> slice is **operational alerts only**, built as a **stateless derived projection** over the M9 Live
> Monitor inputs. The other M10 bundle items (exports §22, catalog signing §10.4/§18, replay metadata
> §23) are **out of scope here** and get their own plans.

---

## Feature Description

Turn the M9 Live Monitor's already-derived health *states* into named, severity-ranked **Operational
Alerts** (PRD §20, glossary "Operational Alert" in `docs/CONTEXT.md`). M9 deliberately shipped
*states, not actions* — `deriveMachineStatus` → `online | stale | offline` and `isBacklogHigh` already
live in `@420ai/shared` and are carried per-machine on the `LiveMonitorSnapshot`. This slice adds a pure
`deriveAlerts(snapshot)` function that reads those existing states (it does **not** recompute liveness,
per the m7-m9 review) plus connector health, and emits a list of `OperationalAlert`s. The alerts are
folded into the existing snapshot (so they ride the existing `GET /v1/monitor` + SSE stream for free)
and rendered as a new **Alerts panel** on the dashboard `/monitor` page.

Because an alert is a **re-derivable projection** (repo invariant: "events disposable / projections
re-derivable", `CLAUDE.md` Invariants), this slice adds **no new table, no migration, and no long-lived
dispatcher** — the lowest-risk, most architecturally-consistent first cut.

## User Story

As a self-hosting developer watching the Live Monitor
I want the dashboard to surface named, ranked operational alerts (collector offline, collector stale,
connector failing, sync backlog high)
So that I can see *what is wrong and how urgent it is* at a glance, instead of mentally scanning the
machine/connector tables and re-deriving severity myself.

## Problem Statement

M9 shows raw states (a `status` badge per machine, a `toolsFailed` count per connector, a `backlogHigh`
flag) but never says **"this is a problem, and here's how bad."** PRD §20 requires V1 to *include
operational alerts*. Today the user has to eyeball three separate tables and apply the severity logic in
their head. There is no single ranked "what needs attention right now" surface.

## Solution Statement

Add a pure, dependency-free `deriveAlerts(snapshot: LiveMonitorSnapshot): OperationalAlert[]` to
`@420ai/shared` (mirroring the existing `deriveMachineStatus`/`isBacklogHigh` pattern in
`packages/shared/src/monitor.ts`). It reads the snapshot's already-derived `machines[].status`,
`machines[].backlogHigh`, and `connectors[]` rows and emits `OperationalAlert`s sorted critical-first.
The ingest `buildSnapshot` (in `apps/ingest/src/routes/monitor.ts`) calls it and attaches `alerts` to the
snapshot; `MONITOR_VERSION` bumps to `m10-monitor-v1` (the D11 shape-change stamp). The dashboard renders
an `AlertsPanel` from `snapshot.alerts`. Connector-failure detection requires one **additive** field on
`ConnectorHealthRow` (`toolCalls`) so a failure *ratio* can be computed.

## Feature Metadata

**Feature Type**: New Capability (additive to M9 Live Monitor)
**Estimated Complexity**: Low–Medium
**Primary Systems Affected**: `packages/shared` (new pure module + snapshot shape), `packages/db`
(one additive field on the `connectorHealth` projection), `apps/ingest` (compose alerts into the
snapshot route), `apps/dashboard` (new Alerts panel)
**Dependencies**: None new. No new npm packages, no external CLI, no DB migration.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING!

- `packages/shared/src/monitor.ts` (whole file, ~98 lines) — **the pattern to mirror.** Pure,
  clock-free, dependency-free module: `MonitorStatus`, `MONITOR_VERSION`, `MONITOR_THRESHOLDS`,
  `deriveMachineStatus`, `isBacklogHigh`, `LiveMonitorSnapshot`, `emptyMonitorSnapshot`. Your new
  `alerts.ts` lives beside it and follows the exact same shape (typed thresholds `as const`, pure
  derivation functions, JSDoc citing PRD §). `LiveMonitorSnapshot` is the input to `deriveAlerts` and
  gains an `alerts` field here.
- `apps/ingest/src/routes/monitor.ts` (lines 32–51, `buildSnapshot`) — Why: where the snapshot is
  composed from the clock-free projections; you add `alerts: deriveAlerts(...)` here. Note D6 (the route
  owns the clock) and that `deriveMachineStatus`/`isBacklogHigh` are already applied per-machine here.
- `packages/db/src/repositories/projections.ts` (lines 158–176 `sessionAggregateColumns`,
  lines 259–285 `connectorHealth`) — Why: `connectorHealth` is the source of the per-connector row;
  you add a `toolCalls` aggregate. The `count(*) filter (where ... like 'tool.call.%')::int` idiom you
  need is **already written** in `sessionAggregateColumns.toolCalls` (line 168) — mirror it exactly.
- `packages/shared/src/projections.ts` (lines 60–67, `ConnectorHealthRow`) — Why: the wire type that
  gains `toolCalls: number`.
- `packages/shared/src/monitor.test.ts` (whole file) — Why: the **exact test idiom** for a pure shared
  module (fixed reference clock, deterministic cases, boundary tests with strict `>`). Your
  `alerts.test.ts` mirrors this.
- `packages/db/src/repositories/monitor.int.test.ts` (lines 1–40 for setup; whole file) — Why: the
  `describe.skipIf(!TEST_URL)` integration idiom, `TRUNCATE ... RESTART IDENTITY CASCADE` seed pattern,
  and how `machines`/`events` are seeded. You extend the `connectorHealth` int coverage (it lives in the
  projections int test — see below) to assert `toolCalls`.
- `apps/ingest/src/app.int.test.ts` (lines 975–1090, the "M9 Live Monitor" block) — Why: the
  end-to-end monitor round-trip test you extend with an `alerts` assertion. **GOTCHA:** lines ~1023 and
  ~1086 assert `body.monitorVersion === "m9-monitor-v1"` / `parsed.monitorVersion === "m9-monitor-v1"`
  — these MUST update to `"m10-monitor-v1"` when you bump the constant or the suite goes red.
- `apps/ingest/src/app.ts` (lines 56–67) — Why: route registration order; `monitorRoutes` is already
  registered (no new route needed — alerts ride the existing snapshot). Read only to confirm you do
  **not** need to register anything.
- `apps/dashboard/src/components/monitor/monitor-view.tsx` (whole file) — Why: the dashboard surface.
  You add an Alerts panel here, reusing the existing `Card`/`Badge`/`Table` primitives and the
  `STATUS_BADGE` color idiom. Note `formatAgo(iso, nowMs)` already exists for the `since` column.
- `packages/shared/src/index.ts` (lines 1–10) — Why: the barrel re-export pattern (`export * from
  "./monitor.js"`). Add `export * from "./alerts.js"`.
- `packages/db/src/index.ts` — Why: confirm `connectorHealth` is already exported (line 57). No change
  needed unless you add a new symbol (you don't).

### Connector-health projection int test — locate before editing

`connectorHealth` is exercised by an integration test in `packages/db`. **FIND it** before editing:
```
rg -l "connectorHealth" packages/db/src
```
(Expected: `packages/db/src/repositories/projections.int.test.ts` — read its `connectorHealth` case and
add a `toolCalls` assertion that matches the seeded `tool.call.*` events. If no `connectorHealth` case
exists, add one following the `monitor.int.test.ts` seed idiom.)

### New Files to Create

- `packages/shared/src/alerts.ts` — the pure alert taxonomy + `deriveAlerts`. **No imports except
  `import type { LiveMonitorSnapshot, MonitorStatus } from "./monitor.js"`** (keep `@420ai/shared`
  dependency-free and clock-free, exactly like `monitor.ts`).
- `packages/shared/src/alerts.test.ts` — co-located unit tests (always run; no infra).
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` — the dashboard Alerts panel component.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/PRD.md` §20 (Alerts) — the six V1 operational-alert conditions. This slice ships the subset
  derivable from M9 inputs *today*; the rest are deferred (see "Deferred conditions" below) — read §20 to
  understand what is intentionally not yet covered and why.
- `docs/PRD.md` §8.4, §10.1.1 — the Live Monitor surface + liveness levels ("last event N seconds ago").
- `docs/CONTEXT.md` — glossary. Name code after **"Operational Alert"** (vs the deferred "Efficiency
  Alert", a V1 non-goal). Do not invent new domain terms.
- `.agents/system-reviews/m7-m9-review.md` lines 197–204 — the explicit M10 forward-guidance: *reuse the
  heartbeat columns + `deriveMachineStatus` states as the alert engine's inputs — do not recompute
  liveness*. This slice obeys that literally (`deriveAlerts` reads `snapshot.machines[].status`, never
  re-parses timestamps).
- `.agents/plans/m9-live-monitor.md` — the immediately-prior plan; its D-rules (D3 "status is a state,
  the alert ENGINE is M10", D4 "depth not derivative", D6 "route owns the clock", D11 "version stamp")
  are the design contract this slice fulfills. Skim the D-rules section.

### Patterns to Follow

Follow the conventions in `CLAUDE.md` (linked as source of truth). The repo-specific ones that bite here:

**Pure shared modules** — `@420ai/shared` is dependency-free and clock-free. `deriveAlerts` takes a
fully-formed `LiveMonitorSnapshot` and returns derived data; it reads **no wall clock** (see the
divergence note below — this is *better* than the approved preview's `nowMs` param because the snapshot
is self-contained: `status` + `backlogHigh` + `generatedAt` are already on it).

**Library files never log/exit** (`CLAUDE.md` Logging/process boundaries) — `deriveAlerts` and
`connectorHealth` throw at most; they never `console.*` or `process.exit`.

**Drizzle gotchas** (`CLAUDE.md` Drizzle/SQL): the **only** new SQL here is a `count(*) filter (...)::int`
— a count cast to `::int` comes back as a **JS number** (no `numeric`→string wrap needed, no
timestamp normalization needed). This snippet touches **none** of the timestamp/`numeric` gotchas because
it adds no aggregate timestamp and no money column. (Stated explicitly to satisfy the plan-quality
checklist: this illustrative SQL obeys every gotcha it could touch.)

**Frontend workspace** (`CLAUDE.md` Frontend workspace) — `apps/dashboard` is **out of the root
`tsc -b`** graph. The new component is type-checked only by `npm run typecheck:dashboard` and built by
`build:dashboard`; the root `tsc -b` will NOT catch a dashboard type error. Reuse the **already
hand-written** `Card`/`Badge`/`Table` primitives in `components/ui/` — do **not** run `npx shadcn`
(this slice needs no new primitive).

**Additive shape change + version stamp (D11)** — adding `alerts` to `LiveMonitorSnapshot` is a shape
change, so bump `MONITOR_VERSION` `"m9-monitor-v1"` → `"m10-monitor-v1"`. Keep `emptyMonitorSnapshot`
in sync (`alerts: []`).

> **Spike-snippet fidelity / divergence from the approved preview:** the AskUserQuestion preview showed
> `deriveAlerts(snap, nowMs)`. **Drop `nowMs`** — the snapshot already carries the derived `status`,
> `backlogHigh`, and `generatedAt`, so alert derivation is a pure function of the snapshot alone and needs
> no second clock source. Carrying an unused `nowMs` would be dead surface. The `OperationalAlert` field
> set (`code`, `severity`, `message`, `machineId?`, `connector?`, `since`) matches the preview.

---

## DESIGN DECISIONS (resolve conflicts up front)

### Alert taxonomy — what ships in THIS slice

Four codes, all derivable from the M9 snapshot **today**:

| `code`              | `severity` | Trigger (from snapshot)                                   | `since` (evidence ts)            |
| ------------------- | ---------- | --------------------------------------------------------- | -------------------------------- |
| `collector.offline` | `critical` | `machine.status === "offline"`                            | `lastHeartbeatAt ?? lastSeenAt`  |
| `collector.stale`   | `warning`  | `machine.status === "stale"`                              | `lastHeartbeatAt ?? lastSeenAt`  |
| `sync.backlog_high` | `warning`  | `machine.backlogHigh === true`                            | `null` (depth, not a timestamp)  |
| `connector.failing` | `warning`  | `toolCalls ≥ minCalls && toolsFailed/toolCalls ≥ ratio`   | `connector.lastEventAt`          |

- One machine that is both `offline` AND `backlogHigh` yields **one** alert (`collector.offline`); a
  backlog alert for an offline machine is noise. Rule: **emit `sync.backlog_high` only when the machine
  is NOT offline.** (Stale + backlogHigh may both fire — both are actionable.)
- Output is **sorted critical-first, then warning, then info**, stable within a severity (machines in
  snapshot order, then connectors). A consumer can render top-down by urgency.
- `since` is the **timestamp of the triggering evidence**, NOT a firing-start. Because this slice is
  **stateless** (re-derived every snapshot), there is no persisted "alert opened at" history — that is
  the deferred persisted-engine slice. Document this in the JSDoc so no one mistakes `since` for a
  firing timestamp.

### `connector.failing` — honest limitation

`connectorHealth` is a **lifetime** aggregate (no time window), so `toolsFailed`/`toolCalls` is a
**lifetime failure ratio**, not "failing right now". This is the most defensible signal available without
adding a windowed projection. Thresholds (tunable, in `ALERT_THRESHOLDS`):
`connectorFailMinCalls: 5`, `connectorFailRatio: 0.5`. A connector with ≥5 tool calls and ≥50% of them
failed is genuinely misbehaving; it resolves as healthy calls dilute the ratio. **Deferred refinement:**
a recent-window failure rate (needs a time-bounded `connectorHealth` variant) — note it in the plan's
NOTES, do not build it here.

### Deferred conditions (PRD §20 items NOT in this slice — state why)

- **"sync backlog growing"** (a *derivative*, not depth) — needs heartbeat **history** (a time-series
  table + migration). M9 stores only the latest sample (D4). → deferred to the persisted-engine slice.
- **"ingest authentication failure"** — needs server-side 401 tracking (not in any current projection).
- **"Central Archive unreachable"** — a *collector-side* detection (the sync worker already sees ingest
  failures); surfacing it requires a collector→server signal. Approximated today by `collector.offline`
  (a machine that can't reach ingest stops heart-beating → goes offline).
- **"catalog update requires approval"** — depends on the **catalog signing** M10 slice (not built).

These four are explicitly out of scope; the plan must not silently imply §20 is fully covered.

---

## IMPLEMENTATION PLAN

### Phase 1: Shared alert taxonomy (pure, no deps)

Create the alert types + `deriveAlerts` + thresholds in `@420ai/shared`, mirroring `monitor.ts`.

### Phase 2: Snapshot integration

Extend `LiveMonitorSnapshot` with `alerts`, bump `MONITOR_VERSION`, keep `emptyMonitorSnapshot` in sync,
and add `toolCalls` to `ConnectorHealthRow` + the `connectorHealth` projection.

### Phase 3: Compose in the ingest route

Call `deriveAlerts` in `buildSnapshot` (and ensure the empty path carries `alerts: []`).

### Phase 4: Dashboard surface

Add the `AlertsPanel` and render it on `/monitor`.

### Phase 5: Testing & validation

Unit (`alerts.test.ts`), integration (`connectorHealth` `toolCalls`, end-to-end snapshot `alerts`,
version-stamp updates), then the full gate incl. `--require-db` and the dashboard lanes.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

### CREATE `packages/shared/src/alerts.ts`

- **IMPLEMENT**:
  - `export type AlertSeverity = "critical" | "warning" | "info";`
  - `export type AlertCode = "collector.offline" | "collector.stale" | "connector.failing" | "sync.backlog_high";`
  - `export const ALERT_VERSION = "m10-alerts-v1" as const;` (derivation-shape stamp, sibling of `MONITOR_VERSION`)
  - `export const ALERT_THRESHOLDS = { connectorFailMinCalls: 5, connectorFailRatio: 0.5 } as const;`
  - `export interface OperationalAlert { code: AlertCode; severity: AlertSeverity; message: string; machineId?: string; machineName?: string; connector?: string; since: string | null; }`
  - `export function deriveAlerts(snapshot: LiveMonitorSnapshot): OperationalAlert[]` — iterate
    `snapshot.machines`: push `collector.offline` (critical) when `status === "offline"`; else push
    `collector.stale` (warning) when `status === "stale"`; push `sync.backlog_high` (warning) when
    `backlogHigh && status !== "offline"`. Iterate `snapshot.connectors`: push `connector.failing`
    (warning) when `c.toolCalls >= ALERT_THRESHOLDS.connectorFailMinCalls && c.toolsFailed / c.toolCalls
    >= ALERT_THRESHOLDS.connectorFailRatio`. Then return a **stable severity sort**
    (`critical` < `warning` < `info`) — e.g. map severity→rank and `slice().sort((a,b)=>rank[a]-rank[b])`
    preserving insertion order for ties (Array.prototype.sort is stable in Node ≥ 24).
  - Human-readable `message`s, e.g. `Collector "${name}" is offline (no heartbeat for >5 min)`,
    `Collector "${name}" is stale (no heartbeat for >90 s)`,
    `Collector "${name}" sync backlog is high (${queuePending} pending)`,
    `Connector "${connector}" is failing (${toolsFailed}/${toolCalls} tool calls failed)`.
- **PATTERN**: `packages/shared/src/monitor.ts` — typed `as const` thresholds + pure functions + JSDoc
  citing PRD §20. Same file-level doc-comment style.
- **IMPORTS**: `import type { LiveMonitorSnapshot, MonitorStatus } from "./monitor.js";` ONLY.
- **GOTCHA**: NO `new Date()` / `Date.now()` anywhere (clock-free shared package). Guard the ratio
  divide-by-zero with the `minCalls` check (it already does — `toolCalls >= 5` precedes the divide).
- **VALIDATE**: `npx vitest run packages/shared/src/alerts.test.ts` (after the next task) and
  `npm run typecheck` (exit 0).

### UPDATE `packages/shared/src/monitor.ts`

- **IMPLEMENT**: (1) bump `export const MONITOR_VERSION = "m10-monitor-v1";`. (2) add
  `alerts: OperationalAlert[]` to `LiveMonitorSnapshot`. (3) add `alerts: []` to the object returned by
  `emptyMonitorSnapshot`. Add `import type { OperationalAlert } from "./alerts.js";`.
- **PATTERN**: the existing `LiveMonitorSnapshot` field order (put `alerts` after `machines`/`connectors`/
  `activeSessions` or right after `connectors` — keep it grouped with the other derived health data).
- **GOTCHA**: circular type import is fine (`alerts.ts` imports the snapshot type *from* `monitor.ts`,
  `monitor.ts` imports `OperationalAlert` *from* `alerts.ts`) — `import type` is erased at compile time,
  so there is no runtime cycle. Both must be `import type`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### UPDATE `packages/shared/src/index.ts`

- **IMPLEMENT**: add `export * from "./alerts.js";` next to the `export * from "./monitor.js";` line.
- **PATTERN**: existing barrel re-exports (lines 8–9).
- **VALIDATE**: `npm run typecheck` (exit 0).

### UPDATE `packages/shared/src/projections.ts` (`ConnectorHealthRow`)

- **IMPLEMENT**: add `toolCalls: number;` to the `ConnectorHealthRow` interface (place it next to
  `toolsFailed` so the failing-ratio numerator/denominator sit together).
- **PATTERN**: existing `ConnectorHealthRow` (lines 60–67).
- **VALIDATE**: `npm run typecheck` will now FAIL until the repo populates `toolCalls` (next task) —
  that's expected; validate after the repo task.

### UPDATE `packages/db/src/repositories/projections.ts` (`connectorHealth`)

- **IMPLEMENT**: add `toolCalls` to the `connectorHealth` select and the returned object:
  `toolCalls: sql<number>\`count(*) filter (where ${events.eventType} like 'tool.call.%')::int\`,`
  and `toolCalls: r.toolCalls,` in the `.map(...)`.
- **PATTERN**: **mirror exactly** the already-present idiom in `sessionAggregateColumns.toolCalls`
  (`projections.ts:168`) — same `like 'tool.call.%'` filter, same `::int` cast (→ JS number).
- **IMPORTS**: none new (`sql`, `events` already imported).
- **GOTCHA**: `tool.call.%` matches `started` + `completed` + `failed` (the denominator). `toolsFailed`
  is the `= 'tool.call.failed'` subset (the numerator) — do not change it. `::int` → number, so NO
  `Number()` wrap and NO timestamp coercion (this is a count, not a `numeric`/timestamp — obeys the
  `CLAUDE.md` Drizzle gotchas by construction).
- **VALIDATE**: `npm run typecheck` (exit 0 now — the shared interface is satisfied).

### UPDATE `apps/ingest/src/routes/monitor.ts` (`buildSnapshot`)

- **IMPLEMENT**: import `deriveAlerts` from `@420ai/shared`; in `buildSnapshot`, build the snapshot object
  first (machines/connectors/activeSessions/version/generatedAt) then set `alerts: deriveAlerts(snapshot)`
  — OR compute `const snapshot = {...}` then `return { ...snapshot, alerts: deriveAlerts(snapshot) }`.
  Cleanest: assemble the `machines` array (with `status`+`backlogHigh`) into a `const built`, then
  `return { ...built, alerts: deriveAlerts(built) }`. `MONITOR_VERSION` is already imported.
- **PATTERN**: `buildSnapshot` (lines 32–51). The route already owns the clock (D6) — `deriveAlerts`
  needs no clock, so nothing else changes.
- **GOTCHA**: `emptyMonitorSnapshot` (the no-user / unreachable path, lines 73 & 108) now returns
  `alerts: []` automatically (you set it in the shared helper) — no per-route change needed there. Verify
  the `LiveMonitorSnapshot` import still satisfies the return type.
- **VALIDATE**: `npm run typecheck` (exit 0).

### CREATE `apps/dashboard/src/components/monitor/alerts-panel.tsx`

- **IMPLEMENT**: a presentational component `export function AlertsPanel({ alerts }: { alerts:
  OperationalAlert[] })` rendering a `Card` titled "Alerts". When `alerts.length === 0`, show a muted
  "No active alerts." line (the healthy state). Otherwise a `Table` with columns:
  Severity (a `Badge` colored by severity), Alert (the `message`), Scope (`machineName ?? connector ??
  "—"`), Since (`formatAgo(since, nowMs)` — pass `nowMs` as a prop, mirroring `MonitorView`). Define a
  `SEVERITY_BADGE: Record<AlertSeverity, string>` map mirroring `STATUS_BADGE` in `monitor-view.tsx`
  (`critical` → destructive red, `warning` → amber, `info` → muted/blue).
- **PATTERN**: `apps/dashboard/src/components/monitor/monitor-view.tsx` — reuse `Card`/`CardHeader`/
  `CardTitle`/`CardContent`, `Badge`, `Table*`, `cn`, and copy the `formatAgo` usage. Same Tailwind
  class idioms.
- **IMPORTS**: `import type { OperationalAlert, AlertSeverity } from "@420ai/shared";` + the same UI
  primitive imports `monitor-view.tsx` uses (`@/components/ui/card`, `@/components/ui/badge`,
  `@/components/ui/table`, `@/lib/utils`).
- **GOTCHA**: this file is **only** checked by `typecheck:dashboard` / `build:dashboard`, never the root
  `tsc -b` (Frontend-workspace rule). Run those lanes explicitly. Do NOT add a new shadcn primitive.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0).

### UPDATE `apps/dashboard/src/components/monitor/monitor-view.tsx`

- **IMPLEMENT**: import `AlertsPanel`; render `<AlertsPanel alerts={snapshot.alerts} nowMs={nowMs} />`
  **above** the fleet-summary grid (alerts are the most urgent surface → top of the page). Optionally add
  a critical-count to the existing summary `DataCard`s (e.g. status `alert` when any critical alert) —
  keep this minimal; the panel is the deliverable.
- **PATTERN**: existing component composition in `MonitorView` (it already destructures `snapshot` and
  receives `nowMs`).
- **GOTCHA**: `snapshot.alerts` is now always present (shared type guarantees it); no optional-chaining
  needed. If the dashboard has a stale cached `LiveMonitorSnapshot` type, rebuild `@420ai/shared`
  (`npm run typecheck` at root) so the dashboard's `@420ai/shared` resolution sees `alerts`.
- **VALIDATE**: `npm run typecheck:dashboard` && `npm run build:dashboard` (both exit 0).

### CREATE `packages/shared/src/alerts.test.ts`

- **IMPLEMENT**: deterministic unit tests for `deriveAlerts` using a hand-built `LiveMonitorSnapshot`
  fixture (no clock). Cases:
  - empty snapshot → `[]`.
  - one `offline` machine → exactly one `collector.offline` (critical); `since` === its
    `lastHeartbeatAt`.
  - one `stale` machine with `backlogHigh: true` → `collector.stale` AND `sync.backlog_high` (both
    warning).
  - one `offline` machine with `backlogHigh: true` → ONLY `collector.offline` (backlog suppressed when
    offline).
  - connector with `toolCalls: 10, toolsFailed: 6` → `connector.failing`; with `toolCalls: 10,
    toolsFailed: 2` → none; with `toolCalls: 3, toolsFailed: 3` → none (below `minCalls`).
  - ordering: a snapshot with a stale machine (warning) listed before an offline machine (critical) →
    output has the `critical` first.
- **PATTERN**: `packages/shared/src/monitor.test.ts` — `describe`/`it`/`expect`, fixed constants, no real
  `new Date()`. Build the fixture with `emptyMonitorSnapshot("2026-06-15T12:00:00.000Z")` then push
  machine/connector rows (or spread a literal).
- **GOTCHA**: the machine rows in the fixture must include `status` + `backlogHigh` (the snapshot's
  machines are `MachineStatusRow & { status; backlogHigh }`) — `deriveAlerts` reads those, not raw
  timestamps. Connector rows need the new `toolCalls`.
- **VALIDATE**: `npx vitest run packages/shared/src/alerts.test.ts` (all pass).

### UPDATE the `connectorHealth` integration test (`packages/db/src/repositories/projections.int.test.ts`)

- **IMPLEMENT**: in the existing `connectorHealth` case, seed at least one `tool.call.started`/
  `tool.call.completed`/`tool.call.failed` event and assert the returned row's `toolCalls` equals the
  count of `tool.call.*` events (and that `toolsFailed` is the failed subset). If no `connectorHealth`
  case exists, add one using the `monitor.int.test.ts` seed idiom.
- **PATTERN**: `packages/db/src/repositories/monitor.int.test.ts` seed/`TRUNCATE` idiom;
  `describe.skipIf(!process.env.DATABASE_URL_TEST)`.
- **GOTCHA**: this is a `*.int.test.ts` — excluded from `tsc -b`, type-stripped by vitest. It SELF-SKIPS
  without `DATABASE_URL_TEST`; it only proves anything under `--require-db` (see validation).
- **VALIDATE**: `npm run repo-health -- --require-db` (the int layer runs, 0 skipped).

### UPDATE `apps/ingest/src/app.int.test.ts` (M9 Live Monitor block, lines ~975–1090)

- **IMPLEMENT**: (1) update the two `monitorVersion` assertions from `"m9-monitor-v1"` →
  `"m10-monitor-v1"` (lines ~1023, ~1086). (2) in the round-trip test (~977), after asserting the online
  machine, assert `Array.isArray(body.alerts)` and, given the seeded fresh heartbeat, assert
  `body.alerts` does NOT contain a `collector.offline` for that machine (it's online). Add one focused
  case OR extend an existing one: seed a machine whose heartbeat is far in the past (e.g. via
  `recordHeartbeat` with an injected old `now`, or by not heart-beating) → assert a `collector.offline`
  alert appears. **Keep it deterministic** — the route reads the real wall clock (D6), so use a heartbeat
  timestamp comfortably older than `MONITOR_THRESHOLDS.offlineMs` (5 min).
- **PATTERN**: the existing M9 block (it already does `POST /v1/heartbeat` then `GET /v1/monitor` and
  inspects `body.machines[...]`).
- **GOTCHA**: `recordHeartbeat`'s `hb.now` is injectable (`machines.ts:40`) — use it to seed an old
  heartbeat deterministically rather than sleeping. The route's `generatedAt` is real-now, so an old
  injected heartbeat reliably yields `offline`.
- **VALIDATE**: `npm run repo-health -- --require-db` (this test is `app.int.test.ts` — runs under the
  DB gate).

### UPDATE `SUMMARY.md` (status + milestone line)

- **IMPLEMENT**: mark M10's operational-alerts slice as in-progress/done in §0 status and the milestone
  list (line ~10 says "M10 (hardening) remains"). Note the slice shipped as a stateless derived
  projection and that exports/catalog-signing/replay-metadata remain. Keep the existing forward-guidance
  reference.
- **PATTERN**: the existing SUMMARY status prose (already modified in the working tree for the M9 merge).
- **VALIDATE**: NUL/artifact scan in `repo-health` (docs are scanned); no code impact.

---

## TESTING STRATEGY

### Unit Tests (`*.test.ts`, always run — no infra)

- `packages/shared/src/alerts.test.ts` — the core logic. Pure-function table-driven cases for all four
  codes, the offline-suppresses-backlog rule, the connector ratio thresholds (including the divide-by-zero
  guard via `minCalls`), and the critical-first ordering. This is where ~all alert behavior is proven —
  it needs no DB and runs in `npm test`.

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST`)

- `packages/db/.../projections.int.test.ts` — `connectorHealth` returns a correct `toolCalls` count over
  seeded `tool.call.*` events (the new denominator).
- `apps/ingest/src/app.int.test.ts` — the snapshot served by `GET /v1/monitor` carries `alerts`, an
  offline machine produces a `collector.offline` alert, an online machine does not, and the
  `monitorVersion` is `m10-monitor-v1`. SSE stream still parses (version assertion updated).

### Edge Cases (must be covered)

- Machine that is offline AND backlogHigh → exactly one alert (`collector.offline`).
- Connector with 0 tool calls → no `connector.failing` (no divide-by-zero).
- Connector with failures but `< minCalls` total → no alert.
- Empty snapshot (no machines/connectors) → `alerts: []`.
- `emptyMonitorSnapshot` (no-user / ingest-unreachable path) → `alerts: []`, version `m10-monitor-v1`.
- Stale machine → `collector.stale` (warning), never `collector.offline`.

---

## VALIDATION COMMANDS

All commands run from the **repo root**. Each is a GATE.

### Level 1: Syntax & Types (repo-root build — catches cross-project/test-only imports)

- `npm run typecheck` → **exit 0** (root `tsc -b`; the four backend workspaces).
- `npm run typecheck:dashboard` → **exit 0** (the dashboard's enforced lane — root `tsc -b` will NEVER
  catch its type errors).

### Level 2: Unit Tests

- `npx vitest run packages/shared/src/alerts.test.ts` → all pass (focused).
- `npm test` → full `vitest run`; units always run, int self-skips. **Must be green.**

### Level 3: Integration Tests (the DB-backed layer must ACTUALLY run)

- `npm run db:up && npm run db:migrate` (no new migration this slice — `db:migrate` is a no-op past 0003,
  but run it to confirm the schema is current).
- `npm run repo-health -- --require-db` → **PASS, and the `*.int.test.ts` layer ran with 0 skipped.**
  A plain `repo-health` PASS is NOT sufficient (skipped ≠ passed) — this slice touches `@420ai/db`
  (`connectorHealth`) and `apps/ingest`, so the int layer must be exercised (`CLAUDE.md` "Validation is a
  GATE"). This is the milestone sign-off gate.

### Level 4: Manual / Visual Validation

- `npm run build:dashboard` → **exit 0** (also catches theGridCN barrel breakage; gates milestone
  sign-off per the Frontend-workspace rule).
- Run ingest + dashboard locally (`npm run ingest:dev`, `npm run dashboard:dev` with
  `ADMIN_TOKEN`/`INGEST_URL` in `apps/dashboard/.env.local`), open `/monitor`, and confirm: with a fresh
  heartbeat → "No active alerts."; stop heart-beating (or seed an old heartbeat) → a red
  `collector.offline` row appears at the top. **Screenshot evidence**: the gstack `browse`/`agent-browser`
  daemon is unreliable on this Windows host — use headless Edge:
  `"$EDGE" --headless=new --disable-gpu --screenshot="<abs>.png" http://localhost:3000/monitor` (see
  `CLAUDE.md` Tooling gotchas), and assert the rendered HTML contains the alert text.
- **Token-leak assertion (carried from M9 D8)**: `grep -c "$ADMIN_TOKEN"` on the served `/monitor` HTML
  == 0 (the browser never holds the admin token; alerts ride the same server-side proxy).

### Level 5: Code-review gate (separate layer — typecheck+tests miss robustness)

- `npm run repo-health` is green AND run `/lril:code-review` before commit. This slice adds **no**
  long-lived resource (no timer/stream/listener — `deriveAlerts` is pure), so the M9 SSE-leak class does
  not apply; still run the review to catch ordering/severity-logic and dashboard render issues.

---

## ACCEPTANCE CRITERIA

- [ ] `deriveAlerts` emits the four alert codes per the taxonomy table, with correct severities and the
      offline-suppresses-backlog rule.
- [ ] Alerts are sorted critical-first (stable within severity).
- [ ] `LiveMonitorSnapshot.alerts` is populated by `GET /v1/monitor` and rides the SSE stream;
      `emptyMonitorSnapshot` carries `alerts: []`.
- [ ] `MONITOR_VERSION === "m10-monitor-v1"` everywhere (constant + both test assertions).
- [ ] `ConnectorHealthRow.toolCalls` is populated by `connectorHealth` (count of `tool.call.*`), proven by
      an int test.
- [ ] The `/monitor` dashboard renders an Alerts panel (healthy → "No active alerts."; offline → a red
      `collector.offline` row at the top).
- [ ] `npm run typecheck`, `npm run typecheck:dashboard`, `npm test`, `npm run build:dashboard` all exit 0.
- [ ] `npm run repo-health -- --require-db` PASSES with the int layer run, **0 skipped**.
- [ ] No new npm dependency, no DB migration, no long-lived resource introduced.
- [ ] `/lril:code-review` run before commit; findings addressed.
- [ ] `SUMMARY.md` updated to reflect the shipped slice.

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] Full gate green incl. `--require-db` (int layer exercised, 0 skipped).
- [ ] Dashboard typecheck + build lanes green; visual evidence captured.
- [ ] Token-leak assertion holds (0 occurrences in served HTML).
- [ ] Code-review pass complete.
- [ ] Deferred §20 conditions documented (not silently implied as covered).

---

## NOTES

**Why stateless / no table (the decided trade-off).** An alert here is a re-derivable projection over the
M9 snapshot — consistent with the repo's "events disposable / projections re-derivable" invariant, and it
introduces no migration and no long-lived dispatcher (the M9 review flags a dispatcher as a resource
needing teardown + idempotency design). The cost is **no firing history / acknowledgement / notification
delivery** — `since` is evidence-time, not a firing-start. That richer **persisted alert engine**
(a `machine_heartbeats` time-series table for "backlog growing", an `alerts` firing/resolved table with
ack, and a background evaluator) is the natural **second** M10 slice, and is where the m7-m9 review's
heartbeat-history + dispatcher guidance applies. This slice deliberately defers it.

**`deriveAlerts` takes no clock.** Divergence from the AskUserQuestion preview (`deriveAlerts(snap,
nowMs)`): the snapshot is self-contained (carries `status`, `backlogHigh`, `generatedAt`), so no second
clock is needed. The `OperationalAlert` field set matches the preview.

**`connector.failing` is a lifetime ratio**, not a recent-window rate — the honest limit of the current
`connectorHealth` aggregate. A windowed failure-rate projection is a deferred refinement; do not build it
in this slice.

**Deferred PRD §20 conditions** (with reasons): "sync backlog growing" (needs heartbeat history),
"ingest authentication failure" (needs 401 tracking), "Central Archive unreachable" (collector-side
signal; approximated by `collector.offline`), "catalog update requires approval" (needs the catalog-
signing slice). The plan ships the derivable-today subset and says so.

**Confidence: 9/10** for one-pass success. The pattern is a direct clone of an existing, recently-shipped
M9 module (`monitor.ts` + `connectorHealth` + `MonitorView`), there are no new dependencies/migrations/
external tooling, and the one cross-cutting ripple (the `MONITOR_VERSION` bump touching two test
assertions) is called out explicitly. The −1 is the lifetime-ratio judgement call on `connector.failing`
thresholds, which may need a tuning pass against real data.
