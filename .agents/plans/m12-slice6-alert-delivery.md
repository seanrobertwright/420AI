# Feature: M12 Slice 12.6 — Alert delivery (webhook) + remaining §20 alert conditions

The following plan should be complete, but it's important that you validate documentation and
codebase patterns and task sanity before you start implementing. Pay special attention to naming of
existing utils/types/models — import from the right files.

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (ESM `.js` import suffixes, `import type`, kebab-case files, silent
> libraries, inject clocks, the `repo-health` gate, the Drizzle/SQL gotchas) and
> [`SUMMARY.md`](../../SUMMARY.md) §3/§6 (M12 slicing). Read both before starting.

---

## Feature Description

M12 Slice 12.6 closes the **operational-alerts** story. M10 3c built the **persisted alert-firing
surface** (`alert_firings`, `reconcileAlertFirings`, evaluate-on-read in the monitor snapshot, Ack
button) but firings only ever **surfaced in the dashboard** — nothing is **pushed** to the operator,
and two of the six PRD §20 conditions are still unimplemented. This slice adds:

1. **Alert delivery (webhook)** — when a firing newly opens, POST the firing JSON to a configured
   webhook URL (Slack/Discord/n8n/email-bridge target), via an **injected `AlertDeliverer`** (the
   proven `analysisProvider` injection pattern). Exactly-once-attempt per firing via a new
   `delivery_attempted_at` marker, hooked into the existing **evaluate-on-read reconcile** — **no new
   background loop** (CLAUDE.md leaked-timer rule).
2. **`ingest.auth_failure`** (PRD §20) — server-observable: the machine-auth preHandler already 401s a
   revoked/invalid token; record each failure to a new `ingest_auth_failures` table and derive a
   global alert when failures cross a windowed threshold (mirrors `deriveCatalogAlerts(count)`).
