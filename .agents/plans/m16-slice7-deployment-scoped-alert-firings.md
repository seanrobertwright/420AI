# Feature: M16 Slice 16.7 — Deployment-scoped alert firings (+ the unreachable-archive fault)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions are **not** re-pasted here — they live in [`CLAUDE.md`](../../CLAUDE.md) and are the
source of truth. This plan cites them by name where a task depends on one.

---

## Feature Description

`alert_firings` has been keyed on `(user_id, alert_key)` since M10 3c, when the product was
single-user and `user_id` was a faithful proxy for "whose archive is this". M15 made the tenancy
boundary the **organization** and M16 16.6 added a background evaluator tick — and between them
those two changes turned a dormant modelling error into three live defects:

1. **Two of the nine alert codes are deployment-global but stored per-org.**
   `catalog.update_requires_approval` and `ingest.auth_failure` derive from tables with no
   `org_id` at all (`countPendingCatalogs`, `countRecentAuthFailures`). The 16.6 tick loops every
   org, so ONE pending catalog opens a firing in EVERY org and, with a deliverer wired, sends one
   notice per org plus one resolve notice per org. This is not dormant-until-a-second-tenant:
   `ensurePersonalOrg` gives every user their own org, so **org count tracks USER count** — inviting
   two teammates makes it a three- or four-org deployment immediately.

2. **One condition opens N rows inside a single org.** `alert_firings_open_key` is unique on
   `(user_id, alert_key)`, so an `admin` or `viewer` opening the monitor opens a SECOND row under
   their own id and triggers a second delivery. That predates 16.6, but 16.6 made it the default
   rather than the exotic case: the tick now guarantees the owner's row always exists, so any
   non-owner viewer duplicates it.

3. **A persistently UNREACHABLE archive (non-401) is entirely silent.**
   `consecutiveSyncFailures` is reported only through the heartbeat — the one channel that cannot
   arrive when the archive is what is down — so a 500/`ECONNREFUSED` loop grows the queue without
   bound, writes no fault, exits 0, and leaves WinSW seeing a healthy service. That is
   INC-2026-07's observable symptom reached by a different cause, and the server-side
   `archive.unreachable` alert cannot cover it because it derives from heartbeat rows that by
   definition stop arriving.

This slice re-homes firings onto the org, introduces a **deployment scope** (`org_id IS NULL`) for
the two global codes, and gives the collector a second, non-fatal `CaptureFault.code`.

---

## User Story

As the **operator of a 420AI deployment**
I want **one alert firing per condition, acknowledgeable once, delivered once — and a durable local
record when my collector cannot reach the archive at all**
So that **the alert surface tells me how many things are wrong rather than how many accounts exist,
and a dead archive is not the one failure my monitoring cannot report.**

---

## Problem Statement

The firing model answers "who is looking at this?" when the question is "what is broken?".
`user_id` is the wrong grain on both axes: too fine for an org condition (N members → N rows, N
notices, N acks) and entirely absent for a deployment condition (no org owns a pending pricing
catalog, so every org gets one). Separately, the collector's only durable failure record covers
`auth_revoked` and nothing else, leaving the most ordinary outage — the archive being down —
without any local trace.

## Solution Statement

Make the **number of rows correct**, and correctness of delivery follows for free: 16.6 already
made delivery an atomic claim (`UPDATE … WHERE delivery_attempted_at IS NULL … RETURNING`, see
`alert-firings.ts:288`), so exactly one caller can ever win a row. Collapse N rows to 1 and the
duplicate-notice problem disappears without any new dedupe machinery.

Concretely:

- Re-key the partial unique index from `(user_id, alert_key)` to `(org_id, alert_key)`.
- Make `org_id` **nullable**, where `NULL` means **"this firing belongs to the deployment, not to a
  tenant"**, with a second partial unique index covering that case.
- Amend the RLS policy to `org_id = current_org OR org_id IS NULL` so every org still SEES the
  deployment condition while exactly one row, one ack and one delivery exist for it.
- Split the derivation into two **disjoint** scopes — 7 org codes, 2 deployment codes — which is
  what makes this non-flapping without any shared predicate between the tick and the route.
- Add `CaptureFault.code = "archive_unreachable"`, recorded off the existing
  `consecutiveSyncFailures` streak, **degraded rather than fatal**: it records, keeps capturing, and
  exits 0.

---

## Feature Metadata

**Feature Type**: Refactor + Bug Fix (data migration)
**Estimated Complexity**: High (a migration with a data-dependent dedupe, an RLS classification
change, and a second independent deliverable in `apps/collector`)
**Primary Systems Affected**: `packages/db` (schema, migration 0027, `alert-firings.ts`,
`org-context.ts`), `packages/shared` (`alert-firings.ts` wire type), `apps/ingest`
(`alert-set.ts`, `alert-evaluator.ts`, `routes/monitor.ts`, `routes/alerts.ts`), `apps/collector`
(`fault.ts`, `sync/sync-worker.ts`, `capture-engine.ts`, `cli.ts`, `serve.ts`)
**Dependencies**: **None new.** No package is added; every symbol used already exists.

---

## SPIKE EVIDENCE — run during planning, not deferred to you

Every load-bearing claim below was **measured against the real Postgres** (`420ai_test` on
`localhost:5433`) during planning. Two throwaways were used and deleted: a `pg` script in a
disposable `spike167` schema, and a temporary `packages/db/src/repositories/spike167.int.test.ts`
run through `npx vitest`. Both are gone; the test DB was verified clean afterwards (`spike167`
schemas: 0; `alert_firings` policies unchanged).

**Raw-SQL spike — 18 checks:**

```
PASS  S1   (org_id, alert_key) does NOT constrain NULL org_id — two indexes ARE required
           (second NULL-org row inserted; NULL <> NULL under a unique index)
PASS  S1b  the same index DOES constrain a non-NULL org
PASS  S2a  org row: a SECOND USER in the same org can no longer open a duplicate (defect 2 fixed)
PASS  S2b  a different ORG may still hold its own row for the same key (isolation preserved)
PASS  S2c  global row: exactly ONE deployment row per key (defect 1 fixed)
PASS  S2d  a RESOLVED global row does not block re-opening later (partial index respects status)
PASS  S3a  ON CONFLICT (org_id, alert_key) WHERE … infers the org index and UPDATES
PASS  S3b  ON CONFLICT (alert_key) WHERE … org_id IS NULL infers the GLOBAL index and UPDATES
PASS* S3c  using the ORG arbiter on a global row RAISES
           duplicate key value violates unique constraint "alert_firings_open_global_key"
PASS  S4a  org-A context sees org-A rows AND the global row, never org-B  (saw GLOBAL,1111,GLOBAL)
PASS  S4b  UNSET org context sees ONLY global rows — a role-only txn IS the deployment scope
PASS  S4c  an UNSET-org transaction may INSERT a global row (WITH CHECK passes on org_id IS NULL)
PASS  S4d  an UNSET-org transaction is still REFUSED an org-scoped insert (no tenancy hole opened)
           → "new row violates row-level security policy for table …"
PASS  S4e  NEGATIVE CONTROL: under the UNAMENDED strict policy the global row is INVISIBLE
           to every org  (saw 1 row, globals: 0)
PASS  S5a  both unique indexes BUILD after the dedupe (the migration is orderable)
PASS  S5b  exactly 2 open rows survive (1 org + 1 global), oldest first_fired_at preserved
           [["collector.offline:m1","org","2026-07-01"],["ingest.auth_failure:*","GLOBAL","2026-07-02"]]
PASS  S6   rollback needs globals re-homed FIRST — SET NOT NULL fails while a NULL row exists
```

