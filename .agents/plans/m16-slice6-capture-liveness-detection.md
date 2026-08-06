# Feature: M16 Slice 16.6 — Capture-liveness detection (INC-2026-07)

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing.

Pay special attention to the naming of existing utils, types and models. Import from the right files.

Conventions are NOT re-pasted here — they are in [`CLAUDE.md`](../../CLAUDE.md) (the single source of
truth), with background in [`SUMMARY.md`](../../SUMMARY.md) and the milestone plan
[`m16-dogfood-instrumentation.md`](./m16-dogfood-instrumentation.md). Read the CLAUDE.md sections on
**long-lived resources**, **logging / process boundaries**, **testing**, and **validation is a GATE**
before writing code.

## Feature Description

Close the **detection gap** that INC-2026-07 exposed: capture ran dead for ~8 days with 159,828 queue
items stranded against an archive holding zero raw records, and **nothing reported it**. This slice
makes the archive evaluate its own alerts on a timer instead of only when a human opens the dashboard,
and makes the collector loud — locally and durably — when the archive rejects its credential.

SUMMARY.md §0 records this as the one un-actioned finding of the M16 pre-sign-off pass: _"the
**detection** gap earns a slice."_ This is that slice.

## User Story

As the sole operator running a 24-week dogfood research period
I want to be told when capture stops working, without having to suspect it first
So that the research data I am about to draw conclusions from cannot silently rot for 8 days again

## Problem Statement

INC-2026-07 had **three independent causes**, each sufficient on its own to produce total silence.
All three were confirmed by reading the code during planning, not inferred:

1. **No background evaluator.** `reconcileAlertFirings` and `deliverPendingFirings` are called ONLY
   from inside `GET /v1/monitor` (`apps/ingest/src/routes/monitor.ts:127-190`). M10 3c chose
   evaluate-on-read with "no background dispatcher" — a deliberate, documented decision whose
   consequence was never written down: **the trigger for evaluating alerts is a human opening the
   dashboard, and a human has no reason to do that when they believe things are fine.** This made
   *every one of the nine alert codes* undeliverable for the whole incident, not just one.
2. **`collector watch` exits 0 on a fatal 401.** `apps/collector/src/cli.ts:644` calls
   `process.exit(0)` unconditionally after `runWatch` returns, and a revoked-token 401 makes the
   engine unwind and return *normally*. The one-shot sibling `collector sync` gets this right
   (`cli.ts:653-663`: outcome `"stop"` → stderr + `process.exitCode = 1`, citing lesson **C.11**).
   The lesson was learned for the command a human watches and never carried to the daemon that runs
   unattended for weeks. It compounds with `apps/collector/service/420ai-collector.xml`, whose
   `<onfailure action="restart"/>` fires only on **non-zero** exit: exit 0 reads as a deliberate stop,
   so WinSW does not restart and Windows Service Manager shows "Stopped" with no failure recorded.
   Windows' own supervisor was standing right there and was told everything was fine.
3. **A deleted machine row emits no alerts.** `deriveAlerts` iterates `snapshot.machines`
   (`packages/shared/src/alerts.ts:92`). The DB reset removed the row, so there was nothing to be
   `offline`. Absence is not a state the projection can represent.

The evidence existed the entire time: `apps/ingest/src/plugins/auth.ts:127` writes an
`ingest_auth_failures` row on every unknown token, and `deriveAuthFailureAlerts`
(`alerts.ts:244`) fires a **global** `ingest.auth_failure` at ≥3 failures in 15 minutes. Both the data
and the derivation were correct and present. Only the *trigger* was missing.

## Solution Statement

Three additive changes and one document row. **No migration, no new table, no new alert code.**

- **A) Server-side background evaluator.** An opt-in Fastify plugin that, on an interval, loops
  `listOrganizations` → `withOrg(…, SERVICE_ROLE, …)` → derives alerts → reconciles → delivers. Uses
  the org's **owner** membership as the reconcile user so its firings collide with (rather than
  duplicate) the dashboard's. This alone repairs delivery for all nine alert codes.
- **B) Collector-side durable fault.** A fatal 401 writes `~/.420ai/fault.json`, makes `collector
  watch` exit **non-zero**, and makes `serve.ts` emit a control-protocol `error` event. The collector
  is the only party with memory that survives a server-side DB reset — `credentials.json` and
  `queue.sqlite` sat there holding 159,828 items the whole time.
- **C) Delivery.** No new code. Once (A) runs, the existing M13 13.5 SMTP + webhook fan-out delivers.
  This slice only *proves* it with a test.
- **D) Weekly scorecard row.** A detection line in `.agents/research/weekly/TEMPLATE.md` so the four
  scorecards still owed would surface a silent-capture week.

### Why NOT an expected-machine registry (decision D-16.6-1)

The slice was scoped with one, and planning retired it. **A server-side registry lives in the same
Postgres that was reset**, so its rows die with the machine rows and it cannot detect the event it
exists for. Where the machine row *does* survive, `machines.status = 'active'` plus `collector.offline`
already encode "a machine we expected to hear from has gone quiet" — a derivation that works today
(pinned at `apps/ingest/src/app.int.test.ts:1078`) and merely never ran. A new table would therefore be
redundant in the case it can handle and absent in the case it was wanted for. The durable
"expected to report" fact belongs on the collector (workstream B), which is where memory actually
survives.

## Feature Metadata