3. **`archive.unreachable`** (PRD §20) — collector-observable only: extend the M9 heartbeat with a
   `consecutiveSyncFailures` counter (the sync worker is the sole component that sees "can't reach the
   archive"); the server derives a per-machine alert when the reported count crosses a threshold
   (mirrors the M9 heartbeat-extension pattern exactly).

**Out of scope (deferred → 12.6b):** the **windowed connector-failure rate** (the existing
`connector.failing` stays a lifetime ratio; a per-window rate needs a time-bucketed `connectorHealth`
projection — a separate concern). SMTP/email delivery (webhook-first; email is a future `AlertDeliverer`
behind the same interface). Deliver-on-resolve (open-only this slice).

## User Story

As the **single self-hosted operator** of 420AI
I want to **be notified (via a webhook) the moment an operational alert fires, and to be alerted when
the ingest endpoint sees repeated auth failures or a collector can't reach the archive**
So that **I find out about outages/security probes without having to keep the dashboard open.**

## Problem Statement

The alert engine is **pull-only**: firings live in `alert_firings` and render in the Live Monitor, but
an operator who isn't looking at the dashboard never learns an alert fired. And two §20 conditions —
`ingest.auth_failure` (a revoked collector still POSTing, or a probe) and `archive.unreachable` (a
collector that can't sync) — produce **no alert at all** today, so the two most operationally important
"something is wrong" signals are invisible.

## Solution Statement

- **Delivery**: add an injected `AlertDeliverer` (`apps/ingest/src/delivery/alert-deliverer.ts`,
  cloning `analysis/provider.ts`), a concrete **webhook** deliverer (`fetch` + `AbortSignal.timeout`,
  no new dependency), a `delivery_attempted_at` column on `alert_firings`, and a best-effort
  `deliverPendingFirings(...)` repo call invoked right after `reconcileAlertFirings` in the monitor
  snapshot path. Disabled by default (`alertDeliverer = null`) so every existing `buildApp` caller and
  the no-webhook server are unchanged.
- **`ingest.auth_failure`**: a new global `ingest_auth_failures` table + `recordIngestAuthFailure` /
  `countRecentAuthFailures` repo; record (best-effort) in the `authenticate` preHandler on a 401;
  derive a global alert via a new pure `deriveAuthFailureAlerts(count)` merged in `buildSnapshot`.
- **`archive.unreachable`**: extend `HeartbeatRequest` + `heartbeatBodySchema` + `recordHeartbeat` +
  a nullable `machines.consecutive_sync_failures` column + `MachineStatusRow`; the collector
  `runSyncLoop` tracks the counter (reset on `ok`, ++ on `retry`) and the heartbeat reports it; derive
  a per-machine alert via a new pure `deriveArchiveUnreachableAlerts(machineRows)` merged in
  `buildSnapshot`.

All three new alert codes render in the dashboard with **zero frontend change** — `AlertsPanel`
(`apps/dashboard/src/components/monitor/alerts-panel.tsx`) switches only on `severity`, never on `code`.

## Feature Metadata

**Feature Type**: New Capability (delivery) + Enhancement (two new §20 conditions)
**Estimated Complexity**: Medium–High (one migration with 3 changes; touches shared + db + ingest +
collector; but every change follows an exact in-repo precedent)
**Primary Systems Affected**: `packages/shared` (alerts, ingest wire, monitor types), `packages/db`
(schema + migration + alert-firings/machines/auth-failures repos), `apps/ingest` (delivery,
plugins/auth, monitor route, app wiring, server env, schemas), `apps/collector` (sync-worker +
heartbeat counter)
**Dependencies**: none new (webhook = built-in `fetch` + `AbortSignal.timeout`, verified present on
Node 24)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The firing surface + reconcile (the spine this slice extends):**
- `packages/shared/src/alerts.ts` — `OperationalAlert`, `AlertCode` (union to extend),
  `deriveCatalogAlerts(pendingCount)` (lines 218-228 — the **exact template** for the two new global/
  per-machine derivatives), `sortAlerts`, `ALERT_THRESHOLDS`, `ALERT_VERSION`.
- `packages/shared/src/alert-firings.ts` — `AlertFiring`, `alertKey()`, statuses. `since` is opaque text.
- `packages/db/src/repositories/alert-firings.ts` — `reconcileAlertFirings` (upsert-by-partial-unique +
  resolve), `listAlertFirings`, `ackAlertFiring`, `firingColumns`, `toFiring`. **Add
  `deliverPendingFirings` here.**
- `apps/ingest/src/routes/monitor.ts` — `buildSnapshot()` (lines 43-80): the evaluate-on-read writer
  that calls `reconcileAlertFirings`. Runs on **GET /v1/monitor AND the SSE `push()` every ~3 s**
  (lines 131-150) — this is why delivery needs an idempotent `delivery_attempted_at` marker.
- `packages/db/src/repositories/alert-firings.int.test.ts` — the **exact int-test harness** to mirror
  (TRUNCATE list, fixed `t0…t4` clock, `dbh.db`, fixtures).

**The injection pattern (template for `AlertDeliverer`):**
- `apps/ingest/src/analysis/provider.ts` — `AnalysisProvider` interface + `AnalysisProviderError` +
  `createAnalysisProvider(cfg|null)` returning a `notConfigured()` stand-in. **Clone its shape.**
- `apps/ingest/src/app.ts` — `BuildAppOptions` + `buildApp` decorations (lines 35-104). Note the
  **opt-in-or-off** pattern used by `rateLimit` (lines 121-131): omitted → feature off. Mirror it for
  `alertDeliverer` (omitted → `null` → delivery disabled).
- `apps/ingest/src/plugins/auth.ts` — the `declare module "fastify"` augmentation (add
  `alertDeliverer`) AND the `authenticate` preHandler (lines 49-60: the `!machineId` 401 — **record the
  auth failure here, best-effort**).
- `apps/ingest/src/server.ts` — env wiring (lines 11-104). Mirror `analysisConfig`/`rateLimit` to build
  the webhook deliverer from `ALERT_WEBHOOK_URL`.

**The `ingest.auth_failure` count-and-derive template:**
- `packages/db/src/repositories/pricing-catalogs.ts` — `countPendingCatalogs` (GLOBAL, no userId —
  the **exact template** for `countRecentAuthFailures`); `toRow` Date→ISO normalization.
- `apps/ingest/src/routes/metrics.ts` — admin-gate + `app.metrics` pattern (for context).

**The `archive.unreachable` heartbeat-extension template (M9 — follow VERBATIM):**
- `packages/shared/src/ingest.ts` — `HeartbeatRequest` (lines 72-76: add the optional new field) +
  `IngestBatch`.
- `apps/ingest/src/schemas.ts` — `heartbeatBodySchema` (lines 107-116: add the optional field).
- `apps/ingest/src/routes/heartbeat.ts` — passes the body to `recordHeartbeat`.
- `packages/db/src/repositories/machines.ts` — `recordHeartbeat` (lines 48-78: write the new column).
- `packages/db/src/repositories/monitor.ts` — `machineStatuses` (lines 22-50: select + Date→ISO the new
  column). **CLAUDE.md gotcha lives here (lines 14-19): `machines.*` are plain timestamptz → JS Date →
  `.toISOString()`; an integer column needs no coercion.**
- `packages/shared/src/monitor.ts` — `MachineStatusRow` (lines 34-44: add the new field);
  `LiveMonitorSnapshot`; `MONITOR_THRESHOLDS`.
- `apps/collector/src/sync/sync-worker.ts` — `runSyncLoop` (lines 102-145: track the counter) +
  `syncOnce` outcomes (`"ok"`/`"retry"`/`"stop"`).
- `apps/collector/src/heartbeat.ts` — `maybeSendHeartbeat` + `HeartbeatDeps` (add the counter, default 0).

**Schema + migration:**
- `packages/db/src/schema.ts` — `alertFirings` (lines 416-440), `machines` (lines 55-75),
  `machineHeartbeats` (397-407: the additive-table + index template). Add the column to
  `alert_firings` + `machines` and a new `ingestAuthFailures` table.
- `packages/db/src/index.ts` — the `@420ai/db` barrel: export the new table + new repo fns.
- `packages/db/drizzle/0009_exotic_ben_grimm.sql` + `down/0009_exotic_ben_grimm.down.sql` — the
  up/down pair shape (down uses `--> statement-breakpoint` between statements — see
  `packages/db/src/rollback.ts:42`).
- `packages/db/drizzle/meta/_journal.json` — last `idx:9` `0009_exotic_ben_grimm`; **next is `0010`**.

**Dashboard (verify-only — NO change expected):**
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` — renders firings generically (switches on
  `severity`, lines 79-118). New codes flow through untouched.

**Docs to update:**
- `docs/CONTEXT.md` — has "Operational Alert" (line 143) + "Alert Firing" (147). Add "Alert Delivery".
- `docs/guide/operations.md` — add an "Alerts & delivery (12.6)" subsection (env + behavior).
- `.env.example` — add the `ALERT_WEBHOOK_*` vars (no alert/webhook vars exist there today — verified).
- `SUMMARY.md` §6 12.6 — flip to DONE with the scope note (windowed-rate deferred to 12.6b).

### New Files to Create

- `apps/ingest/src/delivery/alert-deliverer.ts` — `AlertDeliverer` interface + `createWebhookDeliverer(cfg|null)`.
- `apps/ingest/src/delivery/alert-deliverer.test.ts` — unit tests (webhook POST shape, timeout, non-2xx → throw, null → no-op).
- `apps/ingest/src/delivery.int.test.ts` — int test: a firing opens → a spy deliverer is called once;
  `delivery_attempted_at` stamped; second snapshot does not re-deliver.
- `packages/db/src/repositories/auth-failures.ts` — `recordIngestAuthFailure` + `countRecentAuthFailures`.
- `packages/db/src/repositories/auth-failures.int.test.ts` — int test (record N, count within/outside window, prune).
- `packages/db/drizzle/0010_<generated>.sql` — produced by `npm run db:generate` (do NOT hand-write the up).
- `packages/db/drizzle/down/0010_<generated>.down.sql` — **hand-author** to match the generated tag.

### Patterns to Follow

**Injected-interface (from `analysis/provider.ts`) — `AlertDeliverer`:**
```ts
// apps/ingest/src/delivery/alert-deliverer.ts
import type { AlertFiring } from "@420ai/shared";

/** Push one newly-opened firing to an external sink (webhook today; email later). Silent
 *  library (CLAUDE.md): throws on failure, the caller swallows + logs. */
export interface AlertDeliverer {
  deliver(firing: AlertFiring): Promise<void>;
}

export interface WebhookDelivererConfig {
  url: string;
  timeoutMs: number; // AbortSignal.timeout — verified present on Node 24
}

/** POST the firing JSON to a generic webhook. Throws on non-2xx / network / timeout so the
 *  caller can log it; a single attempt per firing (the caller stamps delivery_attempted_at). */
export function createWebhookDeliverer(cfg: WebhookDelivererConfig | null): AlertDeliverer | null {
  if (!cfg) return null; // delivery disabled (no ALERT_WEBHOOK_URL) — mirrors rateLimit opt-in
  return {
    async deliver(firing: AlertFiring): Promise<void> {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "alert.firing", firing }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
    },
  };
}
```

**Global count-and-derive (from `deriveCatalogAlerts`) — `deriveAuthFailureAlerts`:**
```ts
// packages/shared/src/alerts.ts  (append; deriveAlerts stays FROZEN — D2)
/** Windowed ingest-auth-failure alert (PRD §20). Window + threshold tunable. */
export const AUTH_FAILURE_ALERT = { windowMs: 15 * 60_000, minFailures: 3 } as const;

/** Emit a GLOBAL `ingest.auth_failure` (warning) when ≥ minFailures invalid/revoked-token
 *  ingest attempts occurred in the window. Pure + clock-free (the route computes the count).
 *  Keys on neither machine nor connector → alertKey "ingest.auth_failure:*" (one firing). */
export function deriveAuthFailureAlerts(recentCount: number): OperationalAlert[] {
  if (recentCount < AUTH_FAILURE_ALERT.minFailures) return [];
  return [{
    code: "ingest.auth_failure",
    severity: "warning",
    message: `${recentCount} ingest authentication failures in the last ${AUTH_FAILURE_ALERT.windowMs / 60_000} min`,
    since: null, // a count, not a timestamp (like sync.backlog_high / catalog)
  }];
}
```

**Per-machine derive (mirrors the offline-suppression in `deriveAlerts`) — `deriveArchiveUnreachableAlerts`:**
```ts
// packages/shared/src/alerts.ts  (append)
/** Consecutive collector→archive sync failures before we alert (collector-reported). */
export const ARCHIVE_UNREACHABLE_MIN_FAILURES = 3;

/** Emit a per-machine `archive.unreachable` (warning) when a collector reports ≥ N consecutive
 *  sync failures. Reads the already-projected `consecutiveSyncFailures`; offline machines are
 *  SUPPRESSED (mirrors the backlog-high offline suppression — `collector.offline` covers them, and
 *  the reported count is stale once heartbeats stop). `since` = lastHeartbeatAt (display label). */
export function deriveArchiveUnreachableAlerts(
  machines: LiveMonitorSnapshot["machines"],
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const m of machines) {
    if (m.status === "offline") continue;
    if ((m.consecutiveSyncFailures ?? 0) < ARCHIVE_UNREACHABLE_MIN_FAILURES) continue;
    alerts.push({
      code: "archive.unreachable",
      severity: "warning",
      message: `Collector "${m.name}" cannot reach the archive (${m.consecutiveSyncFailures} consecutive sync failures)`,
      machineId: m.id,
      machineName: m.name,
      since: m.lastHeartbeatAt ?? m.lastSeenAt,
    });
  }
  return alerts;
}
```
> **Spike-snippet fidelity:** `deriveArchiveUnreachableAlerts` reads `m.consecutiveSyncFailures`, which
> Task 4 adds to `MachineStatusRow` and Task 9 populates in `machineStatuses`. `m.status` is set in
> `buildSnapshot` (`monitor.ts:56-60`) BEFORE the derive runs — confirmed.

**Global-count repo (from `countPendingCatalogs`) — `auth-failures.ts`:**
```ts
import { gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { ingestAuthFailures } from "../schema.js";

const AUTH_FAILURE_RETENTION_MS = 7 * 24 * 60 * 60_000; // prune bound (mirror HEARTBEAT_RETENTION_MS)

/** Append one ingest auth-failure (invalid/revoked token) + prune beyond retention. GLOBAL
 *  (no user — the token didn't resolve to a machine/user). `now` injectable (CLAUDE.md). */
export async function recordIngestAuthFailure(
  db: DbClient,
  input?: { remoteIp?: string; now?: Date },
): Promise<void> {
  const now = input?.now ?? new Date();
  await db.insert(ingestAuthFailures).values({ ts: now, remoteIp: input?.remoteIp ?? null });
  await db.delete(ingestAuthFailures).where(lt(ingestAuthFailures.ts, new Date(now.getTime() - AUTH_FAILURE_RETENTION_MS)));
}

/** Count failures at/after `since` (the route passes now - AUTH_FAILURE_ALERT.windowMs). `::int`
 *  cast → JS number (CLAUDE.md: count(*) is bigint→string without the cast). */
export async function countRecentAuthFailures(db: DbClient, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ingestAuthFailures)
    .where(gte(ingestAuthFailures.ts, since));
  return row?.n ?? 0;
}
```

**Delivery repo (best-effort, exactly-once-attempt) — append to `alert-firings.ts`:**
```ts
/** Deliver any OPEN firing not yet attempted, then stamp delivery_attempted_at (success OR
 *  failure → at-most-ONE attempt; the firing row itself stays the durable record). Best-effort:
 *  a per-firing deliver() throw is caught + logged via `log`, never propagated (so the snapshot
 *  read never 500s). Skip entirely when no deliverer is wired. `now` injected (route owns clock). */
