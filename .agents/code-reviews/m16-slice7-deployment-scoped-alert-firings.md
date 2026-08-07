# Code Review — M16 Slice 16.7: Deployment-scoped alert firings

**Reviewed**: working tree at commit `8b2b9d0`, against
[`.agents/plans/m16-slice7-deployment-scoped-alert-firings.md`](../plans/m16-slice7-deployment-scoped-alert-firings.md).

**Stats:**

- Files Modified: 33
- Files Added: 5 (`0027_strange_white_queen.sql`, its `down/`, `meta/0027_snapshot.json`,
  `packages/shared/src/alert-firings.test.ts`, the plan)
- Files Deleted: 0
- New lines: 8,520 (includes the 4,900-line generated `0027_snapshot.json`)
- Deleted lines: 364

**Validation run during review:**

- `npm run repo-health:fast` — PASS (root `tsc -b`, dashboard and desktop lanes all 0 errors)
- `npx vitest run` — **170 files, 1,700 tests, 0 failures** (integration self-skipped; the
  `--require-db` run is Phase 4's gate, not this review's)
- Task 12 straggler grep (`alert_firings_by_user_status|alertFirings.userId`) — **clean**; the only
  hit is the comment at `packages/db/src/schema.ts:1021` recording the rename

---

## Summary

The slice does what it set out to do, and it does the hard parts correctly. The two-partial-index
partition (D-16.7-1), the disjoint-`WHERE` non-flapping argument (D-16.7-3), the sixth RLS
classification with a *behavioural* pair rather than a substring assertion (D-16.7-4), and the
degraded-not-fatal collector fault (D-16.7-8) are all implemented as specified and, unusually,
documented with the mechanism named rather than asserted. `rls.int.test.ts` absorbed the move
through derived counts with **no literal integer edited**, which was an explicit acceptance
criterion.

Two findings below are real. One is a rollback-path defect whose *comment* justifies safety with the
wrong guarantee — the CLAUDE.md 15.5 shape, in the one file that only ever runs during an incident.
The other is a consequence of the (correct and valuable) sync-counter fix: the counter now climbs on
failures that are not "the archive is unreachable".

---

## Findings

### 1. The down migration can fail to rebuild `alert_firings_open_key`, and its comment states the wrong guarantee

```
severity: medium
file: packages/db/drizzle/down/0027_strange_white_queen.down.sql
line: 34
issue: The restored `(user_id, alert_key)` unique index can fail to build, because 0027's dedupe
       was keyed on `(org_id, alert_key)` — a different guarantee than the one the old index needs.
```

**detail:**

The comment at lines 34–36 reads:

> The old `(user_id, alert_key)` unique index can only build if no org holds two open rows with the
> same key under DIFFERENT users — which is exactly what 0027 step 4 guaranteed.

That is not the property the index requires. The old index has **no org term at all** — it is
global across the table. What it requires is: *no USER holds two open rows with the same
`alert_key`, across ALL orgs*. 0027 step 4 guarantees something strictly weaker (uniqueness *within*
an org), and the post-0027 org index preserves only that weaker property.

The gap is reachable, not theoretical:

- `ensurePersonalOrg` gives every user a personal org, and an invited teammate holds a membership in
  a second one — so one user routinely spans two orgs.
- The reconcile's `user_id` for an org row is whoever the evaluator resolved as owner
  (`alert-evaluator.ts:397`) or whichever principal loaded the monitor (`routes/monitor.ts:319`).
  A user who owns two orgs is the `user_id` for both.
- `alertKey` is `` `${code}:${machineId ?? connector ?? "*"}` `` — and the connector-keyed codes
  (`connector.failing`, `connector.failure_rate`) key on the connector **name**
  (`alerts.ts:137`, `:321`, e.g. `claude-code`), which is **not org-scoped**.

So user U, owner of orgs A and B, each with a failing `claude-code` connector, produces two open
rows with identical `(user_id, alert_key)` and different `org_id`. Legal after 0027; forbidden by
the index the down script restores. The rollback then fails with
`could not create unique index "alert_firings_open_key"`.

