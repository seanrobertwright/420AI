# Feature: M16 Slice 16.3 — Capture health scorecard

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing.

Pay special attention to the naming of existing utils, types and models. Import from the right files.

Conventions are **not re-pasted here** — they live in [`CLAUDE.md`](../../CLAUDE.md) and are the source
of truth. This plan links to them at the points where they bite.

---

## Feature Description

Research plan §7 **P0.1**, whose acceptance criterion is one sentence:

> _a user can distinguish "no work happened" from "capture is broken."_

Today the archive **cannot** make that distinction, and the reason is structural rather than cosmetic.
Every capture-health signal the server holds is derived from **observed events**:
`connectorHealth` (`packages/db/src/repositories/projections.ts:321`) is a `GROUP BY
events.source_connector`. A connector that is enabled but **broken** emits nothing, so it produces no
row **at all** — byte-identical to a connector that is **disabled**, and byte-identical to a healthy
connector on a day when no work happened. Measured, not assumed (spike **S3** below).

The other half of the answer already exists — on the wrong machine. The collector computes
`ConnectorInfo` (`packages/shared/src/control-protocol.ts:51`) carrying `enabled`, `approval`,
`requiredPermissions`, `knownGaps` and the full fidelity block, and ships it over the **local stdio
control protocol** to the desktop webview. It never reaches the archive.

16.3 closes the loop:

1. **Report** — the collector sends a per-connector inventory on the existing heartbeat.
2. **Persist** — a new org-scoped `machine_connectors` table holds the latest declaration per
   (machine, connector).
3. **Derive** — a pure, clock-injected `deriveCaptureHealth` composes DECLARED × OBSERVED into an
   explicit per-connector state, including the two "cannot tell" states it must not paper over.
4. **Render** — a Capture Health panel replaces the thin Connectors card on `/monitor`.

Two defects found during planning are fixed here because the scorecard is meaningless without them
(both measured — see NOTES → spikes):

- **F-16.3-1** — `collector watch` ignores connector enablement **and** capture-surface approvals.
- **F-16.3-2** — a single connector's capture error **kills the whole capture engine**, and the
  comment claiming otherwise is the defect.

And one live bug the spike surfaced: **`connectorHealth.lastEventAt` returns Postgres text, not
ISO** — the M5/M9 gotcha class, shipped and on the wire today.

## User Story

**As** the sole operator of a 24-week research period
**I want** to open one panel and see, per connector, whether it is capturing, deliberately off,
withheld pending approval, or actually broken — and if broken, the error
**So that** a week with few captured sessions is a fact about my week rather than an unnoticed
outage, and §5.1's capture-coverage figure has a denominator I can defend.

## Problem Statement

The milestone's Risk 2 states the trap directly: _"Measuring the thing you are also building. 16.3 and
16.4 produce the metrics that judge capture quality, and the same operator writes both."_ A scorecard
that cannot represent "I don't know" will silently report a **healthy-looking zero**. That is worse
than no scorecard: it converts an outage into evidence.

Concretely, today:

- A connector whose watch path 404s emits nothing → **invisible**, indistinguishable from idle.
- A connector disabled in the desktop UI still captures under `collector watch` (**F-16.3-1**), so
  D-M16-1's fixed observation set ("Claude Code, Codex CLI, **nothing else**") is not actually in
  force on the primary capture path — the Windows service runs `watch --home …` (CLAUDE.md).
- A connector whose parse throws takes the **entire engine** down (**F-16.3-2**). The server's only
  signal is the heartbeat stopping, which is also what a closed laptop looks like.
- `knownGaps` and `requiredPermissions` — §7 P0.1's "known permission gaps" — exist only on the
  operator's own desktop webview and are absent from the archive entirely.

## Solution Statement

**Report the declaration; join it against the observation; name the states honestly.**

The collector already knows everything §7 P0.1 asks for. The whole design is to move that knowledge
across the existing heartbeat (an additive, optional wire field — the same shape
`consecutiveSyncFailures` used in 12.6) and to keep every judgement in a **pure function** in
`@420ai/shared`, so the classification is unit-testable with no database and 16.4 can reuse it.

Two design rules do the real work:

- **The scorecard has two "cannot tell" states and they are first-class.** `unreported` (events
  observed, no declaring machine — a pre-16.3 collector) and an offline machine are rendered as
  unknown, never as healthy and never as broken. This is the direct mitigation for Risk 2.
- **Silence is only evidence when silence is surprising.** A `streaming`/`near-real-time` connector
  that produced nothing while a **sibling connector on the same machine** did is `silent`
  (suspicious). A `batch`/`snapshot` connector (`claude-export`, `chatgpt-export`) is *expected* to be
  quiet for weeks, so its silence is `idle`. The `liveness` field already carries exactly this
  distinction — no new taxonomy is invented.

## Feature Metadata

**Feature Type**: New Capability (a new read surface over a new reported signal) + 2 defect fixes
**Estimated Complexity**: Medium–High
**Primary Systems Affected**: `packages/shared`, `packages/db`, `apps/ingest`, `apps/collector`,
`apps/dashboard`
**Dependencies**: **None new.** `apps/collector/package.json` declares exactly one dependency
(`@420ai/shared`) — verified, spike **S10**. No Rust/desktop change (the panel is dashboard-only, per
the scope decision).
**Schema change**: **YES** — one additive table (`machine_connectors`) + migration `0025` + a
hand-authored down. No existing table or column is altered.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The observation side you are joining against:**

- `packages/db/src/repositories/projections.ts` (lines 321-397, `connectorHealth` +
  `connectorHealthWindowed`) — Why: the shape you mirror, the terminal-call denominator comment at
  lines 327-330 (do not re-derive it), and **the live bug at line 344**: `lastEventAt: r.lastEventAt
  ?? null` returns `max(ts)` **unnormalized**. Spike S2 measured `"2026-08-01 00:00:00+00"`. Task 3
  fixes it.
- `packages/db/src/repositories/monitor.ts` (lines 38-69 `machineStatuses`, 71-121 `activeSessions`)
  — Why: `machineStatuses` shows the **plain-timestamptz** normalization (`r.lastSeenAt.toISOString()`
  at line 61) that your new table's columns need; `activeSessions` shows the `mode:"string"`
  aggregate normalization that the events side needs. **They are different mechanisms — read both.**
- `packages/shared/src/monitor.ts` (all 139 lines) — Why: `deriveMachineStatus` (line 106) is the
  exact pure/clock-injected shape `deriveCaptureHealth` must copy, `MONITOR_THRESHOLDS` is the
  const-with-a-rationale-per-member pattern, and `MonitorStatus` is an input to your derivation (an
  offline machine ⇒ `unknown`).

**The declaration side you are moving:**

- `packages/shared/src/control-protocol.ts` (all 103 lines, especially `ConnectorInfo` at 51-76) —
  Why: **this is the source shape.** `MachineConnectorReport` is derived from it. Read the 12.7b
  comments at 61-73: `requiredPermissions` is the human-readable capture scope, `watchGlobs` is the
  raw filesystem scope, and `approval: "needs-approval"` means the connector is **withheld from
  capture**. That last fact is what makes it a health state and not a footnote.
- `apps/collector/src/serve.ts` (lines 100-130 `mapConnectorInfo`, 152-174 the registry+seed block,
  239-243 the filter composition) — Why: `mapConnectorInfo` is **private** (`function`, not
  `export function`, line 100 — verified) and you are extracting it; lines 239-243 are the exact
  composition order `runWatch` must mirror in task 14.
- `apps/collector/src/connectors/connector-config.ts` (lines 46-72) — Why: `loadConnectorConfig` +
  `filterConnectors`, and the **default-on** rule (an absent id ⇒ enabled) that both the filter and
  the report must preserve.
- `apps/collector/src/connectors/connector-approvals.ts` (lines 49-54 `ConnectorApprovals`, 122-140
  `approvalStatus`, 141-155 `seedMissingApprovals`, 181-190 `filterByApproval`) — Why: the exact
  helper names and the shape. **NOTE the field is `approved`, not `connectors`** (spike S8 caught
  this — `ConnectorApprovals { version, approved: Record<string, {surfaceFingerprint}> }`).
- `apps/collector/src/capture-engine.ts` (all 303 lines) — Why: line 186 `opts.connectors ??
  defaultConnectors` is where the enabled subset arrives; lines 175-177 and 125-127 are the
  best-effort catch sites; line 276 `Promise.race([watcherLoop, syncLoop])` is what F-16.3-2 kills.
- `apps/collector/src/watcher/file-watcher.ts` (all 111 lines) — Why: **F-16.3-2 lives here.**
  `tickOnce` (57-86) has no try/catch and `runLoop` (89-95) has none either, so a throw from
  `onChange`/`readGrownPrefix` rejects the loop and unwinds the engine. The header comment at lines
  16-18 claims _"if it throws, the cursor is not advanced and the lines are retried next tick"_ —
  **there is no next tick.** The comment is the defect (the CLAUDE.md 15.5 class).
- `apps/collector/src/heartbeat.ts` (all 63 lines) — Why: the file you extend. Note the injected
  clock + `post` seam, and the **swallow** at 60-62 which you must keep while adding an `onError`
  seam.