**Feature Type**: Enhancement (defect-driven; closes an incident gap)
**Estimated Complexity**: Medium
**Primary Systems Affected**: `apps/ingest` (new plugin + server wiring), `apps/collector`
(`identity.ts`, `capture-engine.ts`, `cli.ts`, `serve.ts`), `.agents/research/weekly/`
**Dependencies**: None new. No migration. No new npm package.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Server side (workstream A)**

- `apps/ingest/src/routes/monitor.ts` (lines 46-205) — Why: `buildSnapshot` + `deliverFirings` are the
  exact composition the evaluator must reproduce. Read the M15 15.4 comment block at lines 61-68 and
  176-181: it explains why both take `SERVICE_ROLE` and not `principal.role`, which is the same
  reasoning the evaluator depends on (a tick has no principal at all).
- `apps/ingest/src/app.ts` (lines 66-200) — Why: `BuildAppOptions` + the `app.decorate` block. The
  new interval option follows the `monitorStreamIntervalMs` / `reconcileThrottleMs` / `alertDeliverer`
  opt-in shape exactly — omitted ⇒ disabled ⇒ no existing test changes.
- `apps/ingest/src/server.ts` (lines 42-80) — Why: `parsePositiveInt` and the env-reading pattern the
  new `ALERT_EVALUATOR_INTERVAL_MS` must follow.
- `packages/db/src/repositories/organizations.ts` (lines 75-88) — Why: `listOrganizations` and, in its
  doc comment, the **already-documented precedent** for exactly this loop: _"they LOOP:
  `listOrganizations` then one `withOrg` pass per org"_. Also states `organizations` carries no RLS
  (D-15.3-4), which is why the tick can read it from the unwrapped app-role handle.
- `packages/db/src/repositories/members.ts` (lines 40-72) — Why: `MemberRow` (`userId`/`email`/`role`/
  `joinedAt`) + `listMembers(db, orgId)`, oldest membership first. Source of the owner userId.
- `packages/db/src/org-context.ts` (lines 50-85) — Why: `withOrg(db, orgId, role, fn)` — exact
  signature, plus why a blank org or role throws.
- `packages/db/src/repositories/alert-firings.ts` (lines 93-107, 164-169, 258-266, 315-323) — Why:
  exact signatures of `reconcileAlertFirings` / `listAlertFirings` / `deliverPendingFirings` /
  `deliverResolvedFirings`. Note the argument ORDER differs between the reconcile pair
  `(db, orgId, userId, …)` and the deliver pair `(db, orgId, role, userId, …)`.
- `packages/db/src/schema.ts` (lines 980-988) — Why: `alert_firings_open_key` is
  `uniqueIndex().on(userId, alertKey).where(status = 'open')`. **This is the load-bearing fact for the
  whole evaluator design** — see the GOTCHA on Task A3.
- `packages/shared/src/alerts.ts` (whole file, ~330 lines) — Why: all nine derive functions and which
  inputs each needs. `deriveAlerts` is FROZEN (D2); the evaluator composes it, never edits it.
- `apps/ingest/src/delivery.int.test.ts` (lines 1-125) — Why: **the exact test harness to mirror** —
  `seedBootstrapKey`, the spy `deliverer`, the TRUNCATE list, `pairMachine()`, and
  `reconcileThrottleMs: 0`. Confirmed present during planning.

**Collector side (workstream B)**

- `apps/collector/src/capture-engine.ts` (lines 312-344) — Why: the `onStop` handler at line 336 is
  the single place that knows a fatal 401 happened. The `onFatal` callback hooks in here.
- `apps/collector/src/sync/sync-worker.ts` (lines 45-81, 166-192) — Why: `syncOnce` returns `"stop"`
  on 401 (`isUnauthorized`), and `runSyncLoop` calls `onStop` then returns `"stop"`. Do not change
  either — this slice only observes them.
- `apps/collector/src/identity.ts` (lines 17-104) — Why: the exact pattern the fault file mirrors —
  `collectorHomeFor` / `credentialsPathFor` / `queuePathFor`, and `saveCredentials` /
  `loadCredentials` (tolerant read, `mkdirSync(dirname)`, `mode: 0o600`).
- `apps/collector/src/cli.ts` (lines 200-215, 267-288, 633-666) — Why: `RunWatchOptions.runEngine?:
  typeof runCaptureEngine` (line 206) is the injection seam that forbids changing
  `runCaptureEngine`'s RETURN type; line 644 is the `process.exit(0)` defect; lines 653-663 are the
  correct C.11 pattern to copy.
- `apps/collector/src/serve.ts` (lines 205-265) — Why: `startEngine`'s `.then()` already sets
  `state = "error"` when the engine ends on its own. This slice adds the *reason*.
- `packages/shared/src/control-protocol.ts` (lines 85-102) — Why: `ControlEvent` already has
  `{ type: "error"; message: string; cmd?: string }`. Reusing it means **no protocol version bump** and
  no Tauri-side change (see GOTCHA on Task B4).
- `apps/collector/service/420ai-collector.xml` — Why: `<onfailure action="restart"/>` semantics that
  make the non-zero exit load-bearing.

**Docs**

- `.agents/research/weekly/TEMPLATE.md` — Why: the "Capture health" block the new detection row joins,
  and its "RECORD UNKNOWN VALUES EXPLICITLY" rule.

### New Files to Create

