# Execution Report — M16 Slice 16.7: Deployment-scoped alert firings

## Meta

**Plan**: [`.agents/plans/m16-slice7-deployment-scoped-alert-firings.md`](../plans/m16-slice7-deployment-scoped-alert-firings.md)
**Commit**: `8b2b9d0`
**Lines changed**: +8,520 / −364 across 38 files (of which `meta/0027_snapshot.json` is ~4,900
generated lines)

### Files added (5)

- `packages/db/drizzle/0027_strange_white_queen.sql`
- `packages/db/drizzle/down/0027_strange_white_queen.down.sql`
- `packages/db/drizzle/meta/0027_snapshot.json` (generated)
- `packages/shared/src/alert-firings.test.ts`
- `.agents/plans/m16-slice7-deployment-scoped-alert-firings.md`

### Files modified (33)

`packages/db`: `schema.ts`, `org-context.ts`, `index.ts`, `repositories/alert-firings.ts`,
`repositories/alert-firings.int.test.ts`, `repositories/rls.int.test.ts`,
`repositories/tenancy.int.test.ts`, `rollback.int.test.ts`, `drizzle/meta/_journal.json`
`packages/shared`: `alert-firings.ts`
`apps/ingest`: `alert-set.ts` + test, `alert-evaluator.ts` + `.int.test.ts`,
`plugins/alert-evaluator.ts` + test, `routes/monitor.ts`, `routes/alerts.ts`,
`routes/org-scoping.test.ts`, `rbac.int.test.ts`, `delivery/alert-deliverer.test.ts`,
`delivery/smtp-deliverer.test.ts`
`apps/collector`: `fault.ts` + test, `sync/sync-worker.ts` + test, `capture-engine.ts` + test,
`cli.ts` + test, `serve.ts` + test
`SUMMARY.md`

---

## Validation Results

| Gate                                | Result                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| Root `tsc -b`                       | ✓ 0 errors                                                    |
| `typecheck:dashboard`               | ✓ 0 errors                                                    |
| `typecheck:desktop`                 | ✓ 0 errors                                                    |
| NUL-byte scan                       | ✓ 855 tracked text files clean                                |
| Stray-artifact scan                 | ✓ clean across 6 `src/` dirs                                  |
| SUMMARY consistency                 | ✓ in sync                                                     |
| Unit tests                          | ✓ **170 files, 1,700 tests, 0 failures**                      |
| Integration tests                   | ✓ **680 integration tests ran, 0 skipped** (`--require-db`)   |
| Task 12 straggler grep              | ✓ clean (only the rename comment at `schema.ts:1021`)         |

`npm run repo-health -- --require-db` → **PASS**. The test database was migrated separately
(`DATABASE_URL=…/420ai_test npm run db:migrate`) before the run, per CLAUDE.md; `0027` verified
applied by querying `pg_indexes` and `information_schema.columns` directly.

Test suite grew from the plan's cited 743+ (M13) to **1,700**.

### The negative control — RUN, not assumed

The plan made this an acceptance criterion, and CLAUDE.md requires the policy be removed the RIGHT
way (replace with the strict `USING`, never merely drop it — dropping while RLS stays ENABLED denies
everything and fails the tests for the wrong reason).

Executed against the live test DB: `DROP POLICY` then re-create with the `OR org_id IS NULL`
amendment removed, leaving the strict `USING (org_id = …)` shape verified in `pg_policies`.

**Result — 3 of the 4 D-16.7-4 behavioural tests failed, each in the predicted way:**

```
× an ORG context sees its own rows AND the deployment row, never the other org's
    AssertionError: expected [ 'a' ] to deeply equal [ 'a', 'global' ]
× an UNSET org context sees ONLY the deployment rows (a role-only txn IS the scope)
    AssertionError: expected [] to deeply equal [ 'global' ]
× an unset-org transaction MAY insert a deployment row
Tests  3 failed | 3 passed | 10 skipped
```