- `apps/collector/src/ingest-client.ts` (lines 140-157 `postHeartbeat`) — Why: the exact signature
  `(baseUrl, token, body, opts?)` and `requestSignal(opts)` (CLAUDE.md's timeout+abort rule).
- `apps/collector/src/sync/sync-worker.ts` (lines 113-160) — Why: where `maybeSendHeartbeat` is
  called and how `collectorVersion`/`heartbeatIntervalMs` reach it; you thread one more dep through.
- `apps/collector/src/queue/queue-store.ts` (lines 60-100) — Why: the `CREATE TABLE IF NOT EXISTS`
  idiom for `queue_items`/`file_cursors`/`poll_state` that `connector_errors` joins.
- `apps/collector/src/cli.ts` (lines 172-218 `runWatch`) — Why: **F-16.3-1 lives here.** It passes
  `loadRegistry(...)` straight through with no `filterConnectors`/`filterByApproval`.

**Ingest route + schema patterns:**

- `apps/ingest/src/routes/heartbeat.ts` (all 37 lines) — Why: the whole file. `getMachineOrgId` →
  `withOrg(..., SERVICE_ROLE, ...)` → `recordHeartbeat`. You add one call inside the same transaction.
- `apps/ingest/src/schemas.ts` (lines 117-129 `heartbeatBodySchema`) — Why: **`additionalProperties:
  false`**, and the comment at 125-127 stating exactly why an optional field must still be declared.
  This is also the back-compat hazard — see D-16.3-6.
- `apps/ingest/src/routes/monitor.ts` (lines 245-263, the `GET /v1/monitor` handler) — Why: the
  `resolvePrincipal` → `authorized(principal, "viewer")` → `withOrg` shape. **Read the 15.4 comment
  at 61-68**: it explains why *that* route uses `SERVICE_ROLE` (it performs a write). Yours does
  **not** write, so yours uses `principal.role` — the "whose action is this?" test.
- `apps/ingest/src/app.ts` (lines 234-251) — Why: the `app.register(...)` list your new route joins.
- `apps/ingest/src/routes/org-scoping.test.ts` — Why: the structural grep and its **KNOWN LIMIT**
  (one `withOrg(` anywhere exempts the whole file). The behavioural two-role test is the real proof.

**RLS / migration (read before writing task 5):**

- `packages/db/drizzle/0024_lowly_logan.sql` (all of it) — Why: **the exact template.** The
  generated `CREATE TABLE` block, then the HAND-APPENDED policy block. It states verbatim: why
  `drizzle-kit generate` cannot emit policies, why `FORCE ROW LEVEL SECURITY` is required for a
  tenant table, why no `GRANT` is needed (0015's `ALTER DEFAULT PRIVILEGES`), why the org policy
  carries **no explicit `WITH CHECK`**, and the mandatory `nullif(…, '')` guard.
- `packages/db/drizzle/down/0024_lowly_logan.down.sql` — Why: the down-migration commentary standard
  (name what is destroyed and whether the app degrades or 500s).
- `packages/db/src/repositories/rls.int.test.ts` (lines 96-120 `STRICT_TABLES`, 122-165 the other
  four classifications, 515-560 the derived counts) — Why: you add **one** entry to `STRICT_TABLES`.
  **Every count in that file is derived from list lengths — if you find yourself editing an integer
  literal, stop** (the file says so at line 163).
- `packages/db/src/repositories/outcome-labels.int.test.ts` (lines 45-69 `batch()`, 80-100
  `errorChain`/`expectRlsRejection`, 103 `WRITE_ROLE`, 128-157 the `beforeEach` TRUNCATE + seeding,
  176-190 the role-identity test) — Why: **the two-role harness you copy.** Confirmed to exist with
  these exact helpers; the 16.3 spike reused them verbatim and ran green.

**Dashboard patterns:**

- `apps/dashboard/src/components/monitor/monitor-view.tsx` (lines 123-160, the Connectors card) —
  Why: the card you replace, and the `Table`/`TableHead`/`TableCell` idiom.
- `apps/dashboard/src/components/live-monitor.tsx` (all of it) — Why: the SSE island, the 1 s clock
  tick that keeps "N s ago" honest, and the teardown discipline (`return () => source.close()`).
  Your panel mounts inside `MonitorView`, which this renders.
- `apps/dashboard/src/lib/proxy.ts` (lines 34-62 `proxyJson`) — Why: forwards the upstream status
  verbatim, which is what lets the panel tell 403 from 502.
- `apps/dashboard/src/lib/ingest.ts` (lines 15-54) — Why: `ingestUrl`, `adminHeaders`,
  `getIngestJson` (returns `null` on any non-200 or throw).
- `apps/dashboard/src/components/team/team-view.tsx` — Why: the client-island pattern —
  `"use client"`, a `useCallback` loader, `let cancelled = false` **armed before the first await**,
  `FORBIDDEN_MESSAGE` for 403, and the first-paint-seed-only caveat.
- `apps/dashboard/src/lib/format.ts` — Why: `formatDate(iso)` / `formatAgo(iso, nowMs)`. Use them.
- `apps/dashboard/src/lib/mutation-error.ts` — Why: `FORBIDDEN_MESSAGE` / `FORBIDDEN_SHORT`.

**Research + governance:**

- `.agents/supplemental docs/research-analysis-plan.md` §7 P0.1 (lines 368-371) — the seven required
  signals and the one-sentence acceptance criterion. §10 (lines 446-485) — the weekly scorecard
  template, whose "Stale/unhealthy connectors" row this slice populates. §5.1 — the metric targets.
- `.agents/plans/m16-dogfood-instrumentation.md` — the non-goals (name them in the PR), **D-M16-1**
  (the fixed observation set that F-16.3-1 currently defeats), Risk 2, and the pre-sign-off checklist
  item this slice owns: _"the capture health scorecard distinguishes 'no work happened' from 'capture
  is broken' on a **deliberately broken** connector, not merely a healthy one."_

### New Files to Create

| Path                                                              | Purpose                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/shared/src/capture-health.ts`                           | Wire types + `deriveCaptureHealth` (pure, clock-injected) + thresholds |
| `packages/shared/src/capture-health.test.ts`                      | Unit tests for the derivation — the state table, exhaustively          |
| `packages/db/src/repositories/capture-health.ts`                  | `replaceMachineConnectors` (upsert+prune) + `captureHealthInputs`      |
| `packages/db/src/repositories/capture-health.int.test.ts`         | Two-role suite (role identity first)                                   |
| `packages/db/drizzle/0025_*.sql`                                  | `machine_connectors` + hand-appended policy block                      |
| `packages/db/drizzle/down/0025_*.down.sql`                        | Hand-authored down                                                    |
| `apps/ingest/src/routes/capture-health.ts`                        | `GET /v1/capture-health`                                               |
| `apps/ingest/src/capture-health.int.test.ts`                      | HTTP role gates + the behavioural app-role test                        |
| `apps/collector/src/connectors/connector-info.ts`                 | `mapConnectorInfo` (extracted) + `toMachineConnectorReport`            |
| `apps/collector/src/connectors/connector-info.test.ts`            | Mapping + the `watchGlobs` exclusion assertion (D-16.3-3)              |
| `apps/dashboard/src/app/api/capture-health/route.ts`              | Proxy → `GET /v1/capture-health`                                       |
| `apps/dashboard/src/components/monitor/capture-health-panel.tsx`  | The panel that replaces the Connectors card                            |
| `apps/dashboard/src/lib/capture-health-display.ts`                | **Pure** state → label/description/tone maps                           |
| `apps/dashboard/src/lib/capture-health-display.test.ts`           | Exhaustiveness over the shared state union                             |

### Files to Update

| Path                                                    | Change                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/shared/src/ingest.ts`                         | `HeartbeatRequest.connectors?: MachineConnectorReport[]` (optional)          |
| `packages/shared/src/index.ts`                          | Re-export the new module                                                    |
| `packages/db/src/schema.ts`                             | `machineConnectors` table + its classification comment                       |
| `packages/db/src/index.ts`                              | Re-export the two repository functions                                       |
| `packages/db/src/repositories/projections.ts`           | **Fix `connectorHealth.lastEventAt` normalization** (+ windowed sibling)      |
| `packages/db/src/repositories/rls.int.test.ts`          | Add `machine_connectors` to `STRICT_TABLES` — **no integer literal edits**   |
| `apps/ingest/src/schemas.ts`                            | Declare `connectors` on `heartbeatBodySchema`                                |
| `apps/ingest/src/routes/heartbeat.ts`                   | Persist the reported inventory in the same transaction                       |
| `apps/ingest/src/app.ts`                                | Register `captureHealthRoutes`                                               |
| `apps/collector/src/serve.ts`                           | Import the extracted `mapConnectorInfo`; delete the local copy               |
| `apps/collector/src/queue/queue-store.ts`               | `connector_errors` table + `recordConnectorError` + `connectorErrors`         |
| `apps/collector/src/watcher/file-watcher.ts`            | **F-16.3-2**: per-file try/catch → `onError(connector, err)`, loop continues  |
| `apps/collector/src/capture-engine.ts`                  | `registry` option; wire `onError`; record poll errors; pass reports to sync   |
| `apps/collector/src/sync/sync-worker.ts`                | Thread `connectorReports` into `maybeSendHeartbeat`                          |
| `apps/collector/src/heartbeat.ts`                       | Send `connectors`; add the `onError` seam (a 400 must not be silent)          |
| `apps/collector/src/cli.ts`                             | **F-16.3-1**: apply seed + both filters in `runWatch`                        |
| `apps/dashboard/src/components/monitor/monitor-view.tsx`| Replace the Connectors card with `<CaptureHealthPanel />`                     |
| `docs/guide/operations.md`                              | A "Reading the capture health scorecard" section + the F-16.3-1 behaviour change |
| `.agents/plans/m16-dogfood-instrumentation.md`          | Correct the **stale D3 row** (see D-16.3-1)                                  |
| `SUMMARY.md`                                            | Flip **16.3** to ✅ in §0 and §6 (same commit as the execution report)        |

### Relevant Documentation

- [PostgreSQL — `INSERT … ON CONFLICT DO UPDATE`](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT)
  - Section: conflict_target and the `excluded` pseudo-table
  - Why: the upsert half of `replaceMachineConnectors`. The conflict target must be the
    `(machine_id, connector_id)` **unique index**, not the primary key.
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
  - Section: `FORCE ROW LEVEL SECURITY`, PERMISSIVE vs RESTRICTIVE combination
  - Why: the hand-appended block. **Prefer `0024_lowly_logan.sql` to these docs** — it encodes this
    repo's decisions, not just the mechanism.
- [Drizzle — `leftJoin`](https://orm.drizzle.team/docs/joins#left-join) and
  [`onConflictDoUpdate`](https://orm.drizzle.team/docs/insert#on-conflict-do-update)
  - Why: the two query shapes. **The snippets below are the verified ones — prefer them.**
- [Node — `node:sqlite` `DatabaseSync`](https://nodejs.org/api/sqlite.html#class-databasesync)
  - Section: `exec`, `prepare`, `StatementSync.run/all`
  - Why: `connector_errors`. Spike **S9** ran the exact `CREATE TABLE` + `ON CONFLICT DO UPDATE`
    below against a real `DatabaseSync` and it worked (`count` reached 2). The
    `ExperimentalWarning` on import is by design (CLAUDE.md) — do not suppress it.

### Patterns to Follow

**The DECLARED × OBSERVED join.** Transcribed from the planning spike that ran green against the live
`420ai_test` database (NOTES → S4/S5). Assertions stated beside it so drift is detectable.

```ts
// packages/db/src/repositories/capture-health.ts
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { events, machineConnectors, machines } from "../schema.js";

/** Postgres text → strict ISO. The `mode:"string"` aggregate rule — see the S2 note below. */
const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

/**
 * Every DECLARED (machine, connector) pair with whatever was OBSERVED for it.
 *
 * THE JOIN IS ON `machine_id`, NOT ON `connector_id` ALONE, and that choice is the whole
 * correctness story — see the spike note below for what the connector-id-only version did.
 */
export async function declaredConnectorHealth(
  db: DbClient,
  orgId: string,
): Promise<DeclaredConnectorRow[]> {
  const rows = await db
    .select({
      machineId: machineConnectors.machineId,
      connectorId: machineConnectors.connectorId,
      enabled: machineConnectors.enabled,
      approval: machineConnectors.approval,
      liveness: machineConnectors.liveness,
      captureMethod: machineConnectors.captureMethod,
      tokens: machineConnectors.tokens,
      cost: machineConnectors.cost,
      knownGaps: machineConnectors.knownGaps,
      requiredPermissions: machineConnectors.requiredPermissions,
      custom: machineConnectors.custom,
      lastErrorMessage: machineConnectors.lastErrorMessage,
      lastErrorAt: machineConnectors.lastErrorAt,
      errorCount: machineConnectors.errorCount,
      reportedAt: machineConnectors.reportedAt,
      // ── AGGREGATES over `events.ts`, which is `mode:"string"`. See S2.
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      parserVersions: sql<string[]>`coalesce(array_agg(distinct ${events.parserVersion}) filter (where ${events.parserVersion} is not null), '{}')`,
    })
    .from(machineConnectors)
    .leftJoin(
      events,
      and(
        eq(events.machineId, machineConnectors.machineId),
        eq(events.sourceConnector, machineConnectors.connectorId),
        // Defence in depth + RLS alignment — NOT what makes this correct. See the note.
        eq(events.orgId, machineConnectors.orgId),
      ),
    )
    .where(eq(machineConnectors.orgId, orgId))
    .groupBy(
      machineConnectors.machineId,
      machineConnectors.connectorId,
      machineConnectors.enabled,
      machineConnectors.approval,
      machineConnectors.liveness,
      machineConnectors.captureMethod,
      machineConnectors.tokens,
      machineConnectors.cost,
      machineConnectors.knownGaps,
      machineConnectors.requiredPermissions,
      machineConnectors.custom,
      machineConnectors.lastErrorMessage,
      machineConnectors.lastErrorAt,
      machineConnectors.errorCount,
      machineConnectors.reportedAt,
    )
    .orderBy(machineConnectors.machineId, machineConnectors.connectorId);
  return rows.map((r) => ({
    ...r,
    // ── MANDATORY. Asserted by S2/S4; NOT optional, NOT already ISO.
    lastEventAt: toIso(r.lastEventAt),
    // ── A PLAIN timestamptz column comes back as a JS Date — a DIFFERENT mechanism to the
    //    aggregate above. `machineStatuses` (monitor.ts:61) is the precedent.
    lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null,
    reportedAt: r.reportedAt.toISOString(),
    knownGaps: r.knownGaps ?? [],
    requiredPermissions: r.requiredPermissions ?? [],
    parserVersions: r.parserVersions ?? [],
  }));
}
```

> **Spike assertions this snippet must keep satisfying** (fold them into the int test):
>
> - **S2** — `max(events.ts)` came back as `"2026-08-01 00:00:00+00"`, i.e. **Postgres text, not
>   ISO** (`raw === new Date(raw).toISOString()` was `false`). The `toIso` call is the fix. This is
>   the M5 `lastActivity` / M9 `activeSessions` bug class (CLAUDE.md "Drizzle / SQL gotchas"), and
>   S2 also proved it is **live in `connectorHealth` right now** — hence task 3.
> - **S4** — the LEFT JOIN returns the declared-but-silent connector with `event_count === 0`
>   (typeof `number`, because of the `::int` cast) and `last_event_at === null`. This is the row
>   that does not exist today.
> - **S5, the negative control** — with the join written on `connector_id` alone, org A's silent
>   `cursor` row inherited **org B's** cursor events: count `1` where the truth is `0`. Measured on
>   the **owner** handle, so it measures the predicate and not RLS.
> - **Read the mechanism honestly.** The final query joins on `machine_id` (a uuid, globally unique,
>   whose org is fixed by `machines.org_id` per D-M15-1), so the S5 failure is **structurally
>   impossible here** — the org predicate is defence-in-depth, not the thing making it correct.
>   Do **not** write a comment claiming the org predicate is what prevents the merge; the 15.5
>   lesson is that a comment naming the wrong mechanism is worse than no comment, because the next
>   reader trusts it instead of re-deriving it. **Name `machine_id`.**

**The pure derivation** (`packages/shared/src/capture-health.ts`). This is where every judgement
lives, so that none of them require a database to test:

```ts
/**
 * Per-connector capture health (research plan §7 P0.1).
 *
 * THE ACCEPTANCE CRITERION IS A DISTINCTION, NOT A NUMBER: "a user can distinguish 'no work
 * happened' from 'capture is broken'." So the state union below is designed around what the
 * evidence can actually support, and it carries TWO states that mean "cannot tell". Those are not
 * gaps — they are the mitigation for the milestone's Risk 2 (the operator builds and grades the
 * same instrument). A scorecard with no way to say "unknown" reports a healthy-looking zero.
 */
export type CaptureHealthState =
  /** Enabled, approved, events inside the freshness window. Working. */
  | "healthy"
  /** Enabled, approved, no recent events — and nothing suggests otherwise. NO WORK HAPPENED. */
  | "idle"
  /** The collector reported an error at or after the last successful event. BROKEN. */
  | "erroring"
  /** Withheld from capture pending §10.4 re-approval (12.7b). A KNOWN PERMISSION GAP. */
  | "needs-approval"
  /** Declared `enabled:false`. No work is EXPECTED — the honest zero. */
  | "disabled"
  /** A live-capture connector produced nothing while a SIBLING on the same machine did. SUSPECT. */
  | "silent"
  /** Events observed, but no machine declares this connector (a pre-16.3 collector). UNKNOWN. */
  | "unreported"
  /** The machine has not heartbeat recently — its declaration is stale. UNKNOWN. */
  | "unknown";

/** Which states answer which half of the P0.1 question. Exported so the UI cannot re-decide it. */
export const CAPTURE_HEALTH_VERDICT = {
  healthy: "capturing",
  idle: "capturing",
  disabled: "not-capturing",
  erroring: "broken",
  silent: "broken",
  "needs-approval": "broken",
  unreported: "unknown",
  unknown: "unknown",
} as const satisfies Record<CaptureHealthState, CaptureHealthVerdict>;
```

> **Why `silent` is gated on `liveness`.** `claude-export` / `chatgpt-export` / `gemini-export` are
> `batch` connectors: they capture when the operator drops an export file in, which may be never.
> Flagging their quiet as suspicious would put a permanent false red on the scorecard and train the
> operator to ignore it — the exact failure mode §4.3 avoids for labels. So `silent` applies **only**
> to `liveness === "streaming" | "near-real-time"`, and a batch connector's quiet is `idle`. The
> `liveness` field already carries this (`control-protocol.ts:56`); no new taxonomy is invented.

**The `connector_errors` local store** (verified by spike S9 against a real `DatabaseSync`):

```sql
CREATE TABLE IF NOT EXISTS connector_errors (
  connector_id TEXT PRIMARY KEY,
  message      TEXT NOT NULL,
  at           TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1
);
```

```sql
INSERT INTO connector_errors (connector_id, message, at, count)
VALUES (?, ?, ?, 1)
ON CONFLICT(connector_id) DO UPDATE SET
  message = excluded.message, at = excluded.at, count = connector_errors.count + 1
```

**Repository conventions this slice must follow** (all already in `outcome-labels.ts` / `monitor.ts`):

- `orgId` is **always the second parameter** (D-15.2-4).
- Silent library — throws typed errors, never logs, never touches stdout.
- **Explicit column lists.** No ingest route declares a Fastify `response` schema, so a bare
  `select()`/`returning()` puts every future column on the wire (CLAUDE.md 15.1). **`org_id` must not
  appear on any returned row.**
- Do **not** call `withOrg` inside a repository function; the route wraps it.
- Clocks are injected. `deriveCaptureHealth(inputs, nowMs)` — never `Date.now()` inside.

**Anti-patterns to avoid (each has bitten this repo or was measured during planning):**

- ❌ Treating a missing connector row as "disabled". It is `unreported` — a pre-16.3 collector
  reports nothing, and asserting "disabled" would be a fabricated fact (Risk 2).
- ❌ Describing an aggregate timestamp as "already ISO — do not re-coerce". That exact phrasing in an
  M5 plan shipped the `lastActivity` bug; S2 shows the hazard is live in this very query family.
- ❌ Joining declared × observed on `connector_id` alone (S5 reproduces the tenant merge).
- ❌ Editing an integer literal in `rls.int.test.ts`. Every count there is derived from list lengths
  (the file says so at line 163) — add to `STRICT_TABLES` and the numbers move themselves.
- ❌ Wrapping `GET /v1/capture-health` in `SERVICE_ROLE`. That is `routes/monitor.ts`'s answer
  **because it writes**; this route is a pure read on the caller's behalf → `principal.role`.
- ❌ Sending `watchGlobs` to the archive (D-16.3-3 — they are absolute paths under the operator's
  home directory).
- ❌ A `useEffect` whose teardown is armed after the first `await` (CLAUDE.md; `team-view.tsx` shows
  the `let cancelled = false` form).
- ❌ "Fixing" F-16.3-2 by catching in `runLoop` instead of per-file. A loop-level catch skips every
  remaining file in the tick; a per-file catch is what makes the header comment true.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the contract and the pure derivation

`@420ai/shared` first: the wire types, the state union, and `deriveCaptureHealth`. Everything
downstream (the repository's return shape, the route, both test layers, the panel) references these,
and the derivation is fully unit-testable before a single row exists.

### Phase 2: Core — persist and serve

The table + migration + hand-appended policies, the repository (upsert+prune and the join), the
heartbeat write, and the new read endpoint. Also the standalone `connectorHealth` ISO fix.

### Phase 3: Integration — make the collector tell the truth

The two defect fixes (F-16.3-1 enablement/approval in `watch`; F-16.3-2 per-file error isolation),
the local `connector_errors` store, and the report on the heartbeat. Then the dashboard panel.

### Phase 4: Testing & Validation

A two-role repository suite (role identity first), HTTP role gates plus the behavioural app-role
test, pure unit tests for the derivation and the display maps, the full gate with `--require-db`, and
the **deliberately-broken-connector** manual round-trip the milestone checklist names.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently testable.

### 1. CREATE `packages/shared/src/capture-health.ts`

- **IMPLEMENT**: `MachineConnectorReport`, `DeclaredConnectorRow`, `ObservedConnectorRow`,
  `CaptureHealthRow`, `CaptureHealthState`, `CaptureHealthVerdict`, `CAPTURE_HEALTH_VERDICT`,
  `CAPTURE_HEALTH_THRESHOLDS`, `CAPTURE_HEALTH_VERSION`, and
  `deriveCaptureHealth(inputs, nowMs): CaptureHealthRow[]`.
- **PATTERN**: `packages/shared/src/monitor.ts` — pure, dependency-free, clock-injected, one
  rationale comment per threshold member.
- **IMPORTS**: `type ConnectorInfo` and `type ConnectorCatalogLiveness` are already in this package
  (`control-protocol.ts` / `connector-catalog.ts`) — reuse them, do **not** re-type the unions.
  Define `MachineConnectorReport` as `Omit<ConnectorInfo, "watchGlobs"> & { lastErrorMessage,
  lastErrorAt, errorCount }` so it cannot drift from the source shape.
- **GOTCHA — D-16.3-3**: the `Omit<…, "watchGlobs">` is load-bearing and must be commented as such.
  `watchGlobs` are absolute paths under the operator's home (`C:\Users\<name>\.claude\**`), so
  sending them to the archive writes the operator's username and directory layout into a database
  that a design partner will later be asked to trust (§7 P0.4). `requiredPermissions` is the
  human-readable scope designed for exactly this review, and it **is** sent.
- **GOTCHA**: `CAPTURE_HEALTH_VERSION` is the sibling of `MONITOR_VERSION`/`CONTROL_PROTOCOL_VERSION`
  — a shape stamp (D11, PRD §23). Start at `"m16-capture-health-v1"`.
- **GOTCHA**: `deriveCaptureHealth` takes the machine's `MonitorStatus` per row. An offline machine
  ⇒ `unknown`, evaluated **before** every other branch — a stale declaration must never be read as
  a current fact.
- **GOTCHA**: the freshness window is **not** `ACTIVE_WINDOW_MS`. That constant means "a session is
  in progress" (15 min); capture health asks "has this connector produced anything lately", which is
  a working-day question. Use a separate `freshEventMs` and say in the comment why it is *not*
  reused — 16.2's D-16.2-2 deliberately shared `ACTIVE_WINDOW_MS` between two surfaces that must
  agree, and this is the opposite case.
- **VALIDATE**: `npx tsc -b packages/shared`

### 2. CREATE `packages/shared/src/capture-health.test.ts` + UPDATE `packages/shared/src/index.ts`

- **IMPLEMENT**: a table-driven unit test covering **every** member of `CaptureHealthState`, plus:
  the `liveness` gate (a `batch` connector with no events is `idle`, a `streaming` one with a
  producing sibling is `silent`), the offline-machine override, and an exhaustiveness loop asserting
  `CAPTURE_HEALTH_VERDICT` has a key for every state.
- **ADD**: `export * from "./capture-health.js";` to the barrel, beside the `monitor.js` line.
- **GOTCHA**: `nowMs` is a fixed literal in every case. A test using the wall clock passes today and
  fails in some future minute.
- **VALIDATE**: `npx vitest run packages/shared/src/capture-health.test.ts` && `npm run typecheck`

### 3. FIX `packages/db/src/repositories/projections.ts` — the live ISO bug

- **REFACTOR**: in **both** `connectorHealth` (line ~344) and `connectorHealthWindowed` (line ~390),
  replace `lastEventAt: r.lastEventAt ?? null` with a `toIso` normalization identical to
  `monitor.ts:85`.
- **GOTCHA**: this is a **behaviour change on a shipped endpoint** — `GET /v1/monitor`'s
  `connectors[].lastEventAt` currently emits `"2026-08-01 00:00:00+00"` and will emit
  `"2026-08-01T00:00:00.000Z"`. That is the documented contract (`ConnectorHealthRow` is typed as an
  ISO string) so this is a fix, not a break; say so in the commit message and note it in the
  execution report.
- **GOTCHA**: add the one-line "why" comment naming the `mode:"string"` aggregate mechanism, so the
  next reader does not re-introduce it. Do **not** touch the terminal-call denominator comment.
- **ADD**: an assertion in the nearest existing int test that the value round-trips
  (`v === new Date(v).toISOString()`).
- **VALIDATE**: `npm run typecheck` && `npx vitest run apps/ingest/src/app.int.test.ts`

### 4. UPDATE `packages/db/src/schema.ts` — the `machineConnectors` table

- **IMPLEMENT**: the table exactly as in the migration below: `id` uuid pk, `orgId` → organizations,
  `machineId` → machines, `connectorId` text, `enabled` boolean, `approval` text, `status` text,
  `captureMethod` text, `liveness` text, `tokens` text, `cost` text, `knownGaps` text[] default
  `'{}'`, `requiredPermissions` text[] default `'{}'`, `custom` boolean default false,
  `lastErrorMessage` text, `lastErrorAt` timestamptz, `errorCount` integer default 0, `reportedAt`
  timestamptz default now. A **unique** index on `(machineId, connectorId)` and an index on `orgId`.
- **PATTERN**: `machineHeartbeats` (schema.ts:802-821) for the org/machine FK pair and the index
  style; `outcomeLabels` (schema.ts:1176+) for the STRICT classification header comment.
- **GOTCHA**: the timestamptz columns are **plain** (`mode` unset ⇒ JS `Date`), matching `machines`.
  That is deliberate: the repository does a direct select on them, never an aggregate, so the
  `machineStatuses` `.toISOString()` mechanism applies and the `mode:"string"` aggregate hazard does
  not. **Write that distinction into the comment** — the two mechanisms sit ten lines apart in this
  slice's own repository file.
- **GOTCHA**: write the CLASSIFICATION comment (STRICT, and why it is not each of the other four),
  mirroring `schema.ts:1176` and `1250`. Short version to expand: not BOOTSTRAP (nothing reads it to
  *discover* an org — the heartbeat route already resolved the org from `machines`); not APPEND_ONLY
  (it has a real per-tenant read path, and the prune step must DELETE); not NO_RLS (it carries
  `org_id` and tenant content).
- **VALIDATE**: `npm run typecheck`

### 5. GENERATE + HAND-EDIT migration `0025` and author its down

- **IMPLEMENT**: `npm run db:generate`, then **hand-append** the policy block to the generated file:
  `ENABLE` + `FORCE ROW LEVEL SECURITY`, one PERMISSIVE org policy using
  `org_id = nullif(current_setting('app.current_org', true), '')::uuid`, and the three 0016
  RESTRICTIVE role policies (INSERT/UPDATE `WITH CHECK`, DELETE `USING`).
- **PATTERN**: `packages/db/drizzle/0024_lowly_logan.sql` — copy its header-comment structure and its
  policy block verbatim, substituting the table name.
- **CREATE**: `packages/db/drizzle/down/0025_*.down.sql` — a single `DROP TABLE IF EXISTS
  "machine_connectors";` plus the commentary standard. **State the honest impact**, which is
  unusually mild and worth saying so: unlike 0024, this table is a **projection of a live signal**
  — the collector re-reports its whole inventory on the next heartbeat (≤30 s), so the rows rebuild
  themselves. The only unrecoverable loss is historical `errorCount`, and the collector holds that
  in `queue.sqlite` anyway. A post-16.3 server on a pre-16.3 schema 500s the heartbeat write and
  `GET /v1/capture-health`; roll the code back with the schema.
- **GOTCHA**: `drizzle-kit generate` **cannot** emit `CREATE POLICY` or `ENABLE ROW LEVEL SECURITY`.
  Never re-run `db:generate` expecting the appended block to survive — re-append it.
- **GOTCHA**: no `GRANT` is needed — 0015's `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables
  created by the migration owner (0024 re-verified this live).
- **GOTCHA**: the `nullif(…, '')` guard is mandatory. `current_setting(x, true)` returns `''` when
  unset and `''::uuid` raises `invalid input syntax for type uuid` — a backstop must fail closed and
  **quiet**.
- **VALIDATE**: `npm run db:migrate` then
  `docker exec 420ai-archive psql -U 420ai -d 420ai_test -c "\d machine_connectors"` — and migrate
  the **test** database separately (it is not covered by `db:migrate`).

### 6. UPDATE `packages/db/src/repositories/rls.int.test.ts`

- **ADD**: `"machine_connectors"` to `STRICT_TABLES`, with a one-line comment naming the slice.
- **GOTCHA**: **do not edit any integer literal.** Every count in that file is derived from list
  lengths; the file says so explicitly at line 163. If a number needs changing, you have added the
  table to the wrong list.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts` — all pass, 0 skipped.

### 7. CREATE `packages/db/src/repositories/capture-health.ts`

- **IMPLEMENT**: two functions.
  - `replaceMachineConnectors(db, orgId, machineId, reports, now)` — **upsert then prune**:
    `insert().values(...).onConflictDoUpdate({ target: [machineConnectors.machineId,
    machineConnectors.connectorId], set: {...} })`, then
    `delete(machineConnectors).where(and(eq(machineId), notInArray(connectorId, ids)))`.
    An **empty** `reports` array must prune everything for that machine (guard `notInArray` against
    an empty list — Drizzle emits invalid SQL for `not in ()`; branch to a plain
    `eq(machineId)` delete).
  - `declaredConnectorHealth(db, orgId)` — the join snippet in PATTERNS above.
  - `observedOnlyConnectors(db, orgId, declaredKeys)` — the `unreported` set: `connectorHealth`'s
    aggregation restricted to `(machineId, sourceConnector)` pairs absent from `declaredKeys`.
    Simplest correct form: aggregate all `(machine_id, source_connector)` pairs and let the **pure**
    `deriveCaptureHealth` do the set difference. Prefer that — it moves a decision out of SQL and
    into a unit-tested function.
- **PATTERN**: `packages/db/src/repositories/monitor.ts` (org-scoped reads) and
  `packages/db/src/repositories/outcome-labels.ts` (the explicit-column-list constant idiom).
- **GOTCHA**: `orgId` second. No `withOrg` inside. No logging. **No `orgId` on any returned row.**
- **GOTCHA**: the upsert's conflict target is the **unique index** `(machine_id, connector_id)`, not
  the `id` primary key.
- **GOTCHA**: `errorCount` and `lastError*` come from the collector, which is their source of truth
  (`queue.sqlite`). The server **overwrites** them on every report and never accumulates its own —
  two counters would diverge and the operator would not know which to believe.
- **VALIDATE**: `npm run typecheck`

### 8. UPDATE `packages/db/src/index.ts`

- **ADD**: `export { replaceMachineConnectors, declaredConnectorHealth, observedOnlyConnectors } from "./repositories/capture-health.js";`
  and re-export `machineConnectors` from the schema.
- **PATTERN**: the adjacent `outcome-labels.js` re-export line.
- **VALIDATE**: `npm run typecheck` — a missing re-export surfaces here, not at the route.

### 9. CREATE `packages/db/src/repositories/capture-health.int.test.ts`

- **IMPLEMENT**: a **two-role** suite, `describe.skipIf(!TEST_URL || !APP_URL)`. Tests:
  1. **Role identity first** — `is_superuser = 'off'`, `rolbypassrls = false`, `current_user =
     '420ai_app'`. Without it the file is theatre (CLAUDE.md).
  2. Unset org context ⇒ `machine_connectors` reads **0 rows** and does not error.
  3. A cross-org INSERT is rejected **loudly** (`expectRlsRejection` — `new row violates row-level
     security policy`).
  4. `replaceMachineConnectors` upserts: reporting the same connector twice leaves **one** row with
     the second report's values.
  5. `replaceMachineConnectors` **prunes**: a connector dropped from the report is deleted; an empty
     report prunes all of that machine's rows.
  6. Pruning is **machine-scoped** — machine B's rows survive machine A's replace.
  7. `declaredConnectorHealth` returns a **declared-but-silent** connector with `eventCount === 0`
     and `lastEventAt === null` (the row that does not exist today — S3/S4).
  8. `lastEventAt` **round-trips as ISO** (`v === new Date(v).toISOString()`) — the S2 regression pin.
  9. **The cross-org control**: seed the same `connectorId` in orgs A and B with events only in B;
     assert org A's row reports `eventCount === 0`. On the **owner** handle, so it measures the
     query rather than RLS.
  10. **No left-join fan-out**: a machine with N events for one connector yields ONE row with
      `eventCount === N`.
  11. Under the **app role** inside `withOrg`, the result matches the owner's.
- **PATTERN**: `packages/db/src/repositories/outcome-labels.int.test.ts` — reuse `batch()` (add a
  `connector` + `ts` parameter, as the 16.3 spike did), `errorChain`, `expectRlsRejection`,
  `WRITE_ROLE = "member"`, `ensurePersonalOrg`, `ingestBatch`, and the `beforeEach` TRUNCATE block.
- **GOTCHA**: the TRUNCATE list must include `machine_connectors` **before** `machines` (FK).
- **GOTCHA**: inject a fixed `now`; seed event timestamps relative to it.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/capture-health.int.test.ts` — **11
  passed, 0 skipped.** A "skipped" report means `DATABASE_URL_TEST`/`_APP` are unset and the suite
  proved nothing.

### 10. UPDATE `packages/shared/src/ingest.ts` + `apps/ingest/src/schemas.ts`

- **ADD**: `connectors?: MachineConnectorReport[]` to `HeartbeatRequest`, with the same
  "optional → back-compat with older collectors" comment style as `consecutiveSyncFailures`
  (ingest.ts:76).
- **ADD**: the matching `connectors` property to `heartbeatBodySchema` — an array of objects with
  `additionalProperties: false` and the required keys.
- **GOTCHA — D-16.3-6, and it is the sharpest edge in this slice**: `heartbeatBodySchema` carries
  `additionalProperties: false`, so a **newer collector against an older server 400s the entire
  heartbeat** — and `maybeSendHeartbeat` swallows the failure (heartbeat.ts:60-62). The machine then
  goes `offline` in the Live Monitor with no error anywhere. That is precisely the silent-failure
  class this slice exists to end, so it may **not** be left silent: task 17 adds an `onError` seam
  and the engine logs it. Deploy order is archive-then-collector; state that in
  `docs/guide/operations.md`.
- **GOTCHA**: bound the array (`maxItems`) and the string fields (`maxLength`) — this body is written
  to the database by a machine-authed caller every 30 s.
- **VALIDATE**: `npm run typecheck`

### 11. UPDATE `apps/ingest/src/routes/heartbeat.ts`

- **ADD**: inside the existing `withOrg(..., SERVICE_ROLE, ...)` transaction, after
  `recordHeartbeat`, call `replaceMachineConnectors(tx, orgId, request.machineId,
  request.body.connectors ?? [], new Date())` — **only when `request.body.connectors !== undefined`.**
- **GOTCHA — the `undefined` vs `[]` distinction is load-bearing.** `undefined` means *this collector
  does not report* (pre-16.3) and must leave existing rows alone; `[]` means *this collector reports
  zero connectors* and must prune. Collapsing them would let a collector downgrade silently wipe the
  inventory, or let an older collector's silence be read as "no connectors".
- **GOTCHA**: `SERVICE_ROLE` is correct here and unchanged — this is a machine-authed write with no
  membership role, exactly like `recordHeartbeat`. It also passes the 0016 restrictive INSERT policy
  (`<> 'viewer'`).
- **GOTCHA**: keep it in the **same transaction** — a heartbeat that records liveness but loses the
  inventory is the split state the scorecard would then misreport.
- **VALIDATE**: `npm run typecheck` && `npx vitest run apps/ingest/src/app.int.test.ts`

### 12. CREATE `apps/ingest/src/routes/capture-health.ts` + register it

- **IMPLEMENT**: `GET /v1/capture-health` — `resolvePrincipal` → 401; `authorized(principal,
  "viewer")` → 403; then `withOrg(app.db, principal.orgId, principal.role, (tx) => …)` running
  `machineStatuses`, `declaredConnectorHealth` and the observed aggregation, composed by
  `deriveCaptureHealth(inputs, Date.now())`. Reply `{ captureHealthVersion, generatedAt, rows }`.
- **PATTERN**: `apps/ingest/src/routes/monitor.ts:245-263` for the gate shape; `buildSnapshot`'s
  header for the "route owns the clock" rule.
- **UPDATE**: `apps/ingest/src/app.ts` — `app.register(captureHealthRoutes);` beside
  `app.register(monitorRoutes);`.
- **GOTCHA**: **`principal.role`, NOT `SERVICE_ROLE`.** `routes/monitor.ts` uses `SERVICE_ROLE`
  *because it performs the evaluate-on-read reconcile write*; this route writes nothing, so it runs
  as the caller (the 15.4 "whose action is this?" test). Say so in the handler comment, because the
  neighbouring file does the opposite and the next reader will compare them.
- **GOTCHA**: reads are **SEQUENTIAL, not `Promise.all`** — `tx` is one connection and node-postgres
  queues concurrent queries on it (the 15.3 note at `monitor.ts:81-86`).
- **GOTCHA**: no new `app.ts` error mapping — this route adds no typed error.
- **VALIDATE**: `npm run typecheck` && `npx vitest run apps/ingest/src/routes/org-scoping.test.ts`

### 13. CREATE `apps/ingest/src/capture-health.int.test.ts`

- **IMPLEMENT**: (a) 401 with no principal; (b) `viewer` **succeeds** (it is the floor — document
  that there is no rung below it); (c) **the behavioural app-role test**: POST a heartbeat carrying
  a connector inventory, then `GET /v1/capture-health` returns the declared-but-silent connector
  with state `idle`/`silent`, and a connector with a reported error comes back `erroring`.
- **PATTERN**: `apps/ingest/src/outcome-labels.int.test.ts` role-gate tests; `seedBootstrapKey` from
  `./test-support/bootstrap-key.js` for the principal.
- **GOTCHA**: (c) is the **behavioural half** of CLAUDE.md's grep rule — `org-scoping.test.ts` is
  file-granular and cannot catch a handler that forgot `withOrg`. A read that silently returns zero
  rows under the app role is exactly the M15 `monitor.ts` failure.
- **VALIDATE**: `npx vitest run apps/ingest/src/capture-health.int.test.ts` — all pass, 0 skipped.

### 14. FIX F-16.3-1 — `apps/collector/src/cli.ts` `runWatch`

- **IMPLEMENT**: after `loadRegistry` (line ~202), mirror `serve.ts` exactly:
  1. `const seeded = seedMissingApprovals(connectors, loadConnectorApprovals(), home); if
     (seeded.changed) saveConnectorApprovals(seeded.approvals);`
  2. `const enabled = filterByApproval(filterConnectors(connectors, loadConnectorConfig()),
     loadConnectorApprovals(), home);`
  3. pass `connectors: enabled` **and** `registry: connectors` to `runCaptureEngine`.
- **PATTERN**: `apps/collector/src/serve.ts:171-174` (seed) and `239-243` (filter composition) —
  copy the order, both filters compose, default-on is preserved by both.
- **IMPORTS**: `filterConnectors`, `loadConnectorConfig` from `./connectors/connector-config.js`;
  `filterByApproval`, `seedMissingApprovals`, `loadConnectorApprovals`, `saveConnectorApprovals`
  from `./connectors/connector-approvals.js`. **Verify the approvals object field is `approved`**
  (spike S8), not `connectors`.
- **GOTCHA — this is a real behaviour change, and the PR must say so.** A connector the operator
  disabled in the desktop UI has been capturing under `collector watch` (and therefore under the
  **Windows service**, which runs `watch --home …`). After this, it stops. That is the intent —
  D-M16-1's observation set is a research constraint, not a preference — but an operator who has
  been relying on the current behaviour will see capture reduce.
- **GOTCHA**: `runWatch` currently has **no engine seam**, so this is not directly unit-testable.
  Add an optional `runEngine?: typeof runCaptureEngine` dep (mirroring `ServeDeps.runEngine`,
  serve.ts:66) so the test can assert the filtered list — otherwise the fix ships unpinned and the
  next refactor silently undoes it, which is exactly how it got here.
- **VALIDATE**: `npx vitest run apps/collector/src/cli.test.ts` — plus a NEW test asserting a
  disabled connector is absent from the engine's `connectors` and present in `registry`.

### 15. CREATE `apps/collector/src/connectors/connector-info.ts` (extract) + its test

- **REFACTOR**: move `mapConnectorInfo` out of `serve.ts:100-130` into this new file and **export**
  it (it is currently private). `serve.ts` imports it; delete the local copy and the now-unused
  `BUILTIN_IDS` if it moves with it.
- **ADD**: `toMachineConnectorReport(info: ConnectorInfo, error?: {message, at, count}):
  MachineConnectorReport` — strips `watchGlobs`, folds in the error fields.
- **PATTERN**: the existing serve test that asserts the `Connector → ConnectorInfo` mapping stays
  1:1 with `ConnectorFidelity` — move/extend it rather than dropping it.
- **GOTCHA — D-16.3-3**: the test must assert the emitted report has **no** `watchGlobs` key, so the
  privacy exclusion is pinned by a test and not only by a type.
- **GOTCHA**: behaviour-identical extraction. If `serve.test.ts` changes assertions, you changed
  behaviour.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/connector-info.test.ts apps/collector/src/serve.test.ts`

### 16. UPDATE `apps/collector/src/queue/queue-store.ts`

- **ADD**: the `connector_errors` `CREATE TABLE IF NOT EXISTS` (verified, S9) beside the existing
  three, plus `recordConnectorError(connectorId, message, atIso)` (the verified upsert) and
  `connectorErrors(): Map<string, {message, at, count}>`.
- **PATTERN**: `poll_state` (queue-store.ts:95) — the same `exec` + `prepare` idiom.
- **GOTCHA**: truncate `message` to a bounded length before storing (it is echoed to the archive and
  the ingest body schema bounds it). An error message may contain a **file path**; that is
  acceptable here (it is the diagnostic) but must be noted in `docs/guide/data-boundary.md` as part
  of what a heartbeat carries.
- **GOTCHA**: `QueueStore` `mkdir`s its parent already (CLAUDE.md) — no change needed there.
- **VALIDATE**: `npx vitest run apps/collector/src/queue/` — plus a new test for the upsert count.

### 17. FIX F-16.3-2 — `apps/collector/src/watcher/file-watcher.ts`

- **IMPLEMENT**: wrap the **per-file** body of `tickOnce`'s loop (lines 60-85) in `try/catch`. On
  catch, call a new optional `deps.onError?.(connector, err)` and `continue` to the next file. The
  cursor is still not committed, so the lines genuinely retry next tick.
- **GOTCHA — the comment at lines 16-18 is the defect.** It claims a throw means "retried next
  tick"; today the throw rejects `runLoop`, which rejects the `Promise.race` in
  `capture-engine.ts:276` and unwinds the **whole engine** — one connector's bad file stops capture
  for all of them. Update the comment to describe what the code now actually does, and say which
  mechanism delivers it (the per-file catch), per CLAUDE.md's 15.5 "name the mechanism" rule.
- **GOTCHA**: catch **per file**, not around `runLoop` or `tickOnce` — a loop-level catch would skip
  every remaining file in that tick.
- **GOTCHA**: `discover()` can also throw (a glob over an unreadable directory). Wrap it too, and
  attribute the error to the connector whose pattern was being globbed.
- **GOTCHA**: accept the trade honestly in the comment — a permanently failing file now retries
  forever instead of crashing loudly. That is the right trade **because** the error is now reported
  and renders as `erroring` on the scorecard, which is strictly more visible than a dead process;
  but it is a trade, not a free win.
- **VALIDATE**: `npx vitest run apps/collector/src/watcher/` — plus a new test: a connector whose
  `parse` throws does **not** stop the loop, and a sibling connector's file is still captured in the
  same tick.

### 18. UPDATE `apps/collector/src/capture-engine.ts`

- **ADD**: `registry?: Connector[]` to `CaptureEngineOptions` (the FULL inventory, defaulting to
  `connectors`), documented as "what to REPORT" vs `connectors` "what to CAPTURE".
- **WIRE**: pass `onError: (c, err) => queue.recordConnectorError(c.id, String(err), new
  Date().toISOString())` into `FileWatcher`; add the same call to the `pollLoop` catch (line 175-177)
  and the push-server error path.
- **ADD**: build the report array (registry × config-derived `enabled` × `approvalStatus` ×
  `queue.connectorErrors()`) and hand it to `runSyncLoop` for the heartbeat.
- **PATTERN**: the existing `connectors`/`opts.connectors ?? defaultConnectors` seam at line 186.
- **GOTCHA**: the `registry` default must be `opts.connectors` and **not** `defaultConnectors` — a
  test that injects two connectors must not suddenly report eight.
- **GOTCHA**: do not change the best-effort contract of `gitSweepLoop` — a git error is not a
  connector error and must not be attributed to one.
- **VALIDATE**: `npx vitest run apps/collector/src/capture-engine.test.ts`

### 19. UPDATE `apps/collector/src/heartbeat.ts` + `sync/sync-worker.ts`

- **ADD**: `connectorReports?: () => MachineConnectorReport[]` to `HeartbeatDeps` (a **thunk**, so
  the inventory is read at send time, not loop-construction time), and `onError?: (e: unknown) =>
  void`.
- **IMPLEMENT**: include `connectors: deps.connectorReports?.()` in the body when defined; in the
  `catch`, call `deps.onError?.(e)` **before** swallowing.
- **UPDATE**: `sync-worker.ts` (lines ~142-152) — thread both through from `runSyncLoop`'s deps.
- **GOTCHA**: the swallow **stays** (residual risk e — a heartbeat failure must never stall the sync
  loop). `onError` only makes it observable; the engine wires it to its `logger`.
- **GOTCHA**: `postHeartbeat` already takes `opts?: RequestOptions` and applies `requestSignal` —
  keep it (CLAUDE.md: every collector fetch must be timeout-bounded **and** abort-cancellable).
- **VALIDATE**: `npx vitest run apps/collector/src/heartbeat.test.ts apps/collector/src/sync/`

### 20. CREATE the dashboard proxy + display lib

- **IMPLEMENT**: `app/api/capture-health/route.ts` — `GET` → `proxyJson("/v1/capture-health",
  { signal: req.signal })`, with `export const dynamic = "force-dynamic"`.
- **IMPLEMENT**: `lib/capture-health-display.ts` — `STATE_LABELS`, `STATE_DESCRIPTIONS`,
  `STATE_TONE` as `Record<CaptureHealthState, …>` keyed on the **shared union**, so adding a state
  is a compile error here rather than a blank cell.
- **IMPLEMENT**: `lib/capture-health-display.test.ts` — an exhaustiveness loop over the state union
  and an assertion that `unreported`/`unknown` are **not** styled as either success or failure.
- **PATTERN**: `apps/dashboard/src/lib/format.ts` for the pure-lib convention; the 16.2 plan's
  `label-display.ts` for the `Record<Union, string>` discipline.
- **GOTCHA**: import the types from the **subpath** (`@420ai/shared/capture-health`) if that export
  exists in `packages/shared/package.json` `exports`; **verify, and add the entry mirroring
  `/roles` if it does not.** The root barrel drags `catalog-signing` and eight parsers into the
  browser bundle.
- **GOTCHA**: neutral wording. `idle` reads "No recent activity", never "Nothing captured";
  `unreported` reads "This collector does not report connector health yet — upgrade it", never
  "Unknown error".
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/capture-health-display.test.ts` &&
  `npm run typecheck:dashboard`

### 21. CREATE `apps/dashboard/src/components/monitor/capture-health-panel.tsx` and wire it in

- **IMPLEMENT**: a client island fetching `/api/capture-health` on mount and on a slow interval
  (60 s — the underlying signal changes at heartbeat cadence, not SSE cadence). Render one row per
  (machine, connector): state badge, last event (`formatAgo`), event count, parser version, the
  error message when present, and `requiredPermissions`/`knownGaps` behind a disclosure.
- **UPDATE**: `monitor-view.tsx` — replace the Connectors card (lines 123-160) with
  `<CaptureHealthPanel />`.
- **PATTERN**: `team-view.tsx` for the island shape; `live-monitor.tsx` for the teardown discipline.
- **GOTCHA**: **arm the teardown before the first `await`** (`let cancelled = false`) and clear the
  interval on unmount — CLAUDE.md's long-lived-resource rule, and the exact class
  `/lril:code-review` caught in M9.
- **GOTCHA**: an unreachable archive is **not** an empty scorecard. On a 502 render "Could not reach
  the archive" — a plausible-looking empty table here is a lie about capture health, which is the
  one thing this panel exists to tell the truth about.
- **GOTCHA**: do **not** add an 11th nav entry (the nav already carries 10).
- **VALIDATE**: `npm run typecheck:dashboard` && `npm run build:dashboard`

### 22. UPDATE the docs and the stale milestone-plan row

- `docs/guide/operations.md` — a "Reading the capture health scorecard" section (the state table and
  what each one asks you to do), the **F-16.3-1 behaviour change**, and the **archive-before-collector
  deploy order** (D-16.3-6).
- `docs/guide/data-boundary.md` — the heartbeat now carries connector ids, permission statements and
  **error messages, which may contain file paths**. `watchGlobs` are deliberately **not** sent
  (D-16.3-3). This file is a §7 P0.4 artifact — keep it true.
- `.agents/plans/m16-dogfood-instrumentation.md` — correct the **D3** row (see D-16.3-1). Add an
  erratum line rather than rewriting history: D3 shipped in M13 13.5.
- **GOTCHA**: CI runs `prettier --check` on markdown; local `repo-health` does not. Run
  `npm run format` before pushing.
- **VALIDATE**: `npm run format:check`

### 23. UPDATE `SUMMARY.md`

- **IMPLEMENT**: flip **16.3** to ✅ in **both** the §0 status block and the §6 roadmap, with a
  one-line "DONE `<date>` (PR #NN)".
- **GOTCHA**: `scripts/check-summary.mjs` requires the ✅ within 4 characters of the `**16.3**`
  token once `.agents/execution-reports/m16-slice3-*.md` exists. **Do not** write "M16 … is
  **DONE**" — that disables per-slice checking for 16.4 (M16 plan, Risk 4).
- **GOTCHA**: same commit as the execution report (CLAUDE.md).
- **VALIDATE**: `node scripts/check-summary.mjs`

---

## TESTING STRATEGY

### Unit Tests (always run, no infra)

| File                                                     | Asserts                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/capture-health.test.ts`             | Every `CaptureHealthState` is reachable; the `liveness` gate (batch ⇒ `idle`, streaming-with-producing-sibling ⇒ `silent`); offline ⇒ `unknown` before all else; `CAPTURE_HEALTH_VERDICT` exhaustive |
| `apps/dashboard/src/lib/capture-health-display.test.ts`  | Exhaustiveness over the shared union; `unreported`/`unknown` are neither success- nor failure-toned                                          |
| `apps/collector/src/connectors/connector-info.test.ts`   | The `Connector → ConnectorInfo` map stays 1:1; **the report carries no `watchGlobs` key** (D-16.3-3)                                          |
| `apps/collector/src/watcher/file-watcher.test.ts`        | A throwing connector does NOT stop the loop; a sibling's file is still captured in the same tick; `onError` fires once with that connector    |
| `apps/collector/src/cli.test.ts`                         | `runWatch` hands the engine the **filtered** list and the **full** registry (F-16.3-1's regression pin)                                       |
| `apps/collector/src/queue/queue-store.test.ts`           | `recordConnectorError` upserts and increments `count`                                                                                        |
| `apps/collector/src/heartbeat.test.ts`                   | `connectors` included when the thunk is set, absent when it is not; a rejection calls `onError` and still does not throw                      |

The dashboard has **no component-test lane** (only `src/lib/*.test.ts`), which is why every decidable
piece above lives in `lib/` or `@420ai/shared` rather than inside a `.tsx`. Do not add a component
test runner in this slice.

### Integration Tests (`*.int.test.ts`, DB-backed)

- `packages/db/src/repositories/capture-health.int.test.ts` — the **two-role** suite, 11 tests, role
  identity first. This is the layer where a dropped policy or a missing predicate must turn the file
  red.
- `apps/ingest/src/capture-health.int.test.ts` — the endpoint's role gates plus the **behavioural
  app-role test** (heartbeat → declared row visible → error renders `erroring`), which is the only
  thing that catches a handler that forgot `withOrg`.
- `packages/db/src/repositories/rls.int.test.ts` — inherits `machine_connectors` via `STRICT_TABLES`.

### Edge Cases (each must have a test or an explicit "not tested and why")

1. `connectors: undefined` (pre-16.3 collector) leaves existing rows **untouched**; `connectors: []`
   **prunes**. The two must not be collapsed (task 11).
2. A machine that has never heartbeat since 16.3 → its observed connectors render `unreported`, not
   `disabled`.
3. A machine that is `offline` → every one of its rows renders `unknown`, whatever the declaration
   says.
4. A `batch` connector with zero events → `idle`, never `silent`.
5. A `streaming` connector with zero events while a sibling on the same machine produced events →
   `silent`.
6. A connector with `approval: "needs-approval"` → `needs-approval`, and this **outranks** `idle`
   (it is withheld from capture, so its silence is explained).
7. An error reported **before** the last successful event → NOT `erroring` (it recovered).
8. Two orgs declaring the same `connectorId`; events only in one → the other reports `eventCount 0`.
9. Two machines in one org running the same connector → **two** rows, not one merged row.
10. Archive unreachable → the panel says so; the collector keeps capturing and queueing.
11. A newer collector against a pre-16.3 server → the 400 is **logged**, not silent (D-16.3-6).

---

## VALIDATION COMMANDS

All runnable from the repo root. Every one is a **gate**.

### Level 1: Syntax, style & types

```bash
npm run typecheck            # root tsc -b — MUST exit 0 (per-workspace build is NOT a substitute)
npm run typecheck:dashboard  # the dashboard's ONLY type enforcement
npm run lint                 # ESLint — NOT in repo-health, but CI runs it
npm run format:check         # prettier incl. markdown — NOT in repo-health, but CI runs it
```

### Level 2: Unit tests

```bash
npx vitest run packages/shared/src/capture-health.test.ts
npx vitest run apps/collector/src/watcher/ apps/collector/src/queue/ apps/collector/src/cli.test.ts
npx vitest run apps/dashboard/src/lib/capture-health-display.test.ts
npm test                     # full vitest run, 0 failures
```

### Level 3: Integration tests (**must actually run — `skipped ≠ passed`**)

```bash
npm run db:up && npm run db:migrate
# The TEST database is migrated separately from the dev one:
docker exec 420ai-archive psql -U 420ai -d 420ai_test -c "\d machine_connectors"
npx vitest run packages/db/src/repositories/capture-health.int.test.ts   # 11 passed, 0 skipped
npx vitest run packages/db/src/repositories/rls.int.test.ts              # all passed, 0 skipped
npx vitest run apps/ingest/src/capture-health.int.test.ts                # all passed, 0 skipped
```

### The gate

```bash
npm run repo-health -- --require-db
```

**Pass signal**: exit 0, and the int-test layer asserted to have **actually run with 0 skipped**. A
plain `repo-health` PASS does **not** prove the DB layer ran (CLAUDE.md). This slice touches
`@420ai/db` **and** adds a tenant table, so `--require-db` is mandatory before sign-off.

### Level 4: Manual validation — the DELIBERATELY BROKEN connector

The milestone's pre-sign-off checklist names this precisely: the scorecard must be demonstrated on a
**broken** connector, _"not merely a healthy one."_ A green scorecard over a healthy machine proves
nothing about the distinction the slice exists to make.

```bash
npm run db:up && npm run db:migrate && npm run ingest:dev
npm run dashboard:dev
npx tsx apps/collector/src/cli.ts watch --home <scratch-home>
```

1. Pair a machine, let one heartbeat land. `/monitor` → the Capture Health panel lists **every**
   connector, including ones that have never produced an event.
2. **Break one deliberately** — e.g. `chmod`/deny read on a `codex-cli` session file, or point a
   custom connector at an unreadable path. Confirm: capture for **other** connectors continues
   (F-16.3-2), and within one heartbeat the broken one renders **`erroring`** with the message.
3. Disable a connector in `~/.420ai/connectors.json`, restart `watch`. Confirm it renders
   **`disabled`** and — the F-16.3-1 proof — that it **stops producing events**.
4. Leave a `streaming` connector idle while another captures → **`silent`**. Leave a `batch`
   connector idle → **`idle`**. This is the P0.1 distinction; screenshot both.
5. Stop the collector. After the offline threshold every row renders **`unknown`**, not `healthy`.
6. Point a pre-16.3 collector (or omit `connectors` by hand) at the server → its connectors render
   **`unreported`**, and no row claims `disabled`.
7. `grep -c "$API_KEY" <served /monitor HTML>` → **0** (the browser never holds the key).

Evidence to `.agents/qa/m16-signoff/`.

### Level 5: Additional

```bash
# The org-scoping grep is FILE-granular — pair it with the behavioural test above.
npx vitest run apps/ingest/src/routes/org-scoping.test.ts
# Prove the extraction left no second copy of the mapper:
grep -rn "function mapConnectorInfo" apps/collector/src   # expect exactly 1 (connector-info.ts)
# Prove F-16.3-1 is really fixed at the call site, not just importable:
grep -n "filterConnectors\|filterByApproval" apps/collector/src/cli.ts   # expect both present
```

---

## ACCEPTANCE CRITERIA

**Research plan §7 P0.1 — the acceptance criterion is a distinction:**

- [ ] All seven signals are present server-side: enabled/disabled, last successful event, sync
      freshness, queue depth, last error, parser version, known permission gaps
- [ ] A user can distinguish **"no work happened"** (`idle`) from **"capture is broken"**
      (`erroring` / `silent` / `needs-approval`) — demonstrated on a **deliberately broken**
      connector, not merely a healthy one
- [ ] The scorecard can say **"I don't know"** (`unreported`, `unknown`) and never renders an
      unknown as healthy (M16 Risk 2)
- [ ] A `batch` connector's silence is never reported as breakage

**Engineering:**

- [ ] `npm run repo-health -- --require-db` passes; int tests ran with **0 skipped**
- [ ] `npm run typecheck` (root) and `typecheck:dashboard` exit 0; `build:dashboard` passes
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] The two-role suite's **first** test asserts role identity
- [ ] The cross-org control and the ISO round-trip are **tests**, not comments
- [ ] `machine_connectors` is in `STRICT_TABLES` and **no integer literal** in `rls.int.test.ts`
      was edited
- [ ] Migration `0025` has a hand-authored down; `npm run db:rollback` then re-migrate is clean
- [ ] No new dependency in any `package.json`
- [ ] **F-16.3-1** fixed AND pinned by a `cli.test.ts` regression test
- [ ] **F-16.3-2** fixed AND pinned by a watcher test proving a sibling still captures
- [ ] `connectorHealth.lastEventAt` returns ISO, pinned by an assertion
- [ ] `watchGlobs` appear nowhere in the wire type, the table, or the database (D-16.3-3)
- [ ] `SUMMARY.md` 16.3 → ✅ in §0 and §6, in the execution-report commit
- [ ] The PR names the M16 non-goals **and** the F-16.3-1 behaviour change

---

## COMPLETION CHECKLIST

- [ ] All 23 tasks completed in order
- [ ] Each task's `VALIDATE` command passed immediately after that task
- [ ] All validation commands executed successfully
- [ ] Full suite passes (unit + integration, 0 skipped)
- [ ] No lint, format or type errors in either type lane
- [ ] The Level-4 broken-connector round-trip completed, evidence in `.agents/qa/m16-signoff/`
- [ ] Every acceptance criterion met
- [ ] Code reviewed via `/lril:code-review`, then `/lril:post-execute`

---

## NOTES

### Decisions taken in this plan

**D-16.3-1 — The milestone plan's D3 row is STALE and is corrected, not inherited.**
`.agents/plans/m16-dogfood-instrumentation.md` lists deferral **D3** (windowed connector-failure-rate)
as _"FOLDS INTO 16.3."_ It does not: it **shipped in M13 13.5**. `CONNECTOR_RATE_ALERT`,
`deriveConnectorFailureRateAlerts` (`packages/shared/src/alerts.ts:293-327`) and
`connectorHealthWindowed` (`projections.ts:365`) exist and are wired into `routes/monitor.ts:125`;
`SUMMARY.md:1080` records it. 16.3 therefore inherits nothing here and **must not rebuild it** — the
panel *consumes* the existing windowed alert rather than deriving a second failure rate, because two
independently-derived failure rates on one screen is precisely the "which number do I believe?"
problem the milestone exists to remove.

**D-16.3-2 — The declaration is REPORTED on the heartbeat, not pulled.**
The alternative was a server-initiated read of connector state. Rejected: the archive has no channel
to a collector (the collector is outbound-only by design — there is no inbound port except the
14.7 `127.0.0.1` push receiver), and a pull would invert the trust direction of the whole product.
The heartbeat already runs every 30 s, is already machine-authed, and already carries exactly this
kind of collector-local fact (`queuePending`, `collectorVersion`, `consecutiveSyncFailures`). The
inventory is small and idempotent, so re-sending it is free.

**D-16.3-3 — `watchGlobs` are NOT sent to the archive; `requiredPermissions` are.**
`ConnectorInfo` carries both. `watchGlobs` are **absolute filesystem paths under the operator's
home** (`C:\Users\<name>\.claude\projects\**`), so shipping them writes the operator's username and
directory layout into the archive — a database a design partner is later asked to trust (§7 P0.4,
`docs/guide/data-boundary.md`). `requiredPermissions` is the human-readable capture-scope statement
built for exactly this review purpose (12.7b, `control-protocol.ts:61-66`) and carries the same
information at the granularity a human actually needs. The exclusion is enforced **at the type
level** (`Omit<ConnectorInfo, "watchGlobs">`) and pinned by a test, so it is not something anyone has
to remember.

**D-16.3-4 — `silent` is gated on `liveness`; a batch connector's quiet is `idle`.**
See the PATTERNS note. Without the gate, `claude-export`/`chatgpt-export`/`gemini-export` would sit
permanently red and the operator would learn to ignore the panel — the same "cry wolf" failure §4.3
avoids for labels. The `liveness` field already encodes the distinction, so the gate adds no new
concept.

**D-16.3-5 — The scorecard is a SEPARATE endpoint, not an extension of the monitor snapshot.**
`buildSnapshot` already performs eight reads plus a reconcile **write** per tick, and the SSE stream
runs it every `monitorStreamIntervalMs` (3 s). Capture health changes at **heartbeat** cadence
(30 s), so folding it in would multiply the cost of the hottest query path in the product by a signal
that cannot change that fast. A separate `viewer`-gated read also keeps `GET /v1/capture-health`
free of the evaluate-on-read write, which is what lets it run under `principal.role` instead of
`SERVICE_ROLE` (the 15.4 distinction).

**D-16.3-6 — `additionalProperties: false` makes this wire change ORDER-DEPENDENT, and the failure
must not be silent.**
A newer collector posting `connectors` to a pre-16.3 server gets a **400**, and
`maybeSendHeartbeat`'s catch swallows it (`heartbeat.ts:60-62`). The machine then goes `offline` in
the Live Monitor with no error logged anywhere — a silent capture-health failure, in the slice whose
entire purpose is to end those. It is not acceptable to leave it silent even though the deploy order
(archive first) makes it unlikely, so task 19 adds the `onError` seam and the engine logs it. The
swallow itself **stays** — a heartbeat failure must never stall the sync loop (residual risk e).

**D-16.3-7 — `errorCount` is owned by the collector, never accumulated server-side.**
The collector persists it in `queue.sqlite` and the server overwrites on every report. A
server-side counter would be a second source of truth that drifts on every re-pair, restart or
prune, and the operator would have no way to know which number to believe.

**D-16.3-8 — F-16.3-1 and F-16.3-2 are fixed HERE, under D-16.0-2's stated exception.**
The milestone forbids opportunistic fixes (D-16.0-2: "measures; it does not fix"), and that rule is
respected — but it carries an explicit exception for _"defects in the isolation mechanism the
measurement's own safety constraint depends on."_ Both qualify, and neither is cosmetic:

- **F-16.3-1** means D-M16-1's fixed observation set is **not in force** on the primary capture path.
  Every §5.1 figure (capture coverage, duplicate rate) is scoped to that set by definition, so a
  scorecard reporting on connectors the decision says are off is reporting on the wrong denominator.
- **F-16.3-2** means "capture is broken" currently manifests as the **whole engine dying**, which is
  indistinguishable from a closed laptop. Building a per-connector health panel on top of a system
  where one connector's failure removes all connectors would produce a panel that is empty exactly
  when it matters most.

### Spikes actually RUN during planning (throwaways deleted)

Two throwaway files — `packages/db/src/repositories/spike-capture-health.int.test.ts` (two-role,
against the live `420ai_test` database with both the owner and `420ai_app` handles) and
`apps/collector/src/spike-capture-health.test.ts` — were written, run, read, and **deleted**.
**10/10 passed.** Raw output:

| #       | Spike                                                                | Result                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**  | Two-role harness works; the app handle is really non-privileged       | ✅ `{ superuser: 'off', bypass: false, user: '420ai_app' }`                                                                                                                                                                       |
| **S2**  | Is `connectorHealth.lastEventAt` ISO?                                 | ❌ **No — and the bug is LIVE.** Returned `"2026-08-01 00:00:00+00"`; `raw === new Date(raw).toISOString()` was **`false`**. This is the M5 `lastActivity` / M9 `activeSessions` class, shipped and on the wire. Hence task 3.     |
| **S3**  | Is a declared-but-silent connector visible to `connectorHealth`?      | ❌ **No.** Org A had `claude-code` events and no `codex-cli` events; the projection returned `['claude-code']` only. **This is the core gap, measured.**                                                                           |
| **S4**  | Does the declared × observed LEFT JOIN surface it?                    | ✅ Returned all three declared rows; `codex-cli` came back `event_count: 0` (typeof `number`, from `::int`), `last_event_at: null`, error message intact. `claude-code`'s `last_event_at` was again **non-ISO** — `toIso` required. |
| **S5**  | **Negative control**: drop the join-side org predicate                | ✅ **The bug reproduces.** With a `connector_id`-only join, org A's silent `cursor` row counted **1** of org B's events; with the predicate, **0**. Measured on the **owner** handle, so it measures the predicate, not RLS.        |
| **S6**  | `filterConnectors` removes a disabled connector                       | ✅ 8 built-ins → 6 with `cursor`+`gemini-cli` disabled                                                                                                                                                                            |
| **S7**  | **Does `runWatch` apply enablement/approval filters?**                | ❌ **No — F-16.3-1 confirmed.** `cli.ts` contains neither `filterConnectors` nor `filterByApproval`; `serve.ts` contains both.                                                                                                     |
| **S8**  | `seedMissingApprovals` + `filterByApproval` compose (the serve order) | ✅ `changed: true`, all 8 kept. **Caught a naming trap**: the field is `approvals.approved`, **not** `approvals.connectors` — a plan written from memory would have used the wrong key.                                            |
| **S9**  | `node:sqlite` supports the proposed `connector_errors` upsert         | ✅ Table created; two `ON CONFLICT DO UPDATE` runs produced one row with `count: 2` and the latest message.                                                                                                                        |
| **S10** | Package/tooling presence for everything the snippets touch            | ✅ `apps/collector/package.json` `dependencies` is exactly `{"@420ai/shared":"*"}` — **no new dependency needed anywhere**. Test DB live, both roles connect, `420ai-archive` container up.                                        |

**S3 and S7 are why this slice is worth its size.** S3 is the acceptance criterion failing under
measurement; S7 is a silent, shipped defect that makes the milestone's own observation-set decision
inert on the path the Windows service uses. Neither is visible to `tsc`, and neither would have been
caught by any existing test.

**F-16.3-2 was found by reading, not by spiking**, and is stated as such: `file-watcher.ts`
`tickOnce`/`runLoop` carry no `try/catch`, so a throw rejects the loop and unwinds
`Promise.race([watcherLoop, syncLoop])` (`capture-engine.ts:276`). The header comment at lines 16-18
asserts the opposite ("retried next tick"). It is not spike-confirmed end-to-end because reproducing
it requires an unreadable file on a real capture path — task 17's new unit test is where it becomes
pinned, and that test is written **before** the fix so it fails first.

### Symbols verified by reading source (not from memory)

`connectorHealth` · `connectorHealthWindowed` · `ConnectorHealthRow` · `machineStatuses` ·
`activeSessions` · `deriveMachineStatus` · `MONITOR_THRESHOLDS` · `MONITOR_VERSION` ·
`ACTIVE_WINDOW_MS` · `deriveConnectorFailureRateAlerts` · `CONNECTOR_RATE_ALERT` · `ConnectorInfo` ·
`ConnectorCatalogLiveness` · `ConnectorFidelity` · `CONTROL_PROTOCOL_VERSION` · `mapConnectorInfo`
(private, `serve.ts:100`) · `loadRegistry(home, opts)` · `filterConnectors(registry, cfg)` ·
`filterByApproval(registry, approvals, home)` · `seedMissingApprovals(registry, approvals, home)` ·
`approvalStatus` · `captureSurfaceFingerprint` · `ConnectorApprovals { version, approved }` ·
`loadConnectorConfig` / `saveConnectorConfig` · `HeartbeatRequest` / `HeartbeatResponse` ·
`heartbeatBodySchema` · `postHeartbeat(baseUrl, token, body, opts?)` · `requestSignal` ·
`maybeSendHeartbeat` / `newHeartbeatState` / `HeartbeatDeps` · `recordHeartbeat` ·
`getMachineOrgId` · `withOrg(db, orgId, role, fn)` · `SERVICE_ROLE` · `resolvePrincipal` ·
`authorized` · `machines` / `machineHeartbeats` / `events` (incl. `events.machineId`,
`events.orgId`, `events.ts` `mode:"string"`) · `ensurePersonalOrg` · `ingestBatch` · `createDb` ·
`proxyJson` / `proxyStream` · `getIngestJson` / `ingestUrl` / `adminHeaders` · `formatDate` /
`formatAgo` · `FORBIDDEN_MESSAGE` · `MonitorView` / `LiveMonitor`.

### Harness confirmed to exist

`packages/db/src/repositories/outcome-labels.int.test.ts` — `batch()` (45-69), `errorChain()`
(80-88), `expectRlsRejection()` (91-100), `WRITE_ROLE` (103), the `beforeEach` TRUNCATE + seeding
block (128-157), and the role-identity test (177-190). **The 16.3 spike reused this harness verbatim
and ran green**, which is stronger evidence than reading it. `ensurePersonalOrg` and `ingestBatch`
are imported there and re-used here. `apps/ingest/src/test-support/bootstrap-key.js`
(`seedBootstrapKey`) is the HTTP-layer principal seam. The dashboard's test lane is
`src/lib/*.test.ts` only — no component runner — which is why tasks 1 and 20 put every decidable
judgement in `lib/` or `@420ai/shared`.

### Trade-offs accepted

- **F-16.3-1 reduces capture for anyone relying on the current behaviour.** That is the intent, but
  it is a behaviour change on the primary path and belongs in the PR title, not a footnote.
- **F-16.3-2 turns a loud crash into a reported error.** A permanently failing file now retries
  forever. Accepted because the retry is *visible* on the scorecard, where the crash was not — but
  it is a trade, and task 17 requires the comment to say so.
- **The `silent` state is a heuristic.** It can be wrong for a `streaming` connector whose tool
  genuinely went unused while another was busy. It is deliberately worded as suspicion ("no activity
  while other connectors captured"), not as a verdict, and `unreported`/`unknown` exist so the panel
  never has to guess when it truly cannot tell.
- **One additive table rather than a JSONB column on `machines`.** A `machines.connectors` jsonb
  blob would need no migration, no RLS classification and no repository — but §7 P0.3's acceptance
  criterion for **16.4** is _"weekly scorecard values are **queryable** rather than manually
  guessed,"_ and 16.3 exists to define the signals 16.4 reads. Shipping them as an opaque blob would
  make the next slice's stated goal harder, which is the wrong trade one slice early.
- **No desktop/Rust work.** The desktop already shows connector state over the control protocol; the
  archive-side scorecard is the gap. Adding a second desktop panel would duplicate a surface without
  adding a signal.

### Confidence

**9.5 / 10** for one-pass success.

The evidence: **ten spikes actually run** — six against the live `420ai_test` database with both the
owner and `420ai_app` handles, four against real collector code — including **two negative controls
that reproduced real bugs before any code was written** (S5's cross-tenant merge, S7's missing
filter) and **one that found a shipped defect on a live endpoint** (S2). Every referenced symbol was
read rather than recalled, and one spike (S8) caught a field-name trap that a from-memory plan would
have got wrong. The two-role harness was not merely located but **executed**. Zero new dependencies,
verified from `package.json` rather than assumed. The migration follows a template (`0024`) that
documents its own hand-edits, and every count it touches in `rls.int.test.ts` is derived rather than
literal.

The residual half-point is **F-16.3-2's blast radius**. It is the one change in this slice that
touches the M3/M4 capture core rather than adding beside it, and its correctness argument
("per-file catch, cursor uncommitted, retried next tick") is verified by reading rather than by a
spike, because reproducing it needs an unreadable file on a real capture path. It is not closable by
more planning — only by writing the failing test first, which is why task 17 specifies exactly that
and Level 4 step 2 requires demonstrating it on a deliberately broken connector rather than assuming
it.