- `apps/ingest/src/alert-evaluator.ts` — the pure-ish evaluator: derive + reconcile + deliver for ONE
  org. Exported so tests call it directly with no timer.
- `apps/ingest/src/plugins/alert-evaluator.ts` — the Fastify plugin owning the `setInterval` and its
  `onClose` teardown.
- `apps/ingest/src/alert-evaluator.int.test.ts` — integration proof (two-role aware; see Testing).
- `apps/collector/src/fault.ts` — durable local fault record (`~/.420ai/fault.json`).
- `apps/collector/src/fault.test.ts` — unit tests (no infra).

### Relevant Documentation

- [Fastify `onClose` hook](https://fastify.dev/docs/latest/Reference/Hooks/#onclose)
  - Section: Application Hooks → onClose
  - Why: the ONLY correct teardown point for the interval; `app.close()` in `afterAll` must stop it or
    vitest hangs.
- [Fastify decorators](https://fastify.dev/docs/latest/Reference/Decorators/)
  - Section: decorate / TypeScript declaration merging
  - Why: matches how `reconcileThrottleMs` / `alertDeliverer` are already declared in `app.ts`.
- [WinSW `onfailure`](https://github.com/winsw/winsw/blob/master/docs/xml-config-file.md#onfailure)
  - Section: onfailure
  - Why: confirms restart triggers on unexpected (non-zero) termination only — the fact that makes
    Task B3 load-bearing.
- [Node `process.exitCode`](https://nodejs.org/api/process.html#processexitcode)
  - Why: prefer setting `exitCode` over `process.exit(n)` where a graceful flush must still happen.

### Patterns to Follow

**Opt-in option (mirrors `alertDeliverer` in `app.ts:107`)** — omitted ⇒ feature off ⇒ zero existing
callers change and no test opens a timer:

```ts
/** M16 16.6 background alert-evaluator cadence (ms). Omitted/0 → DISABLED (no timer).
 *  Only server.ts passes a real value; every test caller leaves it off. */
alertEvaluatorIntervalMs?: number;
```

**Long-lived resource (CLAUDE.md rule — teardown armed before any await)**:

```ts
const timer = setInterval(() => { void tick(); }, intervalMs);
timer.unref?.();                       // never hold the process open on its own
app.addHook("onClose", async () => { clearInterval(timer); });
```

**Library/entrypoint boundary (CLAUDE.md)** — `alert-evaluator.ts` NEVER logs or exits; it takes an
`onError` callback, exactly as `deliverFirings` in `routes/monitor.ts:190` passes `(e) => app.log.error(e)`.

**Tolerant local-state file (mirrors `loadCredentials`, `identity.ts:88-95`)**:

```ts
export function loadFault(path = FAULT_PATH): CaptureFault | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as CaptureFault; } catch { return undefined; }
}
```

> **Spike-snippet fidelity.** The evaluator snippet in Task A1 is transcribed from the spike that was
> RUN during planning (output in NOTES). Its assertions were: (i) a `collector.offline` firing is
> delivered exactly once with **no HTTP request**; (ii) a subsequent `GET /v1/monitor` yields exactly
> **one** open firing and **zero** further deliveries; (iii) two consecutive ticks are idempotent. If
> your implementation diverges from the snippet, re-run those three assertions before proceeding.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the evaluator as a plain function

Extract the reconcile+deliver composition into a testable function with no timer and no Fastify. This
is the whole design; the timer is trivia layered on top.

### Phase 2: Core — the plugin, the interval, the env wiring

Own the `setInterval` in a plugin with `onClose` teardown; wire an opt-in option through `buildApp`
and a real value through `server.ts`.

### Phase 3: Collector — durable fault, non-zero exit, tray surfacing

Make a fatal 401 leave evidence that survives both the process and a server-side DB reset.

### Phase 4: Testing, docs & validation

Integration proof that delivery happens with no dashboard GET; unit proof of the fault file; the
weekly-scorecard row; the full gate with `--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### CREATE `apps/ingest/src/alert-evaluator.ts`

- **IMPLEMENT**: `evaluateOrgAlerts(deps)` — for ONE org: open a `withOrg(db, orgId, SERVICE_ROLE, …)`
  transaction, run the same reads `buildSnapshot` runs, compose the same derive calls, call
  `reconcileAlertFirings`; then, OUTSIDE the transaction, call `deliverPendingFirings` and
  `deliverResolvedFirings`. Also export `runEvaluatorTick(deps)` which loops `listOrganizations` and
  resolves each org's reconcile user via `listMembers` → first `role === "owner"`, falling back to the
  first member; skip orgs with no members.
- **PATTERN**: `apps/ingest/src/routes/monitor.ts:70-145` (`buildSnapshot`) and `:183-205`
  (`deliverFirings`). Reproduce the composition; do NOT export/refactor the route's private function
  — the route keeps its throttle and principal handling, which the tick has neither of.
- **IMPORTS**:
  ```ts
  import {
    listOrganizations, listMembers, machineStatuses, connectorHealth, connectorHealthWindowed,
    recentBacklogSamples, countPendingCatalogs, countRecentAuthFailures, activeSessions,
    reconcileAlertFirings, deliverPendingFirings, deliverResolvedFirings, withOrg, type Db,
  } from "@420ai/db";
  import {
    deriveAlerts, deriveBacklogTrendAlerts, deriveCatalogAlerts, deriveAuthFailureAlerts,
    deriveArchiveUnreachableAlerts, deriveConnectorFailureRateAlerts, sortAlerts,
    deriveMachineStatus, isBacklogHigh, SERVICE_ROLE, MONITOR_VERSION, ACTIVE_WINDOW_MS,
    BACKLOG_TREND_WINDOW_MS, AUTH_FAILURE_ALERT, CONNECTOR_RATE_ALERT,
    type AlertFiring, type LiveMonitorSnapshot,
  } from "@420ai/shared";
  ```
- **GOTCHA**: The reads inside `withOrg` must be **sequential `await`s, never `Promise.all`** — a
  transaction is ONE connection and node-postgres emits the `client.query() while already executing`
  deprecation (removed in pg@9). This is stated verbatim at `routes/monitor.ts:81-86`; the evaluator
  inherits it.
- **GOTCHA**: `deliverPendingFirings` / `deliverResolvedFirings` take the **unwrapped `db`**, not the
  `tx`, and open their own short `withOrg` transactions internally — see the M15 15.3 note at
  `routes/monitor.ts:170-174`. Wrapping them would pin a connection across the SMTP/webhook network
  hop, restoring exactly the leak that comment describes.
- **GOTCHA**: `countRecentAuthFailures(db, since)` takes **no `orgId`** — it is deliberately global
  (`packages/db/src/repositories/auth-failures.ts:37`). Do not add one; the auth failure that matters
  here is by definition from a machine no org can claim.
- **VALIDATE**: `npm run typecheck`

Reference shape (transcribed from the planning spike — see NOTES):

```ts
export interface EvaluatorDeps {
  db: Db;
  deliverer: { deliver(f: AlertFiring): Promise<void> } | null;
  now: Date;                        // injected clock (repo convention: caller owns the clock)
  onError: (e: unknown) => void;    // library file — never logs itself
}

export async function evaluateOrgAlerts(
  deps: EvaluatorDeps, orgId: string, userId: string,
): Promise<number> {
  const nowMs = deps.now.getTime();
  const alerts = await withOrg(deps.db, orgId, SERVICE_ROLE, async (tx) => {
    const machines = await machineStatuses(tx, orgId);          // sequential — one connection
    const machineRows = machines.map((m) => ({
      ...m,
      status: deriveMachineStatus(m, nowMs),
      backlogHigh: isBacklogHigh(m.queuePending),
    }));
    const built: LiveMonitorSnapshot = {
      monitorVersion: MONITOR_VERSION,
      generatedAt: deps.now.toISOString(),
      machines: machineRows, connectors: [], activeSessions: [], alerts: [], alertFirings: [],
    };
    const derived = sortAlerts([ ...deriveAlerts(built) /* + the five siblings */ ]);
    await reconcileAlertFirings(tx, orgId, userId, derived, deps.now);
    return derived;
  });
  // OUTSIDE the tx — these open their own short withOrg transactions (15.3).
  await deliverPendingFirings(deps.db, orgId, SERVICE_ROLE, userId, deps.deliverer, deps.now, deps.onError);
  await deliverResolvedFirings(deps.db, orgId, SERVICE_ROLE, userId, deps.deliverer, deps.now, deps.onError);
  return alerts.length;
}
```

### UPDATE `apps/ingest/src/alert-evaluator.ts` — complete the alert set

- **IMPLEMENT**: Fill the `/* + the five siblings */` placeholder with the remaining derive calls so
  the tick evaluates the SAME nine codes the dashboard does: `deriveBacklogTrendAlerts(machineRows,
  samplesByMachine)`, `deriveCatalogAlerts(pendingCatalogs)`,
  `deriveArchiveUnreachableAlerts(machineRows)`, `deriveAuthFailureAlerts(authFailureCount)`,
  `deriveConnectorFailureRateAlerts(windowedConnectors)` — with the same window inputs
  `buildSnapshot` computes at `routes/monitor.ts:77-100`.
- **PATTERN**: `routes/monitor.ts:119-126` — copy the merge list verbatim, including `sortAlerts`.
- **GOTCHA**: **A tick that derives FEWER codes than the dashboard silently RESOLVES the missing
  ones.** `reconcileAlertFirings` resolves every open firing whose key is not in the derived set
  (`alert-firings.ts:93-99`, D5). So an evaluator that skips, say, `connector.failure_rate` would
  close that firing every 60 s and the dashboard would re-open it — flapping, plus a resolve email
  each cycle. The nine-code list is not padding; it is a correctness requirement.
- **GOTCHA**: `activeSessions` is NOT needed for any alert. Pass `[]` on the snapshot rather than
  running the query — it is the most expensive read in `buildSnapshot` and nothing derives from it.
  State this in a comment so nobody "completes the pattern" later.
- **VALIDATE**: `npm run typecheck`

### CREATE `apps/ingest/src/plugins/alert-evaluator.ts`

- **IMPLEMENT**: A `fastify-plugin` that, when `app.alertEvaluatorIntervalMs > 0`, starts a
  `setInterval` calling `runEvaluatorTick`. Guard re-entrancy with an `inFlight` boolean (a slow tick
  must not overlap the next). Clear the interval in `app.addHook("onClose", …)`.
- **PATTERN**: `apps/ingest/src/plugins/auth.ts` for the `fp(async function …)` shape; the SSE route
  in `routes/monitor.ts` for the "always clear the interval on teardown" discipline and its
  `inFlight` guard.
- **IMPORTS**: `import fp from "fastify-plugin";` plus `runEvaluatorTick` from `../alert-evaluator.js`.
- **GOTCHA**: Arm `onClose` **before** any `await` in the plugin body (CLAUDE.md long-lived-resource
  rule). A close during an initial await otherwise fires before the hook exists → leaked timer → a
  vitest run that never exits.
- **GOTCHA**: Call `timer.unref()`. The archive should not stay alive solely because an evaluator
  timer is pending.
- **GOTCHA**: The tick's error handler must swallow (log-only). An unhandled rejection inside
  `setInterval` takes the process down — and this is the component whose entire job is to survive to
  report other failures. Same reasoning as the heartbeat swallow at
  `apps/collector/src/heartbeat.ts:95-103`; read that comment.
- **VALIDATE**: `npm run typecheck`

### UPDATE `apps/ingest/src/app.ts`

- **IMPLEMENT**: Add `alertEvaluatorIntervalMs?: number` to `BuildAppOptions`; decorate
  `app.decorate("alertEvaluatorIntervalMs", opts.alertEvaluatorIntervalMs ?? 0)` alongside
  `reconcileThrottleMs` (~line 179); register the new plugin. Add the TS declaration-merging entry
  beside the existing ones.
- **PATTERN**: `app.ts:83-91` (option docs) and `:176-198` (decorate block).
- **GOTCHA**: Default **0 = disabled**. Every existing test calls `buildApp` without it; a non-zero
  default would start a timer in ~30 int-test files and make `app.close()` races appear as flaky,
  unrelated failures. This mirrors why `alertDeliverer` and `selfSignupEnabled` default to off.
- **VALIDATE**: `npx vitest run apps/ingest/src/delivery.int.test.ts` — still green, no hang.

### UPDATE `apps/ingest/src/server.ts`

- **IMPLEMENT**: Read `ALERT_EVALUATOR_INTERVAL_MS` via the existing `parsePositiveInt` (default
  `60000`) and pass it to `buildApp`.
- **PATTERN**: `server.ts:76-80` (`monitorStreamIntervalMs`).
- **GOTCHA**: Add the key to `.env.example` **with a real value** (`ALERT_EVALUATOR_INTERVAL_MS=60000`),
  following `MONITOR_STREAM_INTERVAL_MS=3000` at `.env.example:120`. Do NOT ship it empty: an empty
  value makes `parsePositiveInt` receive `""`, `Number("")` is `0`, and the server **throws at boot**.
  (This is the numeric sibling of the CLAUDE.md `??` vs `||` env rule — same class, different operator.)
- **VALIDATE**: `npm run typecheck`

### CREATE `apps/collector/src/fault.ts`

- **IMPLEMENT**: `CaptureFault` (`{ code: "auth_revoked"; message: string; since: string; url: string }`),
  `FAULT_PATH`, `faultPathFor(home)`, `saveFault`, `loadFault` (tolerant), `clearFault`.
- **PATTERN**: `apps/collector/src/identity.ts:32-40` (the `…For(home)` helpers) and `:78-95`
  (`saveCredentials` / `loadCredentials`, including `mkdirSync(dirname(path), { recursive: true })`
  and the tolerant `try/catch` returning `undefined`).
- **GOTCHA**: `faultPathFor(home)` must go through `collectorHomeFor(home)` like every sibling.
  CLAUDE.md: `--home` moves every collector-home artifact together **or it moves none of them
  honestly** — and a fault file that the Windows service writes under
  `…\config\systemprofile\.420ai\` while the desktop reads `C:\Users\me\.420ai\` is precisely the
  split-brain that F-16.3-1 already cost this milestone once.
- **GOTCHA**: The fault record must contain **no token**. It records that the credential was rejected,
  never the credential.
- **VALIDATE**: `npx vitest run apps/collector/src/fault.test.ts`

### UPDATE `apps/collector/src/capture-engine.ts`

- **IMPLEMENT**: Add `onFatal?: (fault: CaptureFault) => void` to `CaptureEngineOptions`; call it from
  the existing `onStop` handler (line 336) before `internal.abort()`.
- **PATTERN**: `onSyncSuccess` (`capture-engine.ts:83`) — same optional-callback shape.
- **GOTCHA**: **Do NOT change `runCaptureEngine`'s return type.** `cli.ts:206` declares
  `runEngine?: typeof runCaptureEngine`, so widening `Promise<void>` to a result object breaks the
  injected test double at compile time. An additive callback has zero blast radius; a changed
  signature does not. (Phase 4.5 lever 5.)
- **GOTCHA**: Guard the callback in `try/catch`. A reporter that throws inside `onStop` would unwind
  the engine through a different path — the exact shape of F-16.3-2 and of the `heartbeat.ts:98-102`
  comment. Copy that guard.
- **VALIDATE**: `npx vitest run apps/collector/src/capture-engine.test.ts`

### UPDATE `apps/collector/src/cli.ts` — fatal exit code (the C.11 lesson, applied to the daemon)

- **IMPLEMENT**: Thread `onFatal` through `runWatch` (write the fault via `saveFault`, record a local
  flag). At line 644, replace the unconditional `process.exit(0)` with `process.exit(fatal ? 1 : 0)`
  and write the reason to stderr. On a successful sync (`onSyncSuccess`), call `clearFault`.
- **PATTERN**: `cli.ts:653-663` — the `collector sync` "stop" branch. Same message, same exit code,
  same reasoning; this is that block's missing twin.
- **GOTCHA**: Exit **1 only for a fatal 401**, never for SIGINT. A Ctrl-C or a service stop must stay
  exit 0, or WinSW will restart-loop the collector every time the operator stops it deliberately.
- **GOTCHA**: `clearFault` on successful sync is what makes the signal self-resolving. Without it the
  fault file is permanent after one bad hour and stops meaning anything — the same reasoning that made
  `clearConnectorError` necessary in 16.3 (`capture-engine.ts:289`).
- **VALIDATE**: `npx vitest run apps/collector/src/cli.test.ts`

### UPDATE `apps/collector/src/serve.ts` — surface the reason to the tray

- **IMPLEMENT**: Pass `onFatal` into `runEngine` in `startEngine`; on fault, `emit({ type: "error",
  message })` in addition to the existing `state = "error"`.
- **PATTERN**: `serve.ts:250-258` — the `.then()` branch that already sets `state = "error"` and logs
  "capture engine stopped unexpectedly". This adds the *why*.
- **GOTCHA**: Reuse the EXISTING `{ type: "error"; message: string }` variant of `ControlEvent`
  (`packages/shared/src/control-protocol.ts:99`). Do **not** add a field to the `status` event: that
  bumps `CONTROL_PROTOCOL_VERSION` (`m12-control-v3`) and drags the Tauri UI into this slice for no
  detection benefit.
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts`

### UPDATE `apps/collector/service/README.md`

- **IMPLEMENT**: Document that a fatal 401 now exits non-zero, so WinSW restarts per `<onfailure>` and
  Windows records a service failure; and that `~/.420ai/fault.json` is the durable record to check.
- **VALIDATE**: `npm run format` (CI runs prettier over markdown — see memory note "CI prettier checks
  markdown"; local `repo-health` does not).

### CREATE `apps/ingest/src/alert-evaluator.int.test.ts`

- **IMPLEMENT**: The three assertions the planning spike proved (see Testing Strategy below).
- **PATTERN**: `apps/ingest/src/delivery.int.test.ts:1-125` — copy the harness verbatim
  (`seedBootstrapKey`, spy deliverer, TRUNCATE list, `reconcileThrottleMs: 0`, `pairMachine`).
- **GOTCHA**: Call `runEvaluatorTick` **directly with an injected `now`**. Do not start the plugin's
  timer and sleep — a wall-clock test at 60 s cadence is either slow or flaky, and per the M15 15.5
  lesson a concurrency/timing test at the wrong layer cannot fail informatively.
- **VALIDATE**: `npx vitest run apps/ingest/src/alert-evaluator.int.test.ts`

### UPDATE `.agents/research/weekly/TEMPLATE.md`

- **IMPLEMENT**: Add a **Detection** row to the "Capture health" block: open/unacked alert firings
  during the week, whether any `collector.offline` / `ingest.auth_failure` fired, and whether
  `~/.420ai/fault.json` was present. Follow the template's existing "record unknown values
  explicitly" instruction — `unknown` is a legal value, `0` is not a substitute.
- **GOTCHA**: This block is filled from the 16.4 audit report. State the SOURCE of each new row inline,
  as the existing comment block does for every other row, or the row will be guessed at fill-in time.
- **VALIDATE**: `npm run format`

### UPDATE `SUMMARY.md`

- **IMPLEMENT**: Flip **16.6** to ✅ with a one-line "DONE `<date>` (PR #NN)" note in BOTH the §0
  status block and the §6 roadmap; record decision **D-16.6-1** (no expected-machine registry, with
  the reason); note that M16's remaining open box is still the four weekly scorecards.
- **PATTERN**: the 16.5 entry at `SUMMARY.md:1016-1029`.
- **GOTCHA**: CLAUDE.md requires this in the SAME commit as the execution report;
  `scripts/check-summary.mjs` FAILS the gate otherwise.
- **VALIDATE**: `npm run repo-health:fast`

---

## TESTING STRATEGY

### Unit Tests

- `apps/collector/src/fault.test.ts` — round-trip save/load; tolerant load of a corrupt file returns
  `undefined`; `clearFault` on a missing file is a no-op; `faultPathFor("C:/x")` sits under
  `C:/x/.420ai/`; the persisted record contains no token.
- `apps/collector/src/capture-engine.test.ts` — an injected `post` returning 401 invokes `onFatal`
  exactly once; an `onFatal` that THROWS does not prevent the engine unwinding cleanly.
- `apps/collector/src/cli.test.ts` — `runWatch` with a stub `runEngine` that fires `onFatal` writes the
  fault file and reports the fatal flag; a clean SIGINT-style return does not.

### Integration Tests

`apps/ingest/src/alert-evaluator.int.test.ts` (`*.int.test.ts` ⇒ self-skips without
`DATABASE_URL_TEST`, excluded from `tsc -b`, type-stripped by vitest):

1. **The headline claim** — seed a paired machine with a >5 min-old heartbeat, run ONE
   `runEvaluatorTick`, assert the spy deliverer received exactly one `collector.offline` firing **with
   no HTTP request made**.
2. **No duplication with the dashboard** — after (1), `GET /v1/monitor` returns exactly ONE open
   `collector.offline` firing and the deliverer is NOT called again. This is the assertion that
   validates reconciling under the org **owner**; it fails loudly if a different user is chosen.
3. **Tick idempotency** — two consecutive ticks ⇒ one delivery, and `SELECT count(*) FROM
   alert_firings WHERE status = 'open'` is 1.
4. **`ingest.auth_failure` reaches delivery from a tick alone** — record ≥3
   `recordIngestAuthFailure` rows, run a tick, assert the firing is delivered. **This is the direct
   INC-2026-07 regression test**: it is the alert that was derivable for 8 days and never evaluated.
5. **Multi-org** — two orgs each with a stale machine; one tick delivers for BOTH, and neither org's
   firing carries the other's `orgId`.

### Edge Cases

- An org with **zero members** (possible mid-teardown) — skipped, no throw.
- An org whose only member is a **viewer** — must still reconcile, because the tick runs as
  `SERVICE_ROLE`. This is the M15 15.4 "whose action is this?" lesson: the reconcile is the ORG's
  bookkeeping, not the viewer's mutation. Assert it does not 500 or no-op.
- **No deliverer wired** (`alertDeliverer: null`) — reconcile still runs; delivery early-returns.
- A deliverer that **throws** — the tick continues to the next org and the error is reported via
  `onError`, never thrown.
- `alertEvaluatorIntervalMs: 0` — no timer is created; assert via `app.close()` returning promptly.
- A tick that **overruns** its interval — the `inFlight` guard skips rather than overlapping.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every command below is a GATE.

### Level 1: Syntax & Style

```bash
npm run typecheck        # root tsc -b — MUST exit 0 (per-workspace build is NOT a substitute)
npm run lint             # ESLint — NOT part of repo-health; CI runs it (memory: ci-lint-not-in-repo-health)
npm run format           # prettier, incl. markdown — CI format:check lints .md, local repo-health does not
```

### Level 2: Unit Tests

```bash
npx vitest run apps/collector/src/fault.test.ts
npx vitest run apps/collector/src/capture-engine.test.ts apps/collector/src/cli.test.ts apps/collector/src/serve.test.ts
```

Pass signal: exit 0, 0 failures.

### Level 3: Integration Tests

```bash
npm run db:up && npm run db:migrate
npx vitest run apps/ingest/src/alert-evaluator.int.test.ts
npm run repo-health -- --require-db
```

Pass signal: `--require-db` exits 0 AND reports **0 skipped** int tests. A plain `repo-health` PASS does
**not** count — `skipped ≠ passed` (CLAUDE.md). Note the memory caveat: the `420ai_test` database is not
migrated by `db:migrate` and may need migrating separately before `--require-db`.

### Level 4: Manual Validation

1. **The evaluator delivers with nobody watching.** Start ingest with
   `ALERT_EVALUATOR_INTERVAL_MS=5000` and a webhook/Mailpit deliverer. Pair a collector, stop it, and
   **do not open the dashboard**. Within ~6 minutes a `collector.offline` webhook/email must arrive.
   Capture the payload as sign-off evidence under `.agents/qa/m16-slice6/`.
2. **The 401 is loud.** With the collector running, revoke/delete its machine row, then:
   - `echo $LASTEXITCODE` after `collector watch` terminates ⇒ **1**;
   - `~/.420ai/fault.json` exists and names the revoked credential (and contains no token);
   - under WinSW, `Get-Service 420ai-collector` shows a restart and the Windows Event Log records the
     failure.
3. **Self-resolving.** Re-pair, let one sync succeed, confirm `fault.json` is gone.

### Level 5: Additional Validation (Optional)

- `/lril:code-review` — CLAUDE.md notes it is what catches the long-lived-resource leak class that
  `tsc` and tests do not. This slice adds a `setInterval`; run it.

---

## ACCEPTANCE CRITERIA

- [ ] A `collector.offline` alert is **delivered with no dashboard GET** (int test 1 + manual 1)
- [ ] `ingest.auth_failure` is delivered from a tick alone — the direct INC-2026-07 regression (int 4)
- [ ] The evaluator produces **no duplicate firings** against the dashboard (int test 2)
- [ ] Ticks are idempotent; two ticks ⇒ one delivery (int test 3)
- [ ] All nine alert codes are derived by the tick (no silent resolve-flapping)
- [ ] `collector watch` exits **non-zero** on a fatal 401 and **zero** on SIGINT
- [ ] `~/.420ai/fault.json` is written on fault, cleared on the next successful sync, and holds no token
- [ ] `faultPathFor` honours `--home` alongside creds/queue/connector config
- [ ] The desktop emits a control-protocol `error` event with the reason; `CONTROL_PROTOCOL_VERSION`
      is **unchanged**
- [ ] `.env.example` carries `ALERT_EVALUATOR_INTERVAL_MS=60000` (a real value, not empty)
- [ ] `buildApp` default leaves the evaluator **disabled**; no existing test starts a timer
- [ ] The weekly scorecard template has a Detection row with its source stated
- [ ] `npm run repo-health -- --require-db` passes with **0 skipped** int tests
- [ ] `npm run lint` and `npm run format` pass (CI-only gates)
- [ ] `SUMMARY.md` updated in the same commit as the execution report (D-16.6-1 recorded)
- [ ] No migration added; no new alert code; no new table

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully
- [ ] Full suite passes (unit + integration, 0 skipped with `--require-db`)
- [ ] No typecheck, lint, or format errors
- [ ] Manual validation evidence captured under `.agents/qa/m16-slice6/`
- [ ] Acceptance criteria all met
- [ ] `/lril:code-review` run (long-lived-resource class)

---

## NOTES

### Spikes RUN during planning (evidence for the confidence score)

**S1 — the background evaluator, end to end against a live DB.** A throwaway
`apps/ingest/src/spike-evaluator.int.test.ts` was written, run, and deleted. It implemented the exact
`listOrganizations → listMembers(owner) → withOrg(SERVICE_ROLE) → machineStatuses → deriveAlerts →
reconcileAlertFirings → deliverPendingFirings` composition proposed above, against the running
`420ai-archive` container.

```
 RUN  v4.1.8 C:/Users/seanr/OneDrive/Documents/420AI
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  8.10s
```

Proven, not assumed: (i) `listOrganizations` reads fine from the **unwrapped app-role** handle
(`organizations` has no RLS, D-15.3-4); (ii) `withOrg(db, orgId, SERVICE_ROLE, …)` + `machineStatuses(tx,
orgId)` + `reconcileAlertFirings(tx, …)` compose correctly; (iii) `deliverPendingFirings` works on the
unwrapped handle OUTSIDE the transaction; (iv) **a `collector.offline` firing was delivered exactly
once with no HTTP request**; (v) a subsequent `GET /v1/monitor` returned exactly ONE open firing and
triggered NO second delivery; (vi) two ticks were idempotent (1 open row, 1 delivery).

**S2 — the reconcile-user question, settled by (v) above.** `alert_firings_open_key` is unique on
`(user_id, alert_key)` where `status = 'open'` (`schema.ts:980-984`). An evaluator reconciling under a
different user than the dashboard would create a SECOND open row and a SECOND email for one outage.
Choosing the org's **owner** membership makes the two paths converge on the same row — measured, not
reasoned about.

**S3 — symbol/signature verification (all read from source, none from memory).**
`withOrg(db, orgId, role, fn)` `org-context.ts:50`; `reconcileAlertFirings(db, orgId, userId, alerts,
now)` `alert-firings.ts:101`; `listAlertFirings(db, orgId, userId, now)` `:164`;
`deliverPendingFirings(db, orgId, role, userId, deliverer, now, log?)` `:258`;
`deliverResolvedFirings(…)` `:315`; `listOrganizations(db)` `organizations.ts:83`;
`listMembers(db, orgId)` `members.ts:64`; `MemberRow` `members.ts:40`; `SERVICE_ROLE = "service"`
`roles.ts:25`; `countRecentAuthFailures(db, since)` — **no orgId** — `auth-failures.ts:37`.

**S4 — harness confirmed present.** `seedBootstrapKey` (`apps/ingest/src/test-support/bootstrap-key.js`),
the spy-deliverer pattern, the TRUNCATE list and `pairMachine()` all exist at
`delivery.int.test.ts:1-125` and were exercised by S1.

**S5 — the collector defect, confirmed by reading.** `cli.ts:644` is an unconditional
`process.exit(0)` after `runWatch`; `cli.ts:206` types the injection seam as
`runEngine?: typeof runCaptureEngine`, which is why Task "UPDATE capture-engine.ts" uses an additive
callback rather than a changed return type. Only ONE test currently injects `runEngine`, but the
constraint holds regardless.

**S6 — the env trap.** `.env.example:120,124` ship interval keys with REAL values
(`MONITOR_STREAM_INTERVAL_MS=3000`, `HEARTBEAT_INTERVAL_MS=30000`). `parsePositiveInt("")` would throw
at boot, so the new key must ship populated.

### Design decisions

- **D-16.6-1 — no expected-machine registry.** Recorded in the Solution Statement above. A server-side
  registry cannot survive the DB reset it exists to detect, and duplicates `collector.offline` where
  the row survives. The durable expectation lives on the collector instead.
- **D-16.6-2 — the tick reconciles as the org OWNER.** Deterministic, stable, and collides with the
  dashboard's firing row by design (spike S2). Note the pre-existing wart this does not fix: two
  members opening the dashboard already reconcile under their own user ids and thus keep parallel
  firing sets. The tick does not make that worse and deliberately does not address it.
- **D-16.6-3 — reuse the existing `error` ControlEvent.** Keeps `CONTROL_PROTOCOL_VERSION` at
  `m12-control-v3` and the Tauri UI out of this slice.
- **D-16.6-4 — the evaluator is opt-in and defaults OFF in `buildApp`.** Same shape as
  `alertDeliverer` / `selfSignupEnabled`. Only `server.ts` turns it on.

### The transferable lesson (for the execution report / system review)

The repo's `skipped ≠ passed`, `bypassed ≠ enforced`, and `passes on fixtures ≠ runs in production`
family gains a fourth member:

> **`derivable ≠ detected`.** The alert was correct, the data was present, and the projection was
> right — and none of it mattered, because the only thing that ran it was a human who had no reason to
> look. A monitor whose evaluation trigger is the operator's suspicion can only ever confirm what the
> operator already suspects.

Its sibling on the collector side is narrower and older: **an unattended daemon must not report success
through the same channel it reports nothing.** `collector sync` learned that as C.11 in M12; `collector
watch` never did, and the gap cost eight days.

### Residual risks

- The evaluator adds a periodic write (reconcile) per org. At 60 s and one org this is negligible; it is
  bounded by the same throttle logic the SSE path needed at 3 s.
- The 4-week weekly-scorecard box that gates M16 sign-off is **unaffected** by this slice — it remains
  calendar-blocked (earliest close: late August 2026).