export async function deliverPendingFirings(
  db: DbClient,
  userId: string,
  deliverer: AlertDeliverer | null,
  now: Date,
  log?: (err: unknown) => void,
): Promise<void> {
  if (!deliverer) return; // delivery disabled — no query
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(and(eq(alertFirings.userId, userId), eq(alertFirings.status, "open"), isNull(alertFirings.deliveryAttemptedAt)));
  for (const r of rows) {
    const firing = toFiring(r);
    try {
      await deliverer.deliver(firing);
    } catch (err) {
      log?.(err);
    }
    // Stamp regardless of outcome — at-most-once attempt, no 3-second retry spam.
    await db.update(alertFirings).set({ deliveryAttemptedAt: now }).where(eq(alertFirings.id, r.id));
  }
}
```
> Imports to add to `alert-firings.ts`: `isNull` from `drizzle-orm`; `type AlertDeliverer` —
> **do NOT** import from `apps/ingest` (a db→ingest dep is backwards). Instead define a minimal
> structural deliverer type in `@420ai/shared` OR accept `deliverer: { deliver(f: AlertFiring): Promise<void> } | null`
> inline. **Decision: accept the inline structural type** `{ deliver(firing: AlertFiring): Promise<void> } | null`
> in the repo signature (no shared/ingest type leak into db). `firingColumns` must include the new
> `deliveryAttemptedAt` column (add it) but `toFiring` need NOT expose it on the wire `AlertFiring`.

**Recording auth failures in the preHandler (`plugins/auth.ts`):**
```ts
// inside authenticate, when findMachineIdByToken returns null:
if (!machineId) {
  // Best-effort §20 audit — never let a logging write change the 401 contract (CLAUDE.md silent libs).
  void recordIngestAuthFailure(app.db, { remoteIp: request.ip }).catch(() => {});
  return reply.code(401).send({ error: "invalid or revoked token" });
}
```
> `request.ip` is a Fastify built-in (string). `void ...catch(()=>{})` keeps it fire-and-forget so the
> 401 latency/contract is unchanged. Import `recordIngestAuthFailure` from `@420ai/db`.

**Collector counter (in `runSyncLoop`, `sync-worker.ts`):**
```ts
let consecutiveSyncFailures = 0;
while (!signal.aborted) {
  await sendHeartbeat(consecutiveSyncFailures); // report the count accumulated so far
  const outcome = await syncOnce(deps);
  if (outcome === "stop") { deps.onStop?.(); return "stop"; }
  if (outcome === "ok") consecutiveSyncFailures = 0;
  else if (outcome === "retry") consecutiveSyncFailures += 1;
  if (signal.aborted) break;
  await delay(outcome === "ok" ? idleMs : retryMs, signal);
}
```
> `sendHeartbeat` gains a `consecutiveSyncFailures` param and forwards it into `maybeSendHeartbeat`'s
> deps. The heartbeat is throttled to 30 s, so it reports the latest accumulated count at send time —
> honest. (Heartbeat is best-effort; a send failure is swallowed and does not affect the counter.)

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — shared types + pure derivations (no I/O, fast unit tests)
Extend the `AlertCode` union; add the two pure derive fns + thresholds; add the wire/projection fields
(`HeartbeatRequest.consecutiveSyncFailures`, `MachineStatusRow.consecutiveSyncFailures`). Pure +
clock-free → covered by `alerts.test.ts`/`monitor.test.ts` style unit tests.

### Phase 2: Schema + migration
Add `alert_firings.delivery_attempted_at`, `machines.consecutive_sync_failures`, and the
`ingest_auth_failures` table to `schema.ts`; `npm run db:generate` → `0010_*.sql`; hand-author the
matching `down/0010_*.down.sql`; export the new table + repos from the db barrel.

### Phase 3: Core — repos + the injected deliverer
`auth-failures.ts` (record/count), `deliverPendingFirings` (alert-firings.ts), the webhook
`AlertDeliverer`, and `recordHeartbeat`/`machineStatuses` column plumbing.

### Phase 4: Integration — wire into the request path
`buildApp` (`alertDeliverer` decoration), `plugins/auth.ts` (record failure + augmentation),
`buildSnapshot` (merge the two new derivatives + call `deliverPendingFirings`), `heartbeat` route +
schema, the collector sync loop, and `server.ts` env.

### Phase 5: Testing, docs, validation
Unit + int tests; CONTEXT/operations/.env.example/SUMMARY docs; full `repo-health -- --require-db`.

---

## STEP-BY-STEP TASKS

> Execute in order, top to bottom. Validate each before moving on. Establish a green baseline FIRST:
> `npm run repo-health` (expect PASS — units only; int self-skip without DB).

### Task 1 — UPDATE `packages/shared/src/alerts.ts`
- **IMPLEMENT**: Extend `AlertCode` union (line 37-43) with `"ingest.auth_failure"` and
  `"archive.unreachable"`. Append `AUTH_FAILURE_ALERT`, `deriveAuthFailureAlerts`,
  `ARCHIVE_UNREACHABLE_MIN_FAILURES`, `deriveArchiveUnreachableAlerts` (snippets above).
- **PATTERN**: `deriveCatalogAlerts` (alerts.ts:218-228) for the global one; the offline-suppression
  loop in `deriveAlerts` (alerts.ts:88-122) for the per-machine one. **`deriveAlerts` stays FROZEN.**
- **IMPORTS**: already imports `LiveMonitorSnapshot`, `MonitorStatus` from `./monitor.js`.
- **GOTCHA**: `deriveArchiveUnreachableAlerts` reads `m.consecutiveSyncFailures` — add that field to
  `MachineStatusRow` in Task 3 (same package, same `tsc -b` unit). Keep `deriveAlerts` byte-identical.
- **VALIDATE**: `npx vitest run packages/shared/src/alerts.test.ts` (after Task 13 adds cases).

### Task 2 — UPDATE `packages/shared/src/ingest.ts`
- **IMPLEMENT**: Add to `HeartbeatRequest` (lines 72-76): `consecutiveSyncFailures?: number; // M12 12.6 archive.unreachable signal (optional → back-compat with older collectors)`.
- **PATTERN**: the M9 additive-field comment style already in this interface.
- **GOTCHA**: keep it **optional** — an older collector omits it; the server treats absent as 0.
- **VALIDATE**: `npm run typecheck` (root) exits 0.