**\* S3c is the single most important result and it CONTRADICTED the hypothesis.** The prediction
was that reusing the org arbiter on a global row would *silently insert a duplicate*
(`DO NOTHING` → no conflict inferred → a second row). It does not. Postgres suppresses conflicts
only on the **inferred arbiter index**; a conflict on any *other* unique index is a plain error. So
the two-upsert split is **enforced by the database, loudly**, not by reviewer discipline. This is
the "make it loud" property CLAUDE.md prizes, arrived at for free — do not paper over it with a
`DO NOTHING`, and do not merge the two upserts into one "clever" statement.

**Drizzle spike — 4 checks, the exact API shapes you will write** (`npx vitest run`, 4 passed):

```
A: org upsert — 2nd user in the same org UPDATES the existing row, never inserts
   (message updated to "second"; user_id STAYS U1 — the opener is preserved, so user_id is provenance)
B: global upsert — a single deployment row, updated not duplicated
C: using the ORG arbiter on a global row RAISES, error chain matches /sp_open_global_key/
D: a deployment-scoped resolve leaves org rows untouched
```

**Facts verified by reading, not memory:**

- `withOrg(db, orgId, role, fn)` — `packages/db/src/org-context.ts:50`. **Rejects a blank `orgId`**
  (line 63) and a blank `role` (line 70). It therefore *cannot* express a deployment scope; a new
  sibling primitive is required. It sets `app.current_org` and `app.current_role` via
  `set_config(..., true)`.
- Bootstrap policy qual, read live from `pg_policies`:
  `((NULLIF(current_setting('app.current_org', true), '') IS NULL) OR (org_id = …))` — the `IS NULL`
  tests **the SETTING**. The 16.7 amendment's `IS NULL` tests **the ROW's column**. Semantically
  opposite; see D-16.7-4.
- `deliverPendingFirings` / `deliverResolvedFirings` already claim atomically
  (`alert-firings.ts:288`, `:341`).
- `watchExitCode(result) = result.fault ? 1 : 0` (`apps/collector/src/cli.ts:217`).
- The dashboard renders **`snapshot.alertFirings` only** — `monitor-view.tsx:40` passes
  `firings={snapshot.alertFirings}` to `AlertsPanel`. `snapshot.alerts` is not rendered.
- Latest migration is `0026_living_loners`; journal `idx` 26. Yours is **0027**.
- Test DB is live and migrated (33 tables, `420ai_test` on port 5433).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

| File | Why |
| --- | --- |
| `packages/db/src/repositories/alert-firings.ts` (whole file, 365 lines) | The five functions you convert. Note `firingColumns` (30-48), `toFiring` (51-85), the `onConflictDoUpdate` target at 128-134, and the two atomic-claim deliverers at 288 / 341. |
| `packages/db/src/schema.ts` (943-989) | `alertFirings` table + the three indexes you re-key. |
| `packages/db/src/org-context.ts` (whole file) | `withOrg`'s contract, the blank-org rejection, and the doc-comment style your new sibling must match. |
| `packages/shared/src/alert-firings.ts` (whole file, 59 lines) | The `AlertFiring` wire type + `alertKey`. You add one field. |
| `packages/shared/src/alerts.ts` (212-283) | `deriveCatalogAlerts`, `AUTH_FAILURE_ALERT`, `deriveAuthFailureAlerts`, `ARCHIVE_UNREACHABLE_MIN_FAILURES` (257) — the two global derivations and the threshold constant you reuse in the collector. |
| `apps/ingest/src/alert-set.ts` (whole file, 103 lines) | The shared composition. Read its module doc in full — it explains WHY divergence between the two callers is a correctness bug, which constrains how you split it. |
| `apps/ingest/src/alert-evaluator.ts` (whole file, 312 lines) | The tick. Lines 122-146 are the two defects, already written up by 16.6 — delete those two paragraphs and replace them with what you did. |
| `apps/ingest/src/routes/monitor.ts` (61-141, 164-186, 218-244, 357-368) | `buildSnapshot`'s reconcile, `deliverFirings`, `shouldReconcile`, and both call sites. |
| `apps/ingest/src/routes/alerts.ts` (whole file) | The ack route — the fifth call site. |
| `packages/db/src/repositories/rls.int.test.ts` (96-210, 281-297, 520-600, 627-640) | The classification lists and the four DERIVED counts you must move `alert_firings` between. |
| `packages/db/src/repositories/tenancy.int.test.ts` (74-130, 364-395) | `TENANT_TABLES` + the `is_nullable === "NO"` assertion that this slice breaks. |
| `packages/db/src/repositories/alert-firings.int.test.ts` (1-110) | The existing harness you extend. Seeding: `users` insert → `ensurePersonalOrg(db, userId, email)` (line 48) → `machines` insert. Fixed clocks `t0…t4`. |
| `packages/db/drizzle/0026_living_loners.sql` | The migration prose style: a long comment explaining the WHY, measured numbers, and a locking note. |
| `packages/db/drizzle/down/0014_loose_pyro.down.sql` | The `down/` convention. |
| `apps/collector/src/fault.ts` (whole file, 136 lines) | `CaptureFault`, `saveFault` continuity, `loadFault`'s field-by-field validation (111-117), `clearFault`. |
| `apps/collector/src/sync/sync-worker.ts` (109-218) | `SyncLoopDeps` and the `consecutiveSyncFailures` counter (163, 206, 212). |
| `apps/collector/src/capture-engine.ts` (356-445) | `reportFatal` + the `reported` guard; where the new degraded reporter is wired. |
| `apps/collector/src/cli.ts` (217, 306-385, 765-787) | `watchExitCode`, `runWatch`'s fault plumbing, the stderr notice. |

### New Files to Create

- `packages/db/drizzle/0027_<drizzle-generated-tag>.sql` — the migration (generated, then hand-edited).
- `packages/db/drizzle/down/0027_<tag>.down.sql` — the rollback.
- No new source files. Every change is to an existing module — deliberately, per Phase-4.5
  "shrink the blast radius".

### Patterns to Follow

**The two upserts, verified verbatim by the Drizzle spike:**

```ts
// ORG scope — arbiter: alert_firings_open_key
.onConflictDoUpdate({
  target: [alertFirings.orgId, alertFirings.alertKey],
  targetWhere: sql`${alertFirings.status} = 'open' AND ${alertFirings.orgId} IS NOT NULL`,
  set: { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since },
})

// DEPLOYMENT scope — arbiter: alert_firings_open_global_key (a DIFFERENT index, one column)
.onConflictDoUpdate({
  target: [alertFirings.alertKey],
  targetWhere: sql`${alertFirings.status} = 'open' AND ${alertFirings.orgId} IS NULL`,
  set: { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since },
})
```

> **Spike-snippet fidelity.** These two snippets are exactly what spike checks A/B/C exercised.
> The assertions they carry: (A) a second caller in the same org UPDATES rather than inserts and
> `user_id` is left at the opener's id; (B) a second deployment caller UPDATES the single row;
> (C) swapping the arbiters raises `duplicate key value violates unique constraint
> "alert_firings_open_global_key"`. If your implementation makes any of those three false, the
> snippet has drifted from its spike — stop and re-derive rather than adjusting the test.