**Blast radius is bounded but the rollback is blocked.** `rollback.ts:40-51` wraps the down SQL in
`begin`/`commit`, so the failure aborts the whole script cleanly — no partial data loss, and the
deployment-row `DELETE` at line 27 is rolled back with it. But the rollback simply cannot proceed
without hand-written SQL, which is the worst time to be writing hand-written SQL. The rollback drill
in `rollback.int.test.ts` cannot catch this: it runs against a table holding no such rows.

**suggestion:** add a `(user_id, alert_key)` dedupe immediately before the index rebuild — the exact
shape of 0027 step 4, re-keyed — and correct the comment to name the property that is actually
required:

```sql
-- The old index is GLOBAL on (user_id, alert_key): no org term. One user can be the reconcile
-- user for two orgs (ensurePersonalOrg + an invite), and connector-keyed alert_keys carry a
-- connector NAME rather than an org-scoped id, so two orgs can legally hold the same key under
-- the same user. 0027 step 4 deduped per (org_id, alert_key), which does NOT imply this.
UPDATE "alert_firings" SET "status" = 'resolved', "resolved_at" = now()
 WHERE "status" = 'open' AND "id" NOT IN (
   SELECT DISTINCT ON ("user_id", "alert_key") "id" FROM "alert_firings"
    WHERE "status" = 'open'
    ORDER BY "user_id", "alert_key", "first_fired_at" ASC, "id" ASC);--> statement-breakpoint
```

Place it after step 1 (the deployment rows are gone by then, so `user_id` is the only axis left) and
before the `CREATE UNIQUE INDEX` at line 40.

---

### 2. `consecutiveSyncFailures` now climbs without bound on a permanently-rejected batch, reporting "archive unreachable" while the archive is up

```
severity: medium
file: apps/collector/src/sync/sync-worker.ts
line: 242
issue: `if (delivered > 0) consecutiveSyncFailures = 0` correctly fixes a detector that could never
       fire, but a NON-TRANSIENT rejection now grows the streak forever and is misattributed.
```

**detail:**

The change itself is right and is the most valuable find in the slice: the old
`consecutiveSyncFailures = 0` on every `"ok"` made the counter oscillate 1,1,1… (because `syncOnce`
returns `"ok"` for an empty claim, and a failed item backs off 1s→30s while `retryMs` stays at 1s),
so a threshold of 3 was unreachable and **both** the server-side `archive.unreachable` alert and the
new local fault record were undetectable-by-construction.

But the new gate changes what the counter counts. `syncOnce:87-89` classifies **every** non-401,
non-abort error as `"retry"` → `markFailed` → streak++, and the queue has **no dead-letter path**
(`queue/queue-store.ts` only ever backs items off). So a batch the archive will *never* accept
climbs the streak indefinitely:

- CLAUDE.md documents exactly this case under "Collector outbound HTTP (UAT C.6)": a body over the
  ingest server's **16 MiB `bodyLimit`** is rejected mid-stream and surfaces as an opaque
  `ECONNRESET` **with the server still up** — not a clean 413. `claimBatch(500)` has no byte bound.
- Any other permanent 4xx (a malformed payload from a parser bug) behaves the same.

Consequence: a permanent local `fault.json` with `code: "archive_unreachable"` and a permanent
server-side `archive.unreachable` alert, both naming the wrong cause, for a condition that is
actually "one queue batch is unshippable". Before this slice the oscillating counter masked it; the
fix un-masks it as the wrong diagnosis. The queue also grows without bound behind the stuck batch,
which is the INC-2026-07 symptom again.

Note the in-code comment at :239-241 asserts the counter "cannot get stuck high on a genuinely
healthy machine" because a non-zero streak implies pending items and "the first drain that reaches a
recovered archive delivers and resets". That holds only when the failure was transport-shaped. A
poison batch reaches the archive on every attempt and is refused every time.

**suggestion:** the honest fix is to make the streak count *transport* failures rather than all
non-401 failures — e.g. have `syncOnce` distinguish "could not reach" from "reached and was
refused", and only the former increments. If that is out of 16.7's scope, defer it to a named
destination and narrow the comment at :239-241 so it does not claim a property the code does not
have; an unqualified "cannot get stuck high" is the assertion a future reader will trust instead of
re-deriving.

