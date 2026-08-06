# Execution Report — M16 Slice 16.6: Capture-Liveness Detection (INC-2026-07)

**Date:** 2026-08-06 · **Branch:** `m16-slice6-capture-liveness-detection`

## Meta

**Plan file:** [`.agents/plans/m16-slice6-capture-liveness-detection.md`](../plans/m16-slice6-capture-liveness-detection.md)

**Files added (10):**

| Path                                             | Purpose                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `apps/ingest/src/alert-evaluator.ts`             | `evaluateOrgAlerts` + `runEvaluatorTick` — the composition   |
| `apps/ingest/src/alert-set.ts`                   | The ONE derive list, shared by the tick and the route        |
| `apps/ingest/src/plugins/alert-evaluator.ts`     | The Fastify plugin owning the interval and its teardown      |
| `apps/ingest/src/plugins/alert-evaluator.test.ts`| Timer-contract unit tests (fake timers, no DB)               |
| `apps/ingest/src/alert-evaluator.int.test.ts`    | Two-role integration suite (app role, role-identity first)   |
| `apps/collector/src/fault.ts`                    | The durable `~/.420ai/fault.json` record                     |
| `apps/collector/src/fault.test.ts`               | Unit tests incl. `--home` routing and the field set          |
| `.agents/plans/m16-slice6-capture-liveness-detection.md` | The plan itself                                     |
| `.agents/code-reviews/m16-slice6-capture-liveness-detection.md` | The pre-commit review              |
| `.agents/qa/m16-slice6/`                         | Manual-validation evidence (webhook log + README)            |

**Files modified (16):** `apps/ingest/src/{app,server,routes/monitor,plugins/auth}.ts`;
`apps/collector/src/{capture-engine,cli,serve,sync/sync-worker}.ts` and their four test files;
`apps/collector/service/README.md`; `.env.example`; `.agents/research/weekly/TEMPLATE.md`;
`SUMMARY.md`.

**No migration, no new table, no new alert code** — as the plan required.

## Validation Results

| Lane                                       | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| Type checking (root `tsc -b`)              | ✓ 0 errors                                             |
| Type checking (`typecheck:dashboard`)      | ✓ 0 errors                                             |
| Type checking (`typecheck:desktop`)        | ✓ 0 errors                                             |
| `npm run repo-health -- --require-db`      | ✓ **PASS** — 167 files, 1619 tests, 652 integration, **0 skipped** |
| `npm run lint` (ESLint, CI-only)           | ✓ 0 errors                                             |
| `npm run format:check` (incl. markdown)    | ✓ clean                                                |
| NUL / stray-artifact / SUMMARY scans       | ✓ PASS                                                 |
| Manual validation (Level 4 item 1)         | ✓ open + resolve delivered, **0 inbound HTTP requests** |

The DB-backed layer **actually ran** — `skipped ≠ passed` — and the new ingest suite runs on the
**non-owner app role** with the role-identity assertion as its first test.

## What Went Well

- **The plan's spike fidelity held where it mattered.** `withOrg(db, orgId, SERVICE_ROLE, …)` +
  `machineStatuses(tx, orgId)` + `reconcileAlertFirings(tx, …)`, with `deliverPendingFirings` on the
  UNWRAPPED handle outside the transaction, composed exactly as S1 predicted. Both reviewers verified
  that discipline call site by call site and neither found a defect in it.
- **Choosing the org OWNER as the reconcile user was the right call and is now provable.** The
  `alert_firings_open_key` collision argument (S2) is real, and the suite carries a deliberately
  two-rung org — oldest membership a `viewer`, owner joining second — so a naive `members[0]` fails
  exactly one test. In a single-member org the two answers are identical, so without that fixture
  the whole claim would have been untested while appearing covered.
- **Negative controls were cheap and repeatedly decisive.** Swapping `SERVICE_ROLE` for `"viewer"`
  fails 12 of 16 with Postgres `42501`; dropping one derive call fails the parity test and nothing
  else; removing `await inFlight` fails the teardown test and nothing else. Each took under a minute
  and each converted a claim into a measurement.
- **The manual validation caught nothing, which is itself the result worth recording.** A real
  `server.ts` with a 5 s cadence delivered `collector.offline` within one tick, exactly once across
  six further ticks, then an `alert.resolved` after a fresh heartbeat — with `grep -c` over the
  server log confirming **zero** inbound requests. The headline claim is now evidence, not inference.

## Challenges Encountered

- **The plan's own reference snippet would have dropped an alert code.** It showed `connectors: []`
  on the built snapshot, but `deriveAlerts` reads `snapshot.connectors` for `connector.failing`. Per
  D5 a tick deriving fewer codes than the dashboard silently RESOLVES the missing ones every 60 s
  while the dashboard reopens them — flapping plus a resolve email per cycle. Caught by reading
  `alerts.ts` rather than trusting the snippet, which is the reason the plan says to.