**`org_id` is still absent from every `set:` block** — an existing open firing keeps the scope it
was opened under, exactly as `alert-firings.ts:131-132` and `ingest.ts` already do (D-M15-2).

**The new context primitive mirrors `withOrg`'s shape**, including the guard style:

```ts
export async function withDeployment<T>(db: Db, role: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!role.trim()) throw new Error("withDeployment requires a non-empty role — pass SERVICE_ROLE");
  return db.transaction(async (tx) => {
    // DELIBERATELY does NOT set `app.current_org`. Spike S4b/S4c/S4d measured the consequence:
    // an unset org sees ONLY `org_id IS NULL` rows, may INSERT one, and is still REFUSED an
    // org-scoped insert. Setting a real org here would work too — but it would make the
    // deployment write look like that org's, and S4a shows every org can already SEE the row.
    await tx.execute(sql`SELECT set_config('app.current_role', ${role}, true)`);
    return fn(tx);
  });
}
```

**`sql.raw` is NOT needed anywhere here** — there is no closed-set SQL keyword in this slice. The
one place the repo's aggregate-timestamp gotcha could bite (`min/max(ts)` over a `mode:"string"`
column returning Postgres text) **does not arise**: `alert_firings`' timestamps are plain
`timestamp({withTimezone:true})` columns returned as JS `Date` by the driver, and `toFiring`
already normalizes them with `.toISOString()` (`alert-firings.ts:80-83`). The dedupe migration's
`first_fired_at` comparisons happen **inside SQL** (`ORDER BY first_fired_at`), never across the
wire. Do not add a coercion that is not needed; do not remove the ones that are.

---

## DESIGN DECISIONS

**D-16.7-1 — Deployment scope is `org_id IS NULL`, and it needs TWO partial unique indexes.**
Not one. `NULL <> NULL` under a unique index, so `(org_id, alert_key)` places **no constraint at
all** on rows whose `org_id` is NULL (spike S1: the second NULL-org row inserted cleanly). A single
composite index would therefore have "fixed" defect 1 by allowing unlimited duplicates. The org
index gains an explicit `AND org_id IS NOT NULL` predicate so the two indexes partition the table
rather than overlap.

**D-16.7-2 — `user_id` stays `NOT NULL`, and becomes PROVENANCE.** It records who or what opened
the firing; it is no longer part of any key, any read predicate, or any delivery predicate. Making
it nullable would be a second migration for no gain, and the column is genuinely useful in a
post-mortem. Spike check A confirms the upsert preserves the **opener's** id rather than
overwriting it with the second caller's — so `user_id` answers "who first saw this", which is the
only question it can now honestly answer. Say so in the schema comment; a column whose meaning
silently changed is worse than a renamed one.

**D-16.7-3 — the two scopes are DISJOINT, which is what makes this non-flapping.**
`alert-set.ts`'s module doc is explicit that two callers deriving different code sets makes every
firing in the difference flap, because `reconcileAlertFirings` resolves any open firing whose key is
absent from the derived set. That constraint is satisfied here **structurally rather than by
agreement**: the org reconcile filters `eq(alertFirings.orgId, orgId)`, which never matches a NULL
row, and the deployment reconcile filters `isNull(alertFirings.orgId)`, which never matches an org
row. Neither can resolve the other's firings. This is strictly stronger than the alternative
considered and rejected — gating the global codes on an `includeGlobal` predicate both callers
compute — which would have re-created the exact coupling `alert-set.ts` was built to remove.

**D-16.7-4 — `alert_firings` moves to a SIXTH RLS classification, and a substring check cannot
police it.** `rls.int.test.ts:550` asserts every STRICT table's qual does **not** contain
`"IS NULL"`; `:558` asserts every BOOTSTRAP table's qual **does**. The 16.7 policy contains
`IS NULL` and is neither. Read the two quals side by side:

```sql
-- BOOTSTRAP (machines, live from pg_policies): the IS NULL tests the SETTING
--   "no context ⇒ see everything"
(NULLIF(current_setting('app.current_org', true), '') IS NULL) OR (org_id = …)

-- 16.7 (alert_firings): the IS NULL tests the ROW'S COLUMN
--   "this row belongs to the deployment ⇒ everyone sees it"
(org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) OR (org_id IS NULL)
```

These are **opposite** security properties, and the existing assertion is a substring match that
cannot distinguish them. Dropping `alert_firings` into `BOOTSTRAP_TABLES` would make the whole file
pass while asserting that an unset context sees *every* firing — the precise "a structural grep
cannot decide semantics" failure CLAUDE.md records twice (the 15.2 `tsc` file-level lesson and
15.3's `withOrg(` per-file grep). So: add `DEPLOYMENT_SCOPED_TABLES = ["alert_firings"]` with its
own assertions, and **pair the structural check with the behavioural one** — spike S4b/S4d
translated into tests: an unset-org app-role transaction reads ONLY global rows and is still
refused an org-scoped insert.

**D-16.7-5 — `FORCE ROW LEVEL SECURITY` stays ON.** Contrast 15.10's `audit_events`, which omits
FORCE because its only reader is the owner's break-glass query. `alert_firings` has a real
per-tenant read path (the dashboard), so the owner exemption must stay removed. The table remains in
the "all 19 tenant tables have ENABLE + FORCE" count; it only moves between the *policy-shape*
lists.

**D-16.7-6 — `AlertFiring` gains `scope: "org" | "deployment"`, and it is load-bearing, not
cosmetic.** `listAlertFirings` must return org rows **and** deployment rows or the dashboard stops
showing the two global conditions entirely (`monitor-view.tsx:40` renders `alertFirings` and nothing
else). But `openFiringsDiverge` compares the OPEN firing keys against the DERIVED alert keys — feed
it a union while the route derives only the 7 org codes and it reports divergence on **every** tick
forever, defeating the `shouldReconcile` throttle that M15 15.4 audit B.4 added. So the route must
partition, and it needs a field to partition on. Derive it in `toFiring` from the selected `orgId`.
Adding `orgId` to `firingColumns` while exposing only `scope` on the wire follows the existing
`deliveryAttemptedAt` precedent (`alert-firings.ts:45-47`) — selected, documented, not on the wire —
and keeps the "explicit column lists, no bare `select()`" rule from M15 15.1.

**D-16.7-7 — the deployment reconcile runs from BOTH the route and the tick.** The evaluator is
opt-in and **default off** (`plugins/alert-evaluator.ts:20-33`); only `server.ts` enables it. Putting
the deployment reconcile in the tick alone would mean a deployment with the evaluator disabled — and
every one of the ~30 `buildApp` int tests — never derives the two global codes at all. Running it
from both is safe *because of* D-16.7-3 (disjoint scopes) and 16.6's atomic delivery claim: the
upsert is idempotent, and one row can be delivered exactly once no matter how many callers race for
it. Throttle it through the **same** `app.reconcileLastRunAt` map under a reserved sentinel key so
N connected dashboards do not each write every 3 s.