### Task 3 — UPDATE `packages/shared/src/monitor.ts`
- **IMPLEMENT**: Add `consecutiveSyncFailures: number | null;` to `MachineStatusRow` (lines 34-44).
- **PATTERN**: the sibling nullable numeric fields `queuePending`/`queueInflight`.
- **GOTCHA**: `LiveMonitorSnapshot.machines` is `MachineStatusRow & {status,backlogHigh}` — the field
  flows automatically. `emptyMonitorSnapshot` needs no change (empty machines array).
- **VALIDATE**: `npm run typecheck`.

### Task 4 — UPDATE `packages/db/src/schema.ts` (3 additive changes)
- **IMPLEMENT**:
  1. `alertFirings` (after line 433 `ackedAt`): add
     `deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),` (nullable).
  2. `machines` (after line 74 `collectorVersion`): add
     `consecutiveSyncFailures: integer("consecutive_sync_failures"),` (nullable).
  3. New table after `machineHeartbeats` (line 407):
     ```ts
     /** M12 12.6 ingest auth-failure audit (PRD §20). Append-only; recordIngestAuthFailure
      *  appends + prunes. GLOBAL (no user_id — the token never resolved). Feeds the windowed
      *  `ingest.auth_failure` alert via countRecentAuthFailures. */
     export const ingestAuthFailures = pgTable("ingest_auth_failures", {
       id: uuid("id").primaryKey().defaultRandom(),
       ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
       remoteIp: text("remote_ip"),
     }, (t) => [index("ingest_auth_failures_by_ts").on(t.ts)]);
     ```
- **PATTERN**: `machineHeartbeats` (schema.ts:397-407) for the additive table + index.
- **GOTCHA**: `integer`, `text`, `index` are already imported (schema.ts:1-12). No FK on
  `ingest_auth_failures` (global, unauthenticated).
- **VALIDATE**: `npm run typecheck` (schema is type-checked by the db build).