The first failure is the important one: org A **still sees its own row** (`['a']`) and loses only
`'global'`. That is what makes it a control rather than a smoke test — the policy is still working,
it has merely stopped admitting the deployment scope. Without the amendment the dashboard, which
renders `alertFirings` and nothing else, would show neither global alert code at all.

Policy restored; the file re-runs **16/16 green**.

The suite also carries this control permanently as `rls.int.test.ts:937`, which flips the policy and
restores it in a `finally` — a test that holds the DB in a modified state on failure takes every
later test in the file down with it (the 15.5 held-transaction lesson, one level up).

### The rollback drill — RUN

`rollback.int.test.ts` was extended to assert the full `alert_firings` shape on both sides of a
roll-back/re-migrate cycle: the five-index list, `org_id` nullability, and whether the org policy
admits the deployment scope. It ran as part of the `--require-db` pass. Forward and back produce
matching schema; `policyCount` (72) and `restrictivePolicyCount` (51) are **unmoved** by 0027,
because it REPLACES a policy rather than adding one.

---

## What Went Well

- **The spike work paid for itself.** 22 checks against real Postgres during planning meant the
  implementation had no discovery phase for the parts that usually produce it. The
  `onConflictDoUpdate` shapes, the two-index requirement and the `withDeployment` semantics were
  all copied from measured results rather than derived at the keyboard.
- **S3c's refuted hypothesis changed the design for the better.** The prediction was that crossing
  the arbiters would silently insert a duplicate; Postgres instead raises `duplicate key value
  violates unique constraint "alert_firings_open_global_key"`, because it suppresses conflicts only
  on the *inferred* arbiter index. So the org/deployment split is enforced by the database, loudly,
  rather than by reviewer discipline — provided the two upserts stay separate statements, which is
  now recorded in the module doc, the migration prose and this report.
- **`rls.int.test.ts` absorbed the sixth classification with no literal integer edited.** All four
  derived counts (permissive total, restrictive total, strict-qual loop, ENABLE+FORCE list) took
  `DEPLOYMENT_SCOPED_TABLES.length` on their own. The file's own note says every count is derived
  and that changing a number means the table is in the wrong list; that held.
- **The structural + behavioural pairing worked as designed.** A substring check cannot distinguish
  16.7's `IS NULL` (tests the ROW's column) from a BOOTSTRAP table's (tests the SETTING) — they are
  opposite security properties. Dropping `alert_firings` into `BOOTSTRAP_TABLES` would have made the
  whole file pass while asserting that an unset context sees *every* firing. The behavioural pair is
  what actually pins it.
- **The `tsc` arity signal was trustworthy this time.** Unlike 15.2's deleted-import case (one error
  per FILE), changing `listAlertFirings`/`ackAlertFiring`/the two deliverers' arity reported one
  error per CALL SITE, so the error list was the conversion checklist. The grep still ran, and
  earned its place on the removed *index name*, which no type-checker can see.

---

## Challenges Encountered