- **The new suite passed alone and failed the full run — twice, from two different global leaks.**
  First `pricing_catalogs`: two of the nine codes are GLOBAL (no `org_id`), so leftover pending rows
  from an earlier file made every count come out exactly DOUBLE. Then a single `api_key.minted` row
  in `audit_events` — written by the last `beforeEach`, after which nothing truncates — failed
  `rollback.int.test.ts`, a file this slice never touched. With `fileParallelism: false` that is one
  real defect wearing another file's name. Confirmed by running the suite with the new file removed
  (green) and present (red), rather than by guessing.
- **My first regression test for my own teardown fix was worthless.** It slept 25 ms against a 20 ms
  interval and passed identically with and without `await inFlight`, because a tick over this fixture
  finishes in ~2 ms and the race window was never open. Only holding the tick inside a deliberately
  slow deliverer makes `close()`'s behaviour observable. The comment asserting it discriminated was
  the real defect — M15 15.5, reproduced by the author of the fix, on the fix itself.
- **A hand-written `pricing_catalogs` INSERT guessed a `signed_by` column that does not exist.**
  Rewritten against the typed schema — which is exactly what the 15.1 explicit-column-list habit is
  for, applied to a test fixture rather than a repository.

## Divergences from Plan

**The derive list was extracted to a shared module (`alert-set.ts`)**

- **Planned:** "Reproduce the composition; do NOT export/refactor the route's private function."
- **Actual:** `buildSnapshot` remains private and unrefactored, but the six-call derive composition
  moved to `apps/ingest/src/alert-set.ts` and both callers use it.
- **Reason:** the plan is right that a tick cannot share `buildSnapshot` — the route's throttle
  bookkeeping, principal handling and firing-list read have no tick equivalent. But duplicating the
  derive list left the plan's own stated correctness requirement ("the nine-code list is not padding;
  it is a correctness requirement") enforced by nothing but a comment. `tsc` sees two independently
  valid call sites; no test covered it; adding a tenth code to one list would ship green. CLAUDE.md
  is explicit that a comment asserting an invariant IS the defect when nothing enforces it. The READS
  still differ legitimately — the tick skips `activeSessions`, which nothing derives from — so what
  is shared is precisely the part that must not diverge.
- **Type:** Better approach found.

**`CaptureFault` gained `lastObservedAt`**

- **Planned:** `{ code; message; since; url }`.
- **Actual:** plus an optional `lastObservedAt`, with `saveFault` preserving the original `since`
  when the incoming record has the same `(code, url)`.
- **Reason:** a defect introduced by this slice's own exit-1 behaviour. On a persistent 401 the loop
  is 401 → write → exit 1 → WinSW restarts (5/10/20 s) → 401 → overwrite `since`. So after an
  **eight-day** outage the record would report `since` ≈ 20 seconds ago — the one field it exists to
  carry, destroyed by the restart the same slice introduced.
- **Type:** Bug found in the planned design.

**The sync callback carries a delivered count**

- **Planned:** "On a successful sync (`onSyncSuccess`), call `clearFault`."
- **Actual:** `syncOnce` fires `onDelivered` only after a 2xx `ack`; `onSync` is now
  `(at, delivered)`; the fault clears only when `delivered > 0`.
- **Reason:** `syncOnce` returns `"ok"` immediately on an empty queue with **no POST at all**, and
  `runSyncLoop` fires `onSync` on every `"ok"` (~2 s). So the planned wiring deleted `fault.json`
  within seconds of a WinSW restart on a quiet machine, without a byte reaching the archive — while
  `service/README.md` tells the operator a missing file means the fault is over. `lastSyncAt`
  semantics are unchanged, which is why the count had to be threaded rather than the callback moved.
- **Type:** Bug found in the planned design.

**An injectable `post` seam on `CaptureEngineOptions`**

- **Planned:** not mentioned; the plan's test strategy assumes "an injected `post` returning 401".
- **Actual:** an optional `post?: typeof postIngest`, mirroring the existing `SyncDeps.post` and
  `runSync`'s own `post?`.
- **Reason:** no such seam existed on the engine, so the 401 → `onFatal` path could only have been
  tested against a live HTTP server. It is what lets `capture-engine.test.ts` drive the REAL
  `runCaptureEngine` rather than a stub. Optional, unset in production, byte-identical production path.
- **Type:** Missing detail in the plan.

**Plugin hardening not in the plan** — a `Number.isFinite` guard (`NaN <= 0` is `false`, and
`setInterval(fn, NaN)` coerces to 1 ms), a boot-time tick (a process crash-looping faster than the
interval would otherwise NEVER evaluate), `info`-level logging when anything happened (at the default
`LOG_LEVEL` there was no evidence the evaluator ever ran — the exact ambiguity INC-2026-07 was made
of), and a consecutive-skip counter escalating `warn` → `error`. All from the code review; see
[`../code-reviews/m16-slice6-capture-liveness-detection.md`](../code-reviews/m16-slice6-capture-liveness-detection.md).

## Decisions