### Task 5 — GENERATE migration `0010`
- **IMPLEMENT**: `npm run db:generate` (drizzle-kit v0.31.10 — verified; **offline**, diffs the schema
  against `meta/`, no DB needed). It emits `packages/db/drizzle/0010_<random>.sql` + a `meta/0010_*.json`
  snapshot + a `_journal.json` entry (`idx:10`).
- **VERIFY** the generated `0010_*.sql` contains exactly (names/order may differ):
  `ALTER TABLE "alert_firings" ADD COLUMN "delivery_attempted_at" timestamp with time zone;`,
  `ALTER TABLE "machines" ADD COLUMN "consecutive_sync_failures" integer;`, and
  `CREATE TABLE ... "ingest_auth_failures" (...)` + its `CREATE INDEX`. If it also tries to drop/alter
  anything else, STOP — the schema edit drifted; fix Task 4.
- **GOTCHA**: the migration name is random — note the produced tag for Task 6. Do NOT hand-edit the up
  SQL or the snapshot.
- **VALIDATE**: `git status` shows the new `0010_*.sql`, `meta/0010_*.json`, updated `_journal.json`.

### Task 6 — CREATE `packages/db/drizzle/down/0010_<tag>.down.sql`
- **IMPLEMENT** (hand-author; match the generated `<tag>` from Task 5):
  ```sql
  -- Down-migration for 0010_<tag> (M12 12.6). Reverses the 12.6 additive schema.
  DROP TABLE "ingest_auth_failures";
  --> statement-breakpoint
  ALTER TABLE "machines" DROP COLUMN "consecutive_sync_failures";
  --> statement-breakpoint
  ALTER TABLE "alert_firings" DROP COLUMN "delivery_attempted_at";
  ```
- **PATTERN**: `down/0009_*.down.sql` (single statement) + `rollback.ts:42` (splits on
  `--> statement-breakpoint`).
- **VALIDATE**: file exists; statements are reverse order of the up.

### Task 7 — CREATE `packages/db/src/repositories/auth-failures.ts`
- **IMPLEMENT**: `recordIngestAuthFailure` + `countRecentAuthFailures` + `AUTH_FAILURE_RETENTION_MS`
  (snippet above).
- **PATTERN**: `countPendingCatalogs` (pricing-catalogs.ts — global count); `recordHeartbeat` prune
  (machines.ts:70-77).
- **IMPORTS**: `import { gte, lt, sql } from "drizzle-orm";`, `import type { DbClient } from "../client.js";`,
  `import { ingestAuthFailures } from "../schema.js";`.
- **GOTCHA**: `count(*)::int` cast (CLAUDE.md — bare count is bigint→string). Silent library: throws,
  never logs.
- **VALIDATE**: `npm run typecheck`.

### Task 8 — UPDATE `packages/db/src/repositories/alert-firings.ts` (add `deliverPendingFirings` + column)
- **IMPLEMENT**:
  - Add `deliveryAttemptedAt: alertFirings.deliveryAttemptedAt,` to `firingColumns` (line ~44). Add it
    to `toFiring`'s row param type but **do NOT** add it to the returned `AlertFiring` (wire stays
    unchanged) — i.e. accept it in the row type, ignore it in the mapped object.
  - Append `deliverPendingFirings` (snippet above) with the **inline structural** deliverer type
    `{ deliver(firing: AlertFiring): Promise<void> } | null` (no ingest/shared deliverer-type import).
- **PATTERN**: `listAlertFirings` for the scoped select; the existing `firingColumns` reuse.
- **IMPORTS**: add `isNull` to the existing `drizzle-orm` import (line 1).
- **GOTCHA**: the `toFiring` row type currently lists every column; adding `deliveryAttemptedAt: Date | null`
  to that param type is REQUIRED because `firingColumns` now selects it (the select row shape must
  match). Don't surface it on `AlertFiring`. `delivery_attempted_at` stamped on success OR failure
  (at-most-once attempt — no 3 s retry spam; documented trade-off).
- **VALIDATE**: `npm run typecheck`.

### Task 9 — UPDATE `packages/db/src/repositories/machines.ts` + `monitor.ts` (heartbeat column plumbing)
- **IMPLEMENT**:
  - `machines.ts` `recordHeartbeat` (lines 48-62): add `consecutiveSyncFailures?: number` to the `hb`
    param; in the `.set({...})` add `consecutiveSyncFailures: hb.consecutiveSyncFailures ?? null,`.
  - `monitor.ts` `machineStatuses` (lines 24-49): add `consecutiveSyncFailures: machines.consecutiveSyncFailures,`
    to the select and `consecutiveSyncFailures: r.consecutiveSyncFailures,` to the mapped row (an
    `integer` column → JS `number | null`, **no Date coercion needed** — only the timestamptz columns get `.toISOString()`).
- **PATTERN**: the existing `queuePending` plumbing in both fns.
- **GOTCHA**: CLAUDE.md Drizzle gotcha (monitor.ts:14-19) — DO NOT `.toISOString()` an integer; the
  comment is about `machines.*` **timestamptz** columns only.
- **VALIDATE**: `npm run typecheck`.

### Task 10 — UPDATE `packages/db/src/index.ts` (barrel exports)
- **IMPLEMENT**: export `ingestAuthFailures` (in the `from "./schema.js"` block, line 3-20);
  `recordIngestAuthFailure, countRecentAuthFailures` from `./repositories/auth-failures.js`;
  add `deliverPendingFirings` to the existing alert-firings export block (lines 35-39).
- **PATTERN**: the existing grouped exports.
- **VALIDATE**: `npm run typecheck`.

### Task 11 — CREATE `apps/ingest/src/delivery/alert-deliverer.ts`
- **IMPLEMENT**: `AlertDeliverer` interface + `WebhookDelivererConfig` + `createWebhookDeliverer(cfg|null)`
  (snippet above).
- **PATTERN**: `analysis/provider.ts` (interface + `createX(cfg|null)` → stand-in). Here the stand-in
  is `null` (delivery is opt-in like rateLimit), NOT a throwing stub.
- **IMPORTS**: `import type { AlertFiring } from "@420ai/shared";`. `fetch`/`AbortSignal.timeout` are
  Node-24 built-ins (verified) — no import.
- **GOTCHA**: throw on non-2xx so the caller logs; never log here (silent library).
- **VALIDATE**: `npm run typecheck`.