---

### 3. `ackAlertFiring` drops `userId`, deviating from the plan — correctly, and documented

```
severity: low (informational — no change recommended)
file: packages/db/src/repositories/alert-firings.ts
line: 351
issue: Plan task 10 said "keep `userId` only to stamp who acked"; the implementation drops the
       parameter entirely.
```

**detail:** the plan's instruction was not implementable — `alert_firings` has `acked_at` but no
`acked_by_user_id`, and `user_id` is the opener's id (D-16.7-2 provenance) which an ack must not
overwrite. The code says so at :359-368 and records what the slice *loses* ("who silenced this?" was
previously answerable by accident and now is not). Keeping an accepted-then-ignored parameter would
have been the 15.5 defect in miniature. This is the right call; flagged only so the plan/implementation
divergence is on the record rather than discovered later.

---

## Verified and found sound (no action)

- **The two-index partition.** `schema.ts` carries `alert_firings_open_key` on `(org_id, alert_key)`
  with `AND org_id IS NOT NULL`, plus `alert_firings_open_global_key` on `alert_key` alone with
  `org_id IS NULL`. They partition rather than overlap, and the migration's prose carries the
  measured `NULL <> NULL` result the next reader will want to second-guess.
- **Statement order in 0027.** Widen → drop old indexes → three dedupes → build both indexes →
  amend the policy. The dedupe genuinely must precede the builds.
- **The two upserts stay separate statements** with different arbiters, and both the module doc and
  the migration record *why* crossing them raises rather than silently duplicating.
- **`withDeployment` never sets `app.current_org`**, rejects a blank role for `withOrg`'s exact
  reason, and takes `Db` not `DbClient` — all three of the plan's gotchas honoured.
- **The throttle partition.** Both `buildSnapshot` (`monitor.ts:159`) and `evaluateOrgAlerts`
  (`alert-evaluator.ts:241`) filter `f.scope === "org"` before `openFiringsDiverge`, which is the
  subtle way this slice could have silently restored the every-3-s write. The deployment caller uses
  `listDeploymentFirings`, which is already scope-pure.
- **Ordering of the deployment reconcile before `buildSnapshot`** — correct, and for the stated
  reason: `listAlertFirings` unions the deployment rows, so reconciling afterwards would emit a frame
  where a new deployment alert is in `alerts` but absent from `alertFirings`, i.e. un-ackable.
- **`routes/alerts.ts` keeps `principal.role`** while the reconcile/delivery paths use `SERVICE_ROLE`
  — the 15.4 "whose action is this?" test applied correctly in both directions.
- **`loadFault`'s validator became a set-membership check** derived from `FAULT_CODES`
  (`fault.ts:149`), closing the `!== "auth_revoked"` trap that would have made the whole collector
  feature silently do nothing.
- **`onDegraded` never touches `result.fault`** in either `cli.ts` or `serve.ts`, so `watchExitCode`
  is unchanged and WinSW does not restart-loop. `serve.ts:312-321` explicitly declines to assign
  `fault` and says why.
- **The degraded re-stamp arithmetic** at `capture-engine.ts:454-463` is correct: writes at exactly
  `ARCHIVE_UNREACHABLE_MIN_FAILURES`, then every 60th subsequent failure; never calls
  `internal.abort()`; never consumes the fatal `reported` guard.
- **`onSyncFailure` is guarded** against a throwing callback (`sync-worker.ts:250-254`), per F-16.3-2.
- **`rls.int.test.ts`** adds `DEPLOYMENT_SCOPED_TABLES` with an exactly-one-classification guard, an
  assertion that the qual is **not** bootstrap-shaped, and an explicit `WITH CHECK` check. All four
  derived counts absorbed the move; **no literal integer was edited**.
- **`rollback.int.test.ts`** asserts the full index list, the nullability and the policy shape both
  before and after the roll-back/re-migrate cycle.

---

## Verdict

Two medium findings, both in failure paths rather than the happy path, and both of the same family:
a comment or a counter that means something slightly different from what the next reader will assume.
Finding 1 blocks a rollback; finding 2 misattributes a cause. Neither affects the slice's primary
deliverable, which is correct.