- **D-16.6-1 — no expected-machine registry.** A server-side registry lives in the same Postgres that
  was reset, so it cannot detect the event it exists for; and where the machine row survives,
  `machines.status='active'` + `collector.offline` already encode it. The durable "expected to
  report" fact belongs on the collector.
- **D-16.6-2 — the tick reconciles as the org OWNER.** `alert_firings_open_key` is unique on
  `(user_id, alert_key) WHERE status='open'`, so any other choice opens a second row and sends a
  second notice for one outage.
- **D-16.6-3 — reuse the existing `error` ControlEvent.** `CONTROL_PROTOCOL_VERSION` stays
  `m12-control-v3`; the Tauri UI is out of this slice.
- **D-16.6-4 — the evaluator is opt-in and defaults OFF in `buildApp`.** ~30 int-test files call
  `buildApp`; a non-zero default would start a timer in all of them.

## The Transferable Lesson

The repo's `skipped ≠ passed` / `bypassed ≠ enforced` / `passes on fixtures ≠ runs in production`
family gains a fourth member:

> **`derivable ≠ detected`.** The alert was correct, the data was present and the projection was
> right — and none of it mattered, because the only thing that ran it was a human who had no reason
> to look. A monitor whose evaluation trigger is the operator's suspicion can only ever confirm what
> the operator already suspects.

Its collector-side sibling is narrower and older: **an unattended daemon must not report success
through the same channel it reports nothing.** `collector sync` learned that as C.11 in M12;
`collector watch` never did, and the gap cost eight days.

And one about reviewing rather than building, which this slice demonstrated five times: **the tests
written most anxiously are the likeliest to measure nothing.** Five findings were tests that could
not fail, each guarding the highest-risk behaviour in its file — because anxiety produces a test that
*looks like* the risk instead of one derived from what would change if the code were wrong.

## The Second Triage Pass — all three 401 observation points now watched

The first cut wired `onFatal` to exactly one of the three places the collector makes an
authenticated request. At the post-execute triage gate the maintainer elected to close the rest,
and the most important one was not a polish item:

- **A 401 on the HEARTBEAT was swallowed as a log line.** The heartbeat makes a real authenticated
  request every ~30 s **regardless of queue state**, so on a quiet machine — empty queue, therefore
  no ingest POST ever — a collector could sit for days with a revoked token, write no fault, exit 0
  and report nothing. INC-2026-07's exact shape with a smaller queue, left open by the slice built
  to close it. Now routed into the same fault path, with the swallow kept for every OTHER heartbeat
  error (a transient blip must stay non-fatal). Pinned by a test over an *empty* queue, so the
  ingest path provably cannot be the reporter, with a 503 negative control.
- **A 401 during the shutdown drain** produced no record and exit 0 — the realistic shape of a token
  revoked while the operator restarts the machine. `drainBeforeExit` now surfaces its outcome,
  de-duplicated against the sync-loop path.
- **`loadFault` had no production caller**, so a fault recorded by an earlier run was invisible after
  a restart in which the archive was merely *unreachable*. Now announced at startup by both
  entrypoints.
- **`ALERT_EVALUATOR_INTERVAL_MS=0`** is now an explicit off switch with a loud boot warning; an
  EMPTY value still throws, because `""` is a misconfiguration and `"0"` is an intention.
- **`process.exit` could truncate the stderr notice on a pipe** — now `fs.writeSync(2, …)`. The test
  asserts the mechanism rather than attempting a reproduction, because pipe-flush timing is
  platform-dependent and a reproduction test would have passed regardless of the fix — which is
  precisely the "test that cannot fail" this slice's review found four times.

## Deferred to slice 16.7 — with a destination

Two findings are the **same underlying design issue** — global conditions stored as per-org,
per-user rows — and were split out at the triage gate rather than folded in, because the fix needs a
migration and this slice's acceptance criteria state "no migration, no new table, no new alert code".

- The two GLOBAL alert codes (`catalog.update_requires_approval`, `ingest.auth_failure`) fan out per
  org, and `ensurePersonalOrg` makes org count track USER count, so this is not dormant.
- Firings keyed `(user_id, alert_key)` mean a non-owner opening the monitor opens a second row and a
  second delivery for one condition.

**Why it cannot be a small fix:** the derive list is now shared with the route, so gating the global
codes on the tick side alone would make the tick derive fewer codes than the dashboard and
reintroduce the flapping the sharing exists to prevent. Any fix therefore changes the dashboard's
semantics too. And the index change (`(user_id, alert_key)` → `(org_id, alert_key)`) **fails on any
deployment already holding two users' open firings for the same key**, so it needs a dedupe/merge
data migration first, plus five repository functions, six call sites, the ack route and a rollback
drill.

## Known Residual Gaps

- **Level 4 items 2 and 3 were not exercised end to end** — proving the WinSW restart and the
  Windows Event Log entry needs a paired collector, a revoked machine row and a service install on a
  real machine. The behaviour is unit-covered at all three 401 observation points.
- **M16's remaining open box is unchanged**: four consecutive weekly scorecards in
  `.agents/research/weekly/`, blocked by the calendar (earliest close: late August 2026).