### Task 12 — UPDATE `apps/ingest/src/app.ts` + `plugins/auth.ts` (wiring)
- **IMPLEMENT**:
  - `plugins/auth.ts`: in the `declare module "fastify"` `FastifyInstance` block, add
    `alertDeliverer: import("../delivery/alert-deliverer.js").AlertDeliverer | null;`. In `authenticate`,
    on the `!machineId` branch, fire-and-forget `recordIngestAuthFailure(app.db, { remoteIp: request.ip })`
    (snippet above). Add `recordIngestAuthFailure` to the `@420ai/db` import.
  - `app.ts`: add `alertDeliverer?: AlertDeliverer | null;` to `BuildAppOptions`; `import type { AlertDeliverer } from "./delivery/alert-deliverer.js";`; decorate
    `app.decorate("alertDeliverer", opts.alertDeliverer ?? null);` (near the other decorations,
    lines 89-104).
- **PATTERN**: the `rateLimitLogin` opt-in-or-`false` decoration (app.ts:121-131) and the
  `catalogPublicKey` decoration.
- **GOTCHA**: existing `buildApp` callers omit `alertDeliverer` → `null` → delivery disabled (no
  behavior change). The auth-failure record is best-effort `.catch(()=>{})` so it never alters the 401.
- **VALIDATE**: `npm run typecheck`.

### Task 13 — UPDATE `apps/ingest/src/routes/monitor.ts` (merge derivatives + deliver)
- **IMPLEMENT**:
  - Import `deriveAuthFailureAlerts, deriveArchiveUnreachableAlerts, AUTH_FAILURE_ALERT` from
    `@420ai/shared`; `countRecentAuthFailures, deliverPendingFirings` from `@420ai/db`.
  - In `buildSnapshot` `Promise.all` (lines 47-53) add
    `countRecentAuthFailures(db, new Date(nowMs - AUTH_FAILURE_ALERT.windowMs))`.
  - In the merged `sortAlerts([...])` (lines 72-76) add
    `...deriveArchiveUnreachableAlerts(machineRows), ...deriveAuthFailureAlerts(authFailureCount),`.
  - After `reconcileAlertFirings` (line 78), the route (NOT buildSnapshot — keep its `(db,userId,now)`
    signature small) calls `await deliverPendingFirings(db, app.alertDeliverer, ...)`. **Decision:**
    change `buildSnapshot` to also accept the deliverer + a logger, OR add a `deliverFirings(app, userId, now)`
    helper called right after `buildSnapshot` in BOTH `GET /v1/monitor` (line 103) and the SSE `push()`
    (after line 137). **Use the helper** (smaller change to the load-bearing `buildSnapshot`):
    ```ts
    async function deliverFirings(app: FastifyInstance, userId: string, now: Date): Promise<void> {
      // never throws (best-effort) — a delivery problem must not 500 the snapshot read / break SSE.
      try { await deliverPendingFirings(app.db, userId, app.alertDeliverer, now, (e) => app.log.error(e)); }
      catch (e) { app.log.error(e); }
    }
    ```
    Call it after the snapshot is built (GET: between build + send; SSE: inside the existing `try`,
    after the `buildSnapshot`, guarded by `if (!closed)`), using the SAME `now`.
- **PATTERN**: the existing merge of `deriveCatalogAlerts(pendingCatalogs)` (monitor.ts:75) and the
  best-effort swallow style.
- **GOTCHA**: `deliverPendingFirings` early-returns when `alertDeliverer` is null (no query in the
  default no-webhook case — keeps the 3 s SSE tick cheap). `app.log` is the Fastify logger.
- **VALIDATE**: `npm run typecheck`; `npx vitest run apps/ingest/src/app.int.test.ts` (self-skips w/o DB).

### Task 14 — UPDATE heartbeat wire path: `schemas.ts` + `routes/heartbeat.ts`
- **IMPLEMENT**:
  - `schemas.ts` `heartbeatBodySchema` (lines 107-116): add
    `consecutiveSyncFailures: { type: "integer", minimum: 0 },` to `properties` (NOT to `required` —
    optional for back-compat).
  - `routes/heartbeat.ts` (lines 19-23): pass `consecutiveSyncFailures: request.body.consecutiveSyncFailures`
    into the `recordHeartbeat` call.
- **PATTERN**: the existing `queuePending` field in both.
- **GOTCHA**: `additionalProperties:false` already on the schema — the new property must be declared or
  a sending collector 400s. Declaring it (optional) is exactly that fix.
- **VALIDATE**: `npm run typecheck`.

### Task 15 — UPDATE collector: `sync-worker.ts` + `heartbeat.ts`
- **IMPLEMENT**:
  - `heartbeat.ts`: add `consecutiveSyncFailures?: number;` to `HeartbeatDeps`; in `maybeSendHeartbeat`
    include `consecutiveSyncFailures: deps.consecutiveSyncFailures ?? 0` in the `post(...)` body.
  - `sync-worker.ts` `runSyncLoop`: track `let consecutiveSyncFailures = 0;`, reset on `"ok"`, `+=1` on
    `"retry"` (snippet above); change `sendHeartbeat` to accept the count and forward it into the
    `maybeSendHeartbeat` deps.
- **PATTERN**: the existing `runSyncLoop` outcome handling (sync-worker.ts:125-143) + the
  `maybeSendHeartbeat` deps build (heartbeat.ts:42-55).
- **GOTCHA**: heartbeat is sent at the TOP of the loop (reports the PRIOR-iterations count — correct).
  Best-effort: a heartbeat send failure is swallowed and does NOT reset/inflate the counter.
- **VALIDATE**: `npm run typecheck`; `npx vitest run apps/collector/src/sync/sync-worker.test.ts`.

### Task 16 — UPDATE `apps/ingest/src/server.ts` (env → webhook deliverer)
- **IMPLEMENT**: after the `rateLimit` block (lines 63-79), build the deliverer:
  ```ts
  // M12 12.6 alert delivery. Disabled unless ALERT_WEBHOOK_URL is set (mirrors ANALYSIS_PROVIDER).
  const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
  const alertDeliverer = createWebhookDeliverer(
    alertWebhookUrl
      ? { url: alertWebhookUrl, timeoutMs: parsePositiveInt(process.env.ALERT_WEBHOOK_TIMEOUT_MS, "ALERT_WEBHOOK_TIMEOUT_MS", 5000) }
      : null,
  );
  ```
  Pass `alertDeliverer` into the `buildApp({...})` call (line 92-102). Import `createWebhookDeliverer`
  from `./delivery/alert-deliverer.js`.
- **PATTERN**: the `analysisConfig`/`rateLimit` env-gated construction.
- **GOTCHA**: `||` vs `??` — `ALERT_WEBHOOK_URL` is a presence check; an empty string → disabled (use
  `process.env.ALERT_WEBHOOK_URL` truthiness, like `analysisProviderName && analysisApiKey`).