**D-16.7-8 — `archive_unreachable` is DEGRADED, not FATAL.** `watchExitCode` returns 1 when
`result.fault` is set (`cli.ts:217`), and WinSW's `<onfailure action="restart"/>` fires on a non-zero
exit. Restarting a collector does not make an unreachable archive reachable, so routing this through
`onFatal` would produce a restart loop — the collector thrashing precisely while its queue is the
only thing preserving the data. So it is a **separate callback** that writes the fault file and
changes nothing else: capture keeps running, the queue keeps growing (which is correct — that is the
durable queue doing its job), and the process still exits 0 on Ctrl-C. `result.fault` keeps its
current meaning, "capture STOPPED", and `watchExitCode` is untouched.

**D-16.7-9 — the degraded fault is written on a THRESHOLD CROSSING, then re-stamped sparsely.**
`saveFault` is a read-modify-write of a file on disk. `runSyncLoop`'s retry delay is
`retryMs = 1000`, so a naive "write it every failed drain" is a file write per second, forever,
while the archive is down. Write when the streak first reaches `ARCHIVE_UNREACHABLE_MIN_FAILURES`
(reuse the existing constant from `@420ai/shared:257` — the same threshold the server-side
`archive.unreachable` alert uses, so the two surfaces cannot disagree), then re-stamp
`lastObservedAt` only every 60th subsequent failure (≈ once a minute at the default `retryMs`).
`saveFault`'s existing `(code, url)` continuity (`fault.ts:79`) already preserves `since` across
those re-stamps and across process restarts — that machinery is reused unchanged.

---

## IMPLEMENTATION PLAN

### Phase 1: Schema, migration and the context primitive

Everything that must exist before a single repository function can compile: the nullable column, the
two indexes, the amended policy, the dedupe data-migration, the `down/` script, and
`withDeployment`.

### Phase 2: Repository conversion

`alert-firings.ts` — one internal scope-parameterized implementation behind two unmistakable
exported wrappers per operation. Five functions become seven.

### Phase 3: Ingest integration

`alert-set.ts` splits into two disjoint compositions; the tick, the route and the ack route are
converted; the deployment reconcile is wired into both paths under a throttle sentinel.

### Phase 4: Collector — the second deliverable

`CaptureFault.code` becomes a union; `runSyncLoop` gains a failure-streak callback; the engine wires
a degraded reporter; `cli.ts` / `serve.ts` surface it without changing the exit code.

### Phase 5: Testing, the rollback drill, and SUMMARY

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### 1. UPDATE `packages/db/src/schema.ts` — the table shape

- **IMPLEMENT**: Make `orgId` nullable (drop `.notNull()`, KEEP the `.references(() => organizations.id)`).
  Replace the three index entries with:
  - `uniqueIndex("alert_firings_open_key").on(t.orgId, t.alertKey).where(sql`${t.status} = 'open' AND ${t.orgId} IS NOT NULL`)`
  - `uniqueIndex("alert_firings_open_global_key").on(t.alertKey).where(sql`${t.status} = 'open' AND ${t.orgId} IS NULL`)`
  - `index("alert_firings_by_org_status").on(t.orgId, t.status)` — **replacing**
    `alert_firings_by_user_status`, which indexed a column nothing keys on any more.
  - keep `index("alert_firings_by_org").on(t.orgId)`.
- **PATTERN**: the existing partial `uniqueIndex(...).where(...)` at `schema.ts:983-985`.
- **GOTCHA**: rewrite the table's doc comment (943-949). It currently says "ONE open firing per
  (user, alert_key)". Leaving that sentence is the 15.5 defect verbatim — a comment asserting an
  invariant the code no longer has. State the new key, that `NULL` org means deployment scope, and
  (D-16.7-2) that `user_id` is now provenance.
- **VALIDATE**: `npx tsc -b` from the repo root — expect errors ONLY in `alert-firings.ts` and its
  callers (that is the arity/nullability change propagating, and it is the signal you want).

### 2. GENERATE + hand-edit `packages/db/drizzle/0027_*.sql`

- **IMPLEMENT**: `npm run db:generate` to get the DDL and the `meta/_journal.json` entry (idx 27).
  Then hand-edit the `.sql`. **Order is load-bearing** — the dedupe MUST precede index creation
  (spike S5a proved the indexes build only afterwards):

  ```sql
  -- 1. widen the column before anything can write a NULL
  ALTER TABLE "alert_firings" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
  DROP INDEX "alert_firings_open_key";--> statement-breakpoint
  DROP INDEX "alert_firings_by_user_status";--> statement-breakpoint

  -- 2. promote the OLDEST open row per GLOBAL key to the deployment scope, keeping first_fired_at.
  --    DISTINCT ON + ORDER BY (…, first_fired_at ASC, id ASC) — `id` breaks ties deterministically.
  UPDATE "alert_firings" SET "org_id" = NULL
   WHERE "id" IN (
     SELECT DISTINCT ON ("alert_key") "id" FROM "alert_firings"
      WHERE "status" = 'open'
        AND split_part("alert_key", ':', 1) IN ('catalog.update_requires_approval','ingest.auth_failure')
      ORDER BY "alert_key", "first_fired_at" ASC, "id" ASC);--> statement-breakpoint

  -- 3. resolve the per-org duplicates of those global conditions.
  UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now()
   WHERE "status" = 'open' AND "org_id" IS NOT NULL
     AND split_part("alert_key", ':', 1) IN ('catalog.update_requires_approval','ingest.auth_failure');--> statement-breakpoint

  -- 4. collapse per-USER duplicates within an org: keep the oldest, resolve the rest.
  UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now()
   WHERE "status" = 'open' AND "org_id" IS NOT NULL AND "id" NOT IN (
     SELECT DISTINCT ON ("org_id", "alert_key") "id" FROM "alert_firings"
      WHERE "status" = 'open' AND "org_id" IS NOT NULL
      ORDER BY "org_id", "alert_key", "first_fired_at" ASC, "id" ASC);--> statement-breakpoint

  -- 5. only now can the constraints exist.
  CREATE UNIQUE INDEX "alert_firings_open_key" ON "alert_firings" ("org_id","alert_key")
    WHERE "status" = 'open' AND "org_id" IS NOT NULL;--> statement-breakpoint
  CREATE UNIQUE INDEX "alert_firings_open_global_key" ON "alert_firings" ("alert_key")
    WHERE "status" = 'open' AND "org_id" IS NULL;--> statement-breakpoint
  CREATE INDEX "alert_firings_by_org_status" ON "alert_firings" ("org_id","status");--> statement-breakpoint

  -- 6. the policy amendment (hand-written — schema.ts declares no policies; mirrors 0015/0016).
  DROP POLICY "alert_firings_org_isolation" ON "alert_firings";--> statement-breakpoint
  CREATE POLICY "alert_firings_org_isolation" ON "alert_firings"
    USING  (org_id = nullif(current_setting('app.current_org', true), '')::uuid OR org_id IS NULL)
    WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid OR org_id IS NULL);
  ```

- **GOTCHA — the `WITH CHECK` clause is NOT optional and is NOT in 0015.** The current policy
  (verified live in `pg_policies`) has a `USING` clause only, which Postgres copies to `WITH CHECK`
  for a permissive ALL policy. Spelling both out explicitly is what spike S4c/S4d measured: the
  insert of a global row passes and the insert of a foreign org's row is still refused. Write both.
- **GOTCHA**: `split_part(alert_key, ':', 1)` recovers the code because `alertKey` is
  `` `${code}:${machineId ?? connector ?? "*"}` `` (`packages/shared/src/alert-firings.ts:51`) and no
  `AlertCode` contains a colon. Verify that by reading the union at `alerts.ts:38-47` before relying
  on it.