---

## Resolution (triaged by the maintainer — "fix everything, including #2's mechanism")

Both findings were fixed in full; #2's mechanism was folded into this slice rather than deferred.

### Finding 1 — fixed, and the regression test was seen RED first

`down/0027_strange_white_queen.down.sql` gains a global `(user_id, alert_key)` dedupe as step 3,
before the index rebuild, and the misleading comment is replaced with one that names the property
the old index actually requires and why 0027 step 4 does not imply it.

`rollback.int.test.ts` now **seeds the hostile shape** before rolling back — one user holding an
open `connector.failing:claude-code` firing in two different orgs — and asserts exactly one survives
open. This matters more than the SQL: every prior retarget of the drill asserted *schema shape*
(index lists, policy counts, nullability), all of which an empty table satisfies. 0027 is the first
migration in the file whose down script has a **data** precondition, so the drill could not have
caught this without data.

**Verified by removing the fix**: with the dedupe statement deleted, the drill fails with

```
error: could not create unique index "alert_firings_open_key"
Test Files  1 failed (1)
```

which is the predicted error verbatim. Restored → 1 passed. A regression test never seen red is a
claim, not evidence.

### Finding 2 — fixed at the mechanism, not just the comment

`syncOnce` now distinguishes **reached-and-refused** from **could-not-complete**. A clean non-401
4xx (400 / 413 / 422) reports through a new `onRefused` callback; the sync loop treats it as
positive proof of reachability, so it **resets** the streak exactly as `delivered > 0` does and
never grows it.

Reported through a callback rather than a fourth `SyncOutcome` variant, following the file's own
established precedent: `onDelivered` exists because the outcome answers "what should the loop do
next" (back off and retry — identical either way) and the loop's other question needed its own
channel. A fourth variant would also have rippled into `capture-engine`'s drain and `cli.ts`'s
`WatchRunResult` for no behavioural gain.

Not silent: `capture-engine.ts` wires `onSyncRefused` to a log line explaining that the archive is
reachable and the batch needs an operator — deliberately **not** to `reportDegraded`, whose record
says "cannot reach the archive" and would send someone to check the wrong thing.

**Residual ambiguity, stated rather than papered over.** CLAUDE.md's UAT C.6 case — a body over the
16 MiB `bodyLimit` rejected mid-stream — reaches the client as an opaque `ECONNRESET` with the
server still up, *not* a clean 413. That case is genuinely indistinguishable from a transport
failure at this layer and still grows the streak, which is the honest reading: the request did not
complete. The real defect there is that `claimBatch` bounds a batch by **item count** (500) and not
by bytes, so the fix belongs in the batching, not in this predicate. Recorded in
`SyncDeps.onRefused`'s doc comment.

Four tests added, all passing (21/21 in the file): a refused batch never grows the streak; a 5xx
still does (the complement, which is why the predicate is 4xx and not "any HTTP status"); a refusal
resets an accumulated streak; and a throwing `onSyncRefused` does not unwind the loop.

### Finding 3 — no action, as recommended

The deviation is correct and already documented in the code and the execution report.

### Outcome table

| #   | Severity | Issue                                                      | File                                                  | Disposition | What was done                                                                                                          | Status         |
| --- | -------- | ---------------------------------------------------------- | ----------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Medium   | Down migration can fail to rebuild `alert_firings_open_key` | `packages/db/drizzle/down/0027_…down.sql:34`           | Fix         | Global `(user_id, alert_key)` dedupe added before the index rebuild; comment corrected; seeded regression test **seen red first** | Fixed          |
| 2   | Medium   | `consecutiveSyncFailures` climbs on a permanently-refused batch | `apps/collector/src/sync/sync-worker.ts:242`      | Fix (mechanism folded in) | `onRefused`/`onSyncRefused` split reached-and-refused from could-not-complete; a clean 4xx now resets the streak; surfaced as a log line; 4 tests | Fixed          |
| 3   | Low      | `ackAlertFiring` drops `userId`, deviating from plan task 10 | `packages/db/src/repositories/alert-firings.ts:351`  | No action   | Deviation is correct and documented in code + execution report                                                          | No change needed |