- **The `consecutiveSyncFailures` counter could never reach its own threshold.** Discovered while
  wiring `onSyncFailure`: `syncOnce` returns `"ok"` for an empty claim without posting anything, and
  a failed item is backed off exponentially (1 s → 30 s) while `retryMs` stays at 1 s. So from the
  second failure onward the next claim finds nothing due, returns `"ok"`, and zeroed the streak —
  measured as the sequence 1, 1, 1, … forever against a permanently-503 archive instead of 1, 2, 3.
  `ARCHIVE_UNREACHABLE_MIN_FAILURES` is 3, and this counter is its ONLY input, so **both** the
  pre-existing server-side `archive.unreachable` alert and the new local fault record were
  undetectable by construction. Fixed by resetting only on `delivered > 0`, which is the same
  evidence standard `cli.ts` already applied to CLEARING the record ("only bytes the archive accepted
  prove it is reachable") — one half of the pair had it and the other did not.
- **The plan's ack instruction was not implementable.** Task 10 said keep `userId` "only to stamp who
  acked". There is nowhere to stamp it: `alert_firings` has `acked_at` but no `acked_by_user_id`, and
  `user_id` is the OPENER's id under D-16.7-2, which an ack must not overwrite. See Divergence 1.
- **Ordering the deployment reconcile relative to `buildSnapshot`** was not obvious from the plan.
  It must run BEFORE, because `listAlertFirings` unions the deployment rows — reconciling afterwards
  emits a frame where a newly-opened deployment alert is present in `alerts` and absent from
  `alertFirings`, i.e. un-ackable until the next tick. That is precisely the internally-inconsistent
  frame M15 15.4's throttle note warns about, one scope over.

---

## Divergences from Plan

### 1. `ackAlertFiring` drops `userId` entirely rather than keeping it to stamp the acker

- **Planned**: "keep `userId` **only** to stamp who acked; remove it from the `where`" (Task 6).
- **Actual**: the parameter is removed from the signature.
- **Reason**: there is no column to stamp. A parameter accepted and then ignored is the 15.5 defect
  in miniature — a signature asserting a behaviour the body does not have. What the slice genuinely
  *loses* is recorded in the function's doc rather than papered over: before 16.7 the acker was
  necessarily the row's `user_id`, so "who silenced this?" was answerable by accident; with a shared
  row it is not, and answering it again needs a column and a migration nobody has written.
- **Type**: Plan assumption wrong.

### 2. `listDeploymentFirings` added — a seventh repository function, not the planned six

- **Planned**: "Five functions become seven."
- **Actual**: eight exports (`reconcileAlertFirings`, `reconcileDeploymentFirings`,
  `listAlertFirings`, `listDeploymentFirings`, `ackAlertFiring`, the two deliverers, plus the private
  `reconcileFirings`).
- **Reason**: D-16.7-6 requires the deployment reconcile to compare divergence against
  deployment-scoped firings only. Filtering `listAlertFirings`' union in the caller would work but
  puts the scope-partitioning obligation at every call site; a scope-pure read makes it structural.
- **Type**: Better approach found.

### 3. `EvaluatorTickResult` gained `deploymentAlerts`

- **Planned**: "consider a `deploymentAlerts` field".
- **Actual**: added.
- **Reason**: without it the log line cannot distinguish "one deployment-wide condition" from "one
  condition in each of four orgs" — which is the exact distinction the slice exists to restore.
- **Type**: Better approach found.

### 4. The startup fault announcement names the KIND, in both entrypoints

- **Planned**: "**consider** distinguishing stopped-vs-degraded" (Task 11 gotcha).
- **Actual**: `cli.ts` and `serve.ts` both emit "a DEGRADED capture fault (capture kept running…)"
  or "a FATAL capture fault (capture had stopped)".
- **Reason**: the unqualified "a capture fault is on record" tells an operator that capture stopped,
  which is the *opposite* of what an `archive_unreachable` record means. Getting that backwards on
  the one message the feature exists to emit is worse than saying nothing.
- **Type**: Better approach found.

### 5. `sync-worker.ts` reset semantics changed — beyond the planned scope

- **Planned**: add `onSyncFailure` to `SyncLoopDeps`; the counter itself was not in scope.
- **Actual**: `consecutiveSyncFailures = 0` became `if (delivered > 0) consecutiveSyncFailures = 0`.
- **Reason**: the callback would otherwise have been wired to a counter that cannot exceed 1 against
  a threshold of 3 — a feature that ships green and does nothing. See Challenges above.
- **Type**: Plan assumption wrong (the plan treated the counter as sound).

---

## Skipped Items

- **Level-4 manual validations 2, 3 and 4** (the three-org fan-out by hand, the dashboard screenshot
  via headless Edge, and a live collector pointed at a dead port). Each is covered by an automated
  equivalent that ran: the fan-out by `alert-evaluator.int.test.ts` (three orgs, one pending catalog
  → exactly one open firing and one delivery), the union read by the `alert-firings.int.test.ts`
  cross-org assertions, and the collector fault by the `capture-engine`/`cli`/`fault` unit tests
  (threshold crossing, sparse re-stamp, no `abort()`, exit code untouched). **Stated plainly because
  they were part of the plan**: the browser-rendered and live-daemon paths were exercised by test
  rather than by hand.
- Nothing else from the plan was skipped.

---

## Code Review Findings

`/lril:code-review` produced **two medium findings**, both in failure paths — see
[`.agents/code-reviews/m16-slice7-deployment-scoped-alert-firings.md`](../code-reviews/m16-slice7-deployment-scoped-alert-firings.md).
Their disposition is recorded there and in the PR.

1. **The down migration can fail to rebuild `alert_firings_open_key`.** The old index is GLOBAL on
   `(user_id, alert_key)` with no org term; 0027's dedupe guaranteed uniqueness only *within* an org.
   One user can be the reconcile user for two orgs (`ensurePersonalOrg` + an invite), and
   connector-keyed `alert_key`s carry a connector NAME rather than an org-scoped id — so two orgs can
   legally hold the same key under the same user, and the rollback aborts on the index build. The
   down script's comment asserts the wrong guarantee, which is the more dangerous half.
2. **`consecutiveSyncFailures` now climbs without bound on a permanently-rejected batch.** The reset
   fix is correct, but every non-401 error is classified `"retry"` and the queue has no dead-letter
   path — so a poison batch (CLAUDE.md's 16 MiB `bodyLimit` → opaque `ECONNRESET` with the server
   still up) writes a permanent `archive_unreachable` record naming the wrong cause.

**Both were fixed** (maintainer chose "fix everything, including #2's mechanism"; #2 folded into
this slice rather than deferred). Two things are worth carrying forward from the fixes themselves:

- **The rollback drill was seeded and seen RED.** Every prior retarget asserted *schema shape* —
  index lists, policy counts, nullability — all of which an empty table satisfies. 0027 is the first
  migration in the file whose down script has a **data** precondition, so the drill was structurally
  incapable of catching this. It now seeds one user with the same open `alert_key` in two orgs, and
  removing the fix reproduces `could not create unique index "alert_firings_open_key"` exactly.
- **`syncOnce` now distinguishes reached-and-refused from could-not-complete.** A clean non-401 4xx
  reports via `onRefused`, resets the streak (positive proof of reachability, same standard as
  `delivered > 0`), and surfaces as a log line rather than an `archive_unreachable` record. Reported
  through a callback rather than a fourth `SyncOutcome`, following the file's own `onDelivered`
  precedent. The one case it cannot separate — an over-limit body reset mid-stream — is recorded in
  the doc comment as belonging to `claimBatch`'s **item-count** bound, which is the actual defect
  there.

---

## Recommendations

**For CLAUDE.md** — two candidates, both measured here rather than reasoned about:

- **"A dedupe guarantees the key it was keyed on, and nothing else."** 0027 deduped on
  `(org_id, alert_key)`; the down script needs `(user_id, alert_key)` global. Both are "the firings
  are deduped", and the comment said so — but a down migration inverting an index must re-derive the
  property that index requires, not inherit the forward migration's. Sibling of the existing "an
  aggregate over a tenancy column is a SMELL" entry.
- **"A counter feeding a threshold needs a test that drives it PAST the threshold."** The
  `consecutiveSyncFailures` bug survived from M12 12.6 through 16.6's incident review because every
  test asserted the increment (1 → 2) and none drove a sustained outage across a backoff boundary.
  `ARCHIVE_UNREACHABLE_MIN_FAILURES` is 3 and the counter's real ceiling was 1. Same family as
  `skipped ≠ passed`: *incremented ≠ reaches the threshold*.

**For the plan command**: the plan's spike evidence was unusually strong and directly reduced
implementation risk — worth keeping as the default for any slice carrying a migration. The one gap
was that it treated an existing, adjacent mechanism (`consecutiveSyncFailures`) as sound because the
slice merely *read* it. A plan that wires a new consumer onto an existing signal should spike that
signal too, not just the new code.