- **GOTCHA**: the 0026 house style is a long prose header explaining WHY, with measured numbers.
  Carry the S1 result into it — "a single `(org_id, alert_key)` index constrains nothing when
  `org_id` is NULL; measured, not assumed" — because that is the fact the next reader will most
  want to second-guess.
- **VALIDATE**: `npm run db:migrate` then re-run against the test DB; confirm both indexes and one
  policy exist:
  `select indexname from pg_indexes where tablename='alert_firings'` and
  `select policyname, qual from pg_policies where tablename='alert_firings'`.

### 3. CREATE `packages/db/drizzle/down/0027_*.down.sql`

- **IMPLEMENT**: exact inverse, and **the order is the reverse trap** — spike S6 measured that
  `SET NOT NULL` fails while any NULL row exists (`column "org_id" ... contains null values`). So
  the down script MUST resolve or re-home the deployment rows first. Simplest correct form: resolve
  every open global row, then delete resolved rows with `org_id IS NULL` (they are re-derivable —
  "events disposable" applies doubly to a projection of a projection), then restore the old policy,
  the old indexes, and `SET NOT NULL`.
- **PATTERN**: `packages/db/drizzle/down/0014_loose_pyro.down.sql`.
- **VALIDATE**: run the down script against the test DB, then `npm run db:migrate` forward again;
  the schema must be identical both times. **This is the rollback drill and it is an acceptance
  criterion — actually run it.**

### 4. ADD `withDeployment` to `packages/db/src/org-context.ts` and export it

- **IMPLEMENT**: the snippet in "Patterns to Follow". Export from `packages/db/src/index.ts`
  beside `withOrg`.
- **GOTCHA**: parameter type is `Db`, **never** `DbClient` — the same reason `withOrg`'s doc comment
  gives at line 30-34 (a `Tx` would silently produce a SAVEPOINT whose `set_config` scope is the
  outer transaction, and `DbClient.transaction()` typechecks, so only the parameter type catches it).
- **GOTCHA**: do NOT set `app.current_org` to `''` "for symmetry". `withOrg` rejects a blank org
  precisely because the bootstrap policies then read it as no-context and open up (lines 56-65).
  Leaving the setting **unset** is what spike S4b/S4d measured.
- **VALIDATE**: `npx tsc -b`.

### 5. UPDATE `packages/shared/src/alert-firings.ts` — the wire type

- **IMPLEMENT**: add `scope: "org" | "deployment"` to `AlertFiring`, documented per D-16.7-6.
  Update the `alertKey` doc comment: "One OPEN firing per (user, alertKey)" → per `(org, alertKey)`,
  or per key alone in the deployment scope.
- **GOTCHA**: `@420ai/shared` is pure, dependency-free and clock-free — add a type and prose, no
  logic.
- **VALIDATE**: `npx vitest run packages/shared`.

### 6. REFACTOR `packages/db/src/repositories/alert-firings.ts`

- **IMPLEMENT**:
  - `firingColumns` gains `orgId: alertFirings.orgId`; `toFiring` derives
    `scope: r.orgId === null ? "deployment" : "org"` and does **not** put `orgId` on the wire.
    Document it beside the existing `deliveryAttemptedAt` note (45-47).
  - One private `reconcileFirings(db, scope, userId, alerts, now)` where
    `scope = { kind: "org", orgId } | { kind: "deployment" }`, choosing the arbiter and the resolve
    predicate (`eq(orgId, …)` vs `isNull(orgId)`). Two exported wrappers:
    `reconcileAlertFirings(db, orgId, userId, alerts, now)` (signature unchanged) and
    `reconcileDeploymentFirings(db, userId, alerts, now)`.
  - `listAlertFirings(db, orgId, now)` — **drop the `userId` parameter** and widen the predicate to
    `or(eq(alertFirings.orgId, orgId), isNull(alertFirings.orgId))`. This is the fix for defect 2 on
    the read side: every member of an org now sees the same firing list.
  - `ackAlertFiring(db, orgId, userId, id, now)` — keep `userId` **only** to stamp who acked;
    remove it from the `where`, replacing `eq(userId)` with
    `or(eq(alertFirings.orgId, orgId), isNull(alertFirings.orgId))`. A miss still returns
    `undefined` → 404, never 403 (no existence leak — the note at line 210-211).
  - `deliverPendingFirings` / `deliverResolvedFirings`: drop the `userId` predicate; add a `scope`
    parameter selecting `withOrg(db, orgId, role, …)` + `eq(orgId)` versus
    `withDeployment(db, role, …)` + `isNull(orgId)`. Keep the atomic-claim `UPDATE … RETURNING`
    **exactly as it is** — it is what makes one row deliver once.
- **PATTERN**: the existing `firingColumns` / `toFiring` / re-select shape; `withOrg` per statement
  with `deliver()` between them (the note at 236-249 explains why that must not become one long
  transaction, and that reasoning is unchanged).
- **GOTCHA**: do **not** merge the two upserts into one statement with a computed arbiter. Spike
  S3c: the wrong arbiter raises a hard `duplicate key` error naming the other index. That is a
  feature — the split is DB-enforced — but only if the two remain separate statements.
- **GOTCHA**: `notInArray(alertFirings.alertKey, keys)` with `keys = []` resolves ALL open firings in
  scope (D5, line 98). That behaviour must survive the split **per scope**: reconciling `[]` in the
  deployment scope must resolve the deployment rows and leave every org row alone. Spike check D
  proves the predicate shape; assert it in a test.
- **VALIDATE**: `npx tsc -b` — every remaining error is now a call site in `apps/ingest`, which is
  exactly the set you convert next. Note CLAUDE.md's 15.2 lesson: an **arity** change reports one
  error per CALL SITE (unlike a deleted import, which reports one per file), so this list is
  trustworthy — but still finish with the grep in Task 12.

### 7. SPLIT `apps/ingest/src/alert-set.ts`

- **IMPLEMENT**: `deriveAlertSet(built, inputs)` keeps the seven ORG codes — remove
  `deriveCatalogAlerts` and `deriveAuthFailureAlerts` from it. Add
  `deriveDeploymentAlertSet(inputs: DeploymentAlertInputs)` returning
  `sortAlerts([...deriveCatalogAlerts(pendingCatalogs), ...deriveAuthFailureAlerts(authFailureCount)])`.
  Narrow `AlertSetInputs` accordingly (drop `pendingCatalogs`/`authFailureCount`).
- **GOTCHA — rewrite the module doc, do not append to it.** It currently argues that ONE shared list
  prevents flapping. That argument is now served by a different mechanism (D-16.7-3: two lists whose
  SCOPES cannot intersect), and leaving the old prose beside the new code reproduces the 15.5
  defect — a comment naming a mechanism that is not the one in force. Name the new mechanism
  explicitly: disjoint `WHERE` predicates, not a shared array.
- **GOTCHA**: `openFiringsDiverge` is unchanged, but its callers must now pass a **scope-filtered**
  firing list (D-16.7-6). Add that requirement to its doc comment — it is the subtle way this slice
  can silently disable the M15 15.4 throttle.
- **VALIDATE**: `npx vitest run apps/ingest`.

### 8. UPDATE `apps/ingest/src/routes/monitor.ts`