- **VALIDATE**: `npm run typecheck`.

### Task 17 — CREATE unit tests
- **IMPLEMENT**:
  - `apps/ingest/src/delivery/alert-deliverer.test.ts`: `createWebhookDeliverer(null)` → `null`; a
    configured deliverer POSTs the firing JSON (stub `globalThis.fetch`, assert URL/method/body),
    throws on a non-2xx (`fetch` resolving `{ ok:false, status:500 }`).
  - Add cases to `packages/shared/src/alerts.test.ts`: `deriveAuthFailureAlerts(2)` → `[]`,
    `(3)` → one `ingest.auth_failure` warning with `since:null`; `deriveArchiveUnreachableAlerts` over a
    machine with `consecutiveSyncFailures:3,status:"online"` → one `archive.unreachable`; `status:"offline"`
    → suppressed; `<3` → none.
- **PATTERN**: existing `alerts.test.ts` (pure derive cases). For fetch stubbing in vitest, assign
  `globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)` and restore.
- **VALIDATE**: `npx vitest run apps/ingest/src/delivery/alert-deliverer.test.ts packages/shared/src/alerts.test.ts`.

### Task 18 — CREATE integration tests (require the test DB)
- **IMPLEMENT**:
  - `packages/db/src/repositories/auth-failures.int.test.ts`: record 3 failures at fixed times; assert
    `countRecentAuthFailures(since)` counts only those in-window; assert prune drops a >7-day-old row.
  - `apps/ingest/src/delivery.int.test.ts`: `buildApp` with a **spy** `alertDeliverer`
    (`{ deliver: vi.fn() }`) and a paired machine in an offline/critical state (or seed an `alert_firings`
    open row directly); GET `/v1/monitor` → assert `deliver` called once with the firing; a SECOND GET →
    `deliver` NOT called again (delivery_attempted_at stamped). Also assert `ingest.auth_failure` appears
    after seeding ≥3 `ingest_auth_failures` rows in-window, and `archive.unreachable` after a heartbeat
    with `consecutiveSyncFailures:3` on an online machine.
- **PATTERN**: `alert-firings.int.test.ts` (TRUNCATE list — **add `ingest_auth_failures` to it**, fixed
  clock, `dbh.db`, seed users/machines); `observability.int.test.ts` (the `buildApp` + `app.inject`
  harness, `describe.skipIf(!TEST_URL)`). Pass `alertDeliverer: { deliver: vi.fn() }` in `buildApp`.
- **GOTCHA**: int tests are EXCLUDED from `tsc -b` (type-stripped by vitest) — but they still must be
  type-correct for the executor's sanity. The `buildApp` call needs `analysisProvider` (use the
  `stubProvider` from observability.int.test.ts) even though these tests don't interpret.
- **VALIDATE**: `npm run db:up && npm run db:migrate` then
  `npx vitest run packages/db/src/repositories/auth-failures.int.test.ts apps/ingest/src/delivery.int.test.ts`.
  > **First migrate the TEST DB too** (memory: `db:migrate` targets the dev DB; the `420ai_test` DB is
  > migrated separately — see `docker/init-test-db.sql` / the `--require-db` flow).

### Task 19 — UPDATE docs + SUMMARY
- **IMPLEMENT**:
  - `.env.example`: add `ALERT_WEBHOOK_URL=` (commented, "POST firing JSON here when an alert opens;
    unset = delivery disabled") + `ALERT_WEBHOOK_TIMEOUT_MS=5000`.
  - `docs/CONTEXT.md`: add an **Alert Delivery** glossary entry after "Alert Firing" (line 149).
  - `docs/guide/operations.md`: add an "Alerts & delivery (12.6)" subsection — the webhook env, the
    at-most-once-attempt semantics, the two new conditions + their thresholds.
  - `SUMMARY.md` §6 item 6 (12.6): flip to **DONE** with the scope note: delivery=webhook;
    `ingest.auth_failure` + `archive.unreachable` shipped; **windowed connector-failure rate +
    SMTP/email + deliver-on-resolve deferred → 12.6b**.
- **VALIDATE**: `git diff --stat` shows the doc edits.

### Task 20 — Full gate
- **VALIDATE**: `npm run repo-health` (PASS), then with Docker up + BOTH DBs migrated:
  `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — must PASS with the new
  `*.int.test.ts` **executed** (0 skipped). Also `npm run typecheck:dashboard` (no dashboard change, but
  the lane must stay green) and `npm run build:dashboard`.

---

## TESTING STRATEGY

### Unit Tests
- `deriveAuthFailureAlerts` / `deriveArchiveUnreachableAlerts`: threshold boundaries, offline
  suppression, `since` shape, key derivation (via `alertKey`).
- `createWebhookDeliverer`: null → null; POST shape; non-2xx → throw; timeout signal passed.
- Collector: `runSyncLoop` increments/resets the counter across `ok`/`retry` outcomes and forwards it to
  the (stubbed) heartbeat post.

### Integration Tests (require `DATABASE_URL_TEST`)
- `auth-failures`: record/count window + prune.
- Delivery e2e via `app.inject`: a spy deliverer is called exactly once per opened firing;
  `delivery_attempted_at` makes a re-read a no-op; the two new alert codes appear given their seeded
  signals.

### Edge Cases (must be covered or explicitly noted)
- **Delivery exactly-once under the 3 s SSE tick** — `delivery_attempted_at` stamped on first attempt
  (success OR failure); no retry spam to a dead webhook.
- **Open-then-resolved within one tick** — the firing flips to `resolved` before the next snapshot, so
  delivery is skipped (open-only). **Documented limitation** (a blip), not a bug.
- **No webhook configured** — `alertDeliverer:null` → `deliverPendingFirings` early-returns (no query).
- **Back-compat heartbeat** — an older collector omits `consecutiveSyncFailures` → server reads
  absent/null → 0 → no false `archive.unreachable`.
- **Auth-failure recording never changes the 401** — fire-and-forget `.catch(()=>{})`.
- **`archive.unreachable` suppressed when offline** — `collector.offline` already covers it; the
  reported count is stale once heartbeats stop.

---

## VALIDATION COMMANDS

All commands run from the repo root. Level 1 is the **root** build (catches cross-project/test-only imports).

### Level 1: Syntax & Type
- `npm run typecheck` → exit 0 (root `tsc -b`, four backend workspaces).
- `npm run typecheck:dashboard` → exit 0 (dashboard's own lane; unchanged but must stay green).

### Level 2: Unit Tests
- `npm test` → all green; `*.int.test.ts` self-skip without `DATABASE_URL_TEST`.

### Level 3: Integration Tests
- `npm run db:up && npm run db:migrate` (dev DB) **and** migrate `420ai_test` (per the memory note) →
  `npm run repo-health -- --require-db` → PASS, asserts the int layer ran (0 skipped).

### Level 4: Manual Validation
- Start a throwaway webhook sink: `node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log('HOOK',b);s.end('ok')})}).listen(9999)"`.
- `ALERT_WEBHOOK_URL=http://localhost:9999 npm run ingest:dev`; force a firing (e.g. seed an open
  `alert_firings` row or let a paired collector go offline > 5 min) and GET `/v1/monitor` with the admin
  bearer; confirm the sink logs the firing JSON **once** (a second GET does not re-POST).