- **IMPLEMENT**:
  - `buildSnapshot`: derive org alerts via `deriveAlertSet`; derive deployment alerts via
    `deriveDeploymentAlertSet`; `alerts` on the wire is `sortAlerts([...org, ...deployment])` so the
    dashboard's `alerts` array is unchanged in content.
  - The org reconcile keeps its shape but compares divergence against
    `firings.filter(f => f.scope === "org")`.
  - The deployment reconcile is a **separate** call outside the `withOrg` transaction, wrapped in
    `withDeployment(app.db, SERVICE_ROLE, …)`, throttled through `app.reconcileLastRunAt` under a
    reserved sentinel key (D-16.7-7). Use a named constant, e.g.
    `const DEPLOYMENT_THROTTLE_KEY = "*:deployment"`, and comment why a sentinel rather than a
    second map.
  - `deliverFirings` gains a deployment pass alongside the org pass, still best-effort, still
    outside any transaction.
  - `listAlertFirings(db, orgId, now)` — drop the `userId` argument at both call sites.
- **GOTCHA**: `buildSnapshot` receives a `Tx` (the route wraps it in `withOrg`). `withDeployment`
  takes a `Db` and opens its own transaction, so the deployment reconcile **cannot** live inside
  `buildSnapshot` — put it in the route handler beside `deliverFirings`, which already has that
  shape and that reason (lines 151-156).
- **GOTCHA**: the SSE path calls this every 3 s per connected client. The sentinel throttle is what
  stops N dashboards writing the deployment row N times a tick — this is M15 15.4 audit B.4 applied
  one scope over.
- **VALIDATE**: `npx vitest run apps/ingest`.

### 9. UPDATE `apps/ingest/src/alert-evaluator.ts`

- **IMPLEMENT**: `evaluateOrgAlerts` drops `countPendingCatalogs` / `countRecentAuthFailures` and
  uses `deriveAlertSet` with the narrowed inputs. Add `evaluateDeploymentAlerts(deps)` running ONCE
  per tick (not per org) inside `withDeployment`, doing the two global counts, the deployment
  reconcile and the deployment delivery. `runEvaluatorTick` calls it once **before** the org loop and
  adds its count to `result.alerts`; consider a `deploymentAlerts` field on `EvaluatorTickResult` so
  the log line distinguishes them.
- **GOTCHA — delete the two "KNOWN, OUT OF SCOPE" paragraphs (lines 122-146).** They describe
  exactly the defects this slice fixes. Leaving them is a documentation lie of the kind 15.5
  identified as the real defect. Replace with a short note recording what the fix was and pointing
  at D-16.7-3.
- **GOTCHA**: per-org error isolation (the try/catch at 277-309) must extend to the deployment pass —
  a failure there must not abort the org loop. It is the whole tick's shared prologue, so wrap it in
  its own try/catch and report through `onError` with a `deployment` label, mirroring the
  org-id-wrapped error at line 308.
- **VALIDATE**: `npx vitest run apps/ingest/src/alert-evaluator` and
  `npx vitest run apps/ingest/src/plugins/alert-evaluator.test.ts`.

### 10. UPDATE `apps/ingest/src/routes/alerts.ts`

- **IMPLEMENT**: the ack call keeps `principal.userId` (who acked) but the lookup is now org-scoped;
  a deployment firing is ackable from any org (`isNull(orgId)` matches under any context — spike
  S4a). Keep `withOrg(..., principal.role, ...)` here: an ack **is** a user-initiated write, so the
  15.4 "whose action is this?" test correctly answers "theirs", and the 0016 restrictive policy
  should reject a viewer's ack.
- **VALIDATE**: `npx vitest run apps/ingest`.

### 11. UPDATE the collector — `archive_unreachable` (D-16.7-8, D-16.7-9)

- **IMPLEMENT**:
  - `fault.ts`: `code: "auth_revoked" | "archive_unreachable"`. **`loadFault`'s validator at line
    113 (`if (rec.code !== "auth_revoked") return undefined`) must become a set membership check** —
    miss this and every `archive_unreachable` record you write reads back as a corrupt file, i.e.
    the feature silently does nothing. Document both codes on the interface: one is fatal, one is
    degraded.
  - `sync/sync-worker.ts`: add `onSyncFailure?: (consecutive: number) => void` to `SyncLoopDeps`,
    invoked in the `else` branch right after `consecutiveSyncFailures += 1` (line 212). Guard the
    call — a throwing callback must not unwind the sync loop (the F-16.3-2 shape; `capture-engine.ts`
    already guards `onFatal` at 393-395 for the same reason).
  - `capture-engine.ts`: add `onDegraded?: (fault: CaptureFault) => void` beside `onFatal`. Wire
    `onSyncFailure` to it, applying D-16.7-9's threshold and re-stamp policy, importing
    `ARCHIVE_UNREACHABLE_MIN_FAILURES` from `@420ai/shared`. It must **not** call `internal.abort()`
    and must **not** set `reported` (that guard belongs to the fatal path — an unreachable archive
    that later 401s must still be able to report the 401).
  - `cli.ts`: pass `onDegraded` into the engine; it calls `saveFault` and nothing else.
    `result.fault` and `watchExitCode` are **untouched** — this fault must not produce exit 1.
  - `serve.ts`: mirror the same wiring so the desktop surfaces it (it already reads `loadFault` at
    line 243 for the prior-fault announcement, which now covers both codes for free).
- **GOTCHA**: `clearFault` on `delivered > 0` (`cli.ts:379-381`) already self-resolves this record
  with no change — and the reasoning holds for both codes: only bytes the archive accepted prove it
  is reachable. Do not "improve" it to clear on outcome `"ok"`; an empty-queue drain returns `"ok"`
  without making a single request (the note at 373-378).
- **GOTCHA**: the startup announcement (`cli.ts:325-331`) says "It clears on the next sync that
  actually delivers" — accurate for both codes, so leave it. But it says "capture fault"
  unqualified; consider distinguishing stopped-vs-degraded so an operator is not told capture
  stopped when it is still running.
- **VALIDATE**: `npx vitest run apps/collector`.

### 12. ASSERT no stragglers

- **IMPLEMENT**: `grep -rn "alert_firings_by_user_status\|alertFirings.userId" apps/*/src packages/*/src`
  must return only the provenance write in `reconcileFirings` and the ack stamp.
- **GOTCHA**: this is CLAUDE.md's explicit pairing rule — `tsc -b` exiting 0 does not prove every
  call site was converted, so pair it with a grep. Here the grep is the *weaker* check (an arity
  change does report per call site), but the removed **index name** and the removed `userId`
  *predicate* are exactly what a type-checker cannot see.
- **VALIDATE**: the grep, plus `npm run typecheck`.

### 13. TESTS — see the strategy section below

### 14. UPDATE `SUMMARY.md`

- **IMPLEMENT**: flip **16.7** from ⬜ PLANNED to ✅ DONE with the date and PR number, in **both** the
  §0 status block and the §6 roadmap. Record D-16.7-1…9. If 16.7 is the last open slice, adjust the
  M16 status line.
- **GOTCHA**: `scripts/check-summary.mjs` FAILS the gate if an execution report exists for a slice
  not marked done — do this in the same commit as the execution report, not afterwards.
- **VALIDATE**: `npm run repo-health -- --fast`.

---

## TESTING STRATEGY

### Unit tests (no infra — always run)

- `packages/shared/src/alert-firings.test.ts` (create if absent): `alertKey` unchanged; the
  `split_part(alert_key, ':', 1)` assumption the migration depends on holds for **every** member of
  the `AlertCode` union — iterate the union, assert no code contains `":"`. This pins the migration's
  parsing assumption in a place that fails loudly if a future alert code breaks it.
- `apps/ingest/src/alert-set.test.ts` — **this file already exists and is the most important one you
  will touch.** It was written in 16.6 specifically to make the flap invariant provable without a
  database (its module doc: the invariant "exists to be provable" but was only provable when Postgres
  happened to be running — `skipped ≠ passed` applied to the guard). This slice **changes the
  mechanism that invariant rests on**, from "one shared list" to "two disjoint scopes", so the file's
  thesis must be rewritten, not appended to. Add: `deriveAlertSet` returns **none** of the two global
  codes for any input; `deriveDeploymentAlertSet` returns **only** those two; and the two key sets are
  **disjoint** — that is D-16.7-3 as an executable claim rather than a comment. It already imports
  `AUTH_FAILURE_ALERT` and `ARCHIVE_UNREACHABLE_MIN_FAILURES` from `@420ai/shared`, so the fixtures
  you need are in place.
- `apps/collector/src/fault.test.ts` (extend): `loadFault` round-trips an `archive_unreachable`
  record (this is the test that catches the `rec.code !== "auth_revoked"` trap); `saveFault`
  continuity preserves `since` across a code change from unreachable → auth_revoked starting a NEW
  clock (different `code` ⇒ different fault, per line 73-75).
- `apps/collector/src/sync/sync-worker.test.ts` (extend): `onSyncFailure` fires with an increasing
  count on consecutive retries and resets on `"ok"`; a **throwing** `onSyncFailure` does not unwind
  the loop.
- `apps/collector/src/capture-engine.test.ts` (extend): the degraded reporter fires at exactly the
  threshold, re-stamps sparsely rather than every failure, never calls `internal.abort()`, and does
  not consume the fatal `reported` guard.

### Integration tests (`*.int.test.ts`, DB-gated)

- **`packages/db/src/repositories/alert-firings.int.test.ts`** — extend the existing harness (seed
  via `users` insert → `ensurePersonalOrg` → `machines` insert, fixed clocks `t0…t4`). Add a
  **second user in the same org** (see the M15 15.4 seeding trap below) and assert:
  - two users reconciling the same alert produce **ONE** row (defect 2);
  - `listAlertFirings` returns the same list for both users;
  - either user can ack it, and the other sees `ackedAt` set;
  - `reconcileDeploymentFirings` opens one row with `org_id IS NULL` and `scope: "deployment"`;
  - `listAlertFirings(db, orgA, now)` includes it, and so does `listAlertFirings(db, orgB, now)`;
  - reconciling `[]` in the deployment scope resolves ONLY deployment rows (spike D).
- **`packages/db/src/repositories/rls.int.test.ts`** — add `DEPLOYMENT_SCOPED_TABLES` and move
  `alert_firings` out of `STRICT_TABLES`. Four DERIVED counts must absorb the move: the permissive
  total (`:536`), the restrictive total (`:587`), the strict-qual loop (`:545`) and the
  ENABLE+FORCE list (`:637` — `alert_firings` stays there, D-16.7-5). **Do not edit a literal
  integer** — the file's own note at 166-168 says every count is derived; if you find yourself
  changing a number, you have put the table in the wrong list. Add the **behavioural** pair
  (D-16.7-4): an unset-org app-role transaction reads ONLY `org_id IS NULL` rows (S4b) and is still
  REFUSED an org-scoped insert with `/row-level security policy/` (S4d). The structural qual check
  alone cannot tell the 16.7 policy from a bootstrap one.
- **`packages/db/src/repositories/tenancy.int.test.ts`** — `alert_firings` fails
  `is_nullable === "NO"` (`:376`). Move it to a new `DEPLOYMENT_SCOPED_TABLES` list asserted
  separately: it HAS an `org_id`, it IS nullable, and its FK to `organizations` is intact (keep it in
  the FK loop at `:392`).
- **`apps/ingest/src/alert-evaluator.int.test.ts`** — a tick over **three** orgs with one pending
  catalog produces exactly **ONE** open firing total for `catalog.update_requires_approval:*` and
  exactly **one** delivery (defect 1). This is the headline regression test; write it first and
  watch it fail before the fix.
- **A NEGATIVE CONTROL, required.** CLAUDE.md: verify a negative test FAILS with the fix removed, and
  remove it the RIGHT way. Restore the pre-16.7 policy (`USING (org_id = current_org)`, i.e. drop the
  `OR org_id IS NULL`) and confirm the deployment-visibility test fails — spike S4e already measured
  that it does (the global row became invisible to every org). Record the output in the execution
  report.

### Edge cases that must be covered

- Two users in one org reconciling **concurrently** — one row, no `23505` escaping to the caller.
- A resolved deployment firing **re-opening** later (the partial index must permit it — spike S2d).
- Ack from org B on a deployment firing opened while org A was reconciling.
- The dedupe migration run against a DB with **zero** firings (must be a clean no-op) and against one
  holding both defect shapes at once.
- Collector: threshold reached, archive recovers, `delivered > 0` clears the record; then the archive
  fails again and a **new** `since` is stamped.
- Collector: unreachable → then 401. The fatal path must still fire and still exit 1.

### The M15 15.4 seeding trap — read this before writing the two-user fixture

`setUserPassword` auto-creates a personal `owner` membership via `ensurePersonalOrg`, and
`findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`. So seeding a second user
into an existing org by INSERTing a membership is **silently shadowed** and every assertion tests an
owner. **Move** the existing membership instead. A multi-user fixture that has never existed before
is exactly where this bug hides — and this slice's central test *is* a multi-user fixture.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every one is a GATE.

### Level 1: Syntax & Style

```bash
npm run typecheck          # root `tsc -b` — MUST exit 0. Per-workspace build is not a substitute.
npm run lint               # ESLint. NOT part of repo-health; CI runs it.
npm run format:check       # prettier, incl. .md. CI runs it; local repo-health does not.
```

### Level 2: Unit Tests

```bash
npx vitest run packages/shared apps/collector apps/ingest   # focused
npm test                                                     # full suite; integration self-skips
```

Pass signal: 0 failures. The suite was **743+** tests as of M13 and has grown since — record the new
total in the execution report.

### Level 3: Integration Tests — `skipped ≠ passed`

```bash
npm run db:up
npm run db:migrate
# the TEST database is migrated SEPARATELY — a plain db:migrate does not touch 420ai_test
npm run repo-health -- --require-db
```

Pass signal: exit 0 **and** the run asserts the `*.int.test.ts` layer actually executed with
**0 skipped**. A plain `repo-health` PASS does not prove the DB layer ran. This slice touches
`@420ai/db`, `apps/ingest` **and** tenancy, so `--require-db` is mandatory, and it additionally
verifies `DATABASE_URL_TEST_APP` (`420ai_app`) is configured — without which the two-role suite is
theatre.

### Level 4: Manual Validation

1. **The rollback drill** (an acceptance criterion, not optional):
   `psql "$DATABASE_URL_TEST" -f packages/db/drizzle/down/0027_*.down.sql`, then
   `npm run db:migrate` forward. Diff `pg_indexes` + `pg_policies` for `alert_firings` before and
   after — they must match.