- Confirm `ingest.auth_failure`: POST `/v1/heartbeat` 3× with `Authorization: Bearer wrong` (→ 401),
  then GET `/v1/monitor` → an `ingest.auth_failure` firing appears.

### Level 5: Repo-health gate
- `npm run repo-health -- --require-db` is the single authoritative gate (typecheck + full vitest incl.
  Postgres int + NUL/stray scans).

---

## ACCEPTANCE CRITERIA

- [ ] An opened firing is delivered to the configured webhook **exactly once** (verified by the int spy +
      the `delivery_attempted_at` re-read no-op).
- [ ] Delivery is **disabled by default** (no `ALERT_WEBHOOK_URL`) with zero behavior change to existing
      callers/tests; no new background timer/loop is introduced.
- [ ] `ingest.auth_failure` fires when ≥3 invalid/revoked-token ingest attempts occur within 15 min, and
      resolves when they age out; recording never alters the 401 response.
- [ ] `archive.unreachable` fires per-machine when a collector reports ≥3 consecutive sync failures, is
      suppressed when the machine is offline, and is back-compat with collectors that don't send the field.
- [ ] All three new codes render in the existing `AlertsPanel` with **no dashboard code change**.
- [ ] `deriveAlerts` is byte-for-byte unchanged (the new conditions are siblings, merged via `sortAlerts`).
- [ ] Migration `0010` applies cleanly and its hand-authored `down/` reverses it.
- [ ] `npm run repo-health -- --require-db` passes with the new int tests **executed** (0 skipped).
- [ ] Docs updated: `.env.example`, `CONTEXT.md` (Alert Delivery), `operations.md`, `SUMMARY.md` §6 12.6.

## COMPLETION CHECKLIST

- [ ] Tasks 1-20 done in order; each task's VALIDATE passed before moving on.
- [ ] `npm run typecheck` + `npm run typecheck:dashboard` + `npm run build:dashboard` green.
- [ ] `npm run repo-health -- --require-db` green (int layer ran).
- [ ] Manual webhook + auth-failure validation confirmed.
- [ ] No NUL bytes / stray artifacts (repo-health scans).

---

## NOTES

### Design decisions & trade-offs
- **Webhook over SMTP** (user-confirmed): no new dependency, deterministic to test, covers
  Slack/Discord/n8n/email-bridge. Email is a future `AlertDeliverer` behind the same interface.
- **At-most-once-ATTEMPT delivery** (`delivery_attempted_at` stamped on success OR failure): avoids 3 s
  retry spam to a misconfigured/dead webhook. The **firing row in the dashboard is the durable record** —
  delivery is a convenience notification, not the source of truth. (A retry-with-cap is a 12.6b option.)
- **`archive.unreachable` is collector-reported — honest limitation.** The "Central Archive" is the
  Postgres behind ingest; the server can't self-report it unreachable (it needs the archive to persist
  the very alert). The collector's sync worker is the only component that observes "can't reach the
  archive," so the signal rides the heartbeat (the proven M9 pattern). When ingest→PG is fully down both
  the heartbeat and ingest POSTs fail and the monitor endpoint can't render anything — that total-outage
  case is covered by `collector.offline` (no heartbeat). `archive.unreachable` covers the **partial**
  case (collector reaches ingest, but its batch POSTs keep failing) and the reconnect-with-backlog case.
- **`deliverFirings` as a route helper, not inside `buildSnapshot`** — keeps the load-bearing
  `buildSnapshot(db,userId,now)` signature minimal and the delivery I/O explicitly best-effort/swallowed
  at the route boundary (so a webhook problem never 500s GET `/v1/monitor` or breaks the SSE stream).
- **`deliverPendingFirings` takes an inline structural deliverer type** (`{ deliver(f): Promise<void> } | null`)
  so `@420ai/db` gains NO dependency on `apps/ingest`/`@420ai/shared`'s deliverer type (dependency
  direction preserved).

### Spikes RUN during planning (evidence for the confidence score)
1. **Namespace clean** — `grep` for every new symbol (`alertDeliverer`, `ingest_auth_failures`,
   `consecutive_sync_failures`, `archive.unreachable`, `ingest.auth_failure`, `deliveryAttemptedAt`, …)
   across `packages/`+`apps/` → **NONE** (no collisions).
2. **`AbortSignal.timeout` present on Node 24** — `node -e` → `function` (webhook timeout works without a dep).
3. **`drizzle-kit` resolves** — `npx --no-install drizzle-kit --version` → `v0.31.10` (offline `db:generate`
   flow confirmed; `_journal.json` last idx=9 → next migration `0010`).
4. **Every referenced symbol/signature read from source** (not memory): `reconcileAlertFirings`/`firingColumns`/
   `toFiring` (alert-firings.ts), `buildSnapshot` reconcile + 3 s SSE tick (monitor.ts), `analysisProvider`
   injection (provider.ts + app.ts), `countPendingCatalogs` (pricing-catalogs.ts), `recordHeartbeat`
   (machines.ts), `machineStatuses` Date-coercion gotcha (monitor.ts), `HeartbeatRequest`/`heartbeatBodySchema`,
   `authenticate` preHandler (plugins/auth.ts), the rollback down-file `--> statement-breakpoint` split
   (rollback.ts:42), and the int-test harness (alert-firings.int.test.ts + observability.int.test.ts).
5. **Dashboard needs no change** — `AlertsPanel` switches only on `severity` (read alerts-panel.tsx:79-118).

### Residual risk
- The **exact generated `0010` filename/DDL** is produced by `drizzle-kit generate` at execution time
  (the established offline flow, 9 prior migrations). Task 5 VERIFIES the emitted SQL against the three
  expected statements before proceeding — the one place the executor must read tool output rather than
  follow a literal.