2. **The multi-org fan-out, end to end.** Seed three orgs, upload a signed pricing catalog so it sits
   `pending`, run one evaluator tick with a deliverer wired, and assert
   `select count(*) from alert_firings where alert_key='catalog.update_requires_approval:*' and status='open'`
   returns **1**, with exactly one delivery attempt.
3. **The dashboard still shows deployment alerts.** Start ingest + dashboard, open `/monitor`, confirm
   the two global codes render in the alerts panel (it reads `alertFirings`, so this only works if
   `listAlertFirings` unions them — D-16.7-6). Screenshot evidence via headless Edge per CLAUDE.md;
   pair it with an HTTP-layer assertion and `grep -c "$ADMIN_TOKEN"` on the page source `== 0`.
4. **The collector fault.** Point a paired collector at a dead port, let it exceed the threshold,
   then confirm `~/.420ai/fault.json` holds `code: "archive_unreachable"` with a plausible `since`,
   **the process is still running**, and `Ctrl-C` exits **0**.

### Level 5: Additional Validation

```bash
npm run build:dashboard    # next build — gates milestone sign-off; catches theGridCN barrel breakage
```

---

## ACCEPTANCE CRITERIA

- [ ] One pending pricing catalog produces exactly **one** open firing and **one** delivery across a
      three-org deployment (was: one per org).
- [ ] Two members of one org viewing the monitor produce exactly **one** open firing per condition
      and **one** delivery (was: one per user).
- [ ] Either member can ack it; the other sees it acked.
- [ ] The dashboard still renders both deployment-scoped alert codes.
- [ ] `alert_firings` carries exactly two partial unique indexes and one amended org policy.
- [ ] The two derive scopes are **disjoint**, asserted by a test, not by a comment.
- [ ] `rls.int.test.ts` classifies `alert_firings` in its own sixth list with a **behavioural** pair
      (unset context reads only global rows; is still refused an org-scoped insert), and **no literal
      count in the file was edited**.
- [ ] The negative control was run: with the `OR org_id IS NULL` removed, the deployment-visibility
      test FAILS. Output recorded in the execution report.
- [ ] The rollback drill was **run**, forward and back, with matching schema.
- [ ] A collector that cannot reach the archive for ≥ `ARCHIVE_UNREACHABLE_MIN_FAILURES` consecutive
      drains writes `fault.json` with `code: "archive_unreachable"`, **keeps capturing**, and exits
      0 on SIGINT.
- [ ] `loadFault` round-trips the new code (the `!== "auth_revoked"` trap is closed).
- [ ] `npm run repo-health -- --require-db` passes with the integration layer having actually run,
      **0 skipped**.
- [ ] `npm run lint` and `npm run format:check` pass (CI-only gates).
- [ ] `SUMMARY.md` updated in the same commit as the execution report.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task's validation passed immediately
- [ ] All validation commands executed successfully
- [ ] Full suite passes (unit + integration, `--require-db`)
- [ ] No typecheck, lint or format errors
- [ ] Manual validation confirms all four Level-4 scenarios
- [ ] Acceptance criteria all met
- [ ] Migration + `down/` reviewed for the ordering traps (dedupe before indexes; re-home before
      `SET NOT NULL`)

---

## NOTES

### Spikes actually run during planning, and what they changed

| Spike | Result | Effect on the plan |
| --- | --- | --- |
| S1 — `NULL <> NULL` under a composite partial unique index | **Confirmed** | Two indexes, not one. A single-index design would have "fixed" defect 1 by permitting unlimited duplicates. |
| S3c — wrong arbiter on a global row | **Contradicted the hypothesis** | Predicted a silent duplicate; measured a hard `duplicate key` error naming the other index. The two-upsert split is DB-enforced and loud. Plan rewritten to rely on that rather than on discipline. |
| S4b/c/d — role-only transaction | **Confirmed** | `withDeployment` is a real primitive: an unset org sees only global rows, may insert one, and is still refused an org-scoped insert. No tenancy hole. |
| S4e — negative control on the unamended strict policy | **Confirmed** | The `OR org_id IS NULL` amendment is load-bearing, not cosmetic. Reusable verbatim as the required negative control. |
| S5 — the dedupe migration against real duplicates | **Confirmed** | Both indexes build only after the dedupe; oldest `first_fired_at` survives. Fixed the statement ORDER in Task 2. |
| S6 — `SET NOT NULL` with a NULL row present | **Confirmed** | The `down/` script must re-home global rows FIRST. |
| Drizzle A–D | **Confirmed** | The exact `onConflictDoUpdate` shapes compile and behave; `user_id` is preserved as provenance (D-16.7-2 is measured, not assumed). |

Both throwaways were deleted and the test DB verified clean (`spike167` schemas: 0; `alert_firings`
policies unchanged).

### Trade-offs taken

- **Every org sees the deployment alert.** One row, one ack, one notice — but visible to all. The
  alternative (a "deployment admin" who alone sees it) has no schema support: roles are org-scoped.
  Given the conditions involved — a pricing catalog that changes everyone's costs, ingest auth
  failures that affect the whole archive — universal visibility is the honest model, and it is what
  makes a single shared ack coherent.
- **`user_id` kept rather than dropped.** A second migration for a column that is genuinely useful
  post-mortem would be churn. The risk is a future reader assuming it still scopes something; the
  mitigation is the schema comment, and Task 12's grep proves no predicate reads it.
- **The deployment reconcile runs from both the route and the tick** (D-16.7-7). Slightly more work
  per request than tick-only, bounded by the sentinel throttle — and it is what keeps the two global
  codes working when the evaluator is off, which is the default and is the case in ~30 int tests.

### What this slice deliberately does NOT do

- It does not change the fingerprint, the event shapes, or anything on the `events` table.
- It does not add an alert code. The `archive_unreachable` **collector fault** is a local file
  record, not a ninth-plus-one server-side alert; the server-side `archive.unreachable` alert already
  exists and is unchanged.
- It does not touch `deriveAlerts`, which stays frozen (D2), nor the delivery envelope format.

### Confidence

**9.5 / 10.** Earned by: 22 spike checks run against real Postgres during planning (18 raw SQL + 4
Drizzle, with one hypothesis **refuted** and the plan corrected); every imported symbol and signature
verified by reading its source rather than from memory; the existing test harness confirmed to exist
with its exact seeding helpers cited (`ensurePersonalOrg`, `alert-firings.int.test.ts:39-54`); the
four derived counts in `rls.int.test.ts` and the exact failing assertion in `tenancy.int.test.ts`
located by line; and the known-hostile seeding trap (15.4's shadowed membership) surfaced in advance
because this slice's central test is precisely the multi-user fixture that triggers it.

The residual 0.5 is one thing only: **the dedupe migration has been proven against a synthetic
pre-state, not against the real dogfood archive.** If that archive holds an `alert_firings` shape the
spike did not model — most plausibly a resolved-row backlog large enough that `DISTINCT ON` over
`status='open'` is slower than expected, or an open firing whose `alert_key` does not split on `":"`
because a future code was added — the migration could need a second pass. Closing it costs one
command against a copy of the production archive:
`select status, split_part(alert_key,':',1) code, count(*), count(distinct org_id) orgs, count(distinct user_id) users from alert_firings group by 1,2 order by 3 desc;`
Run that before applying 0027 and confirm the counts match what the dedupe expects. It is a
five-second check, and it is the difference between 9.5 and 10.
