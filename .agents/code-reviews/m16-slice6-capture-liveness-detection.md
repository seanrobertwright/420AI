# Code review — M16 slice 16.6, capture-liveness detection (INC-2026-07)

Reviewed **2026-08-06**, pre-commit, against the uncommitted working tree. Two independent
adversarial passes (ingest workstream, collector workstream) plus the author's own pass on the
long-lived-resource class the plan singled out.

**Stats**

- Files modified: 15
- Files added: 7 (`alert-evaluator.ts`, `alert-set.ts`, `plugins/alert-evaluator.ts`,
  `plugins/alert-evaluator.test.ts`, `alert-evaluator.int.test.ts`, `fault.ts`, `fault.test.ts`)
- Files deleted: 0

## What the review was FOR, and what it actually found

The plan asked for this pass specifically because the slice adds a `setInterval`, and CLAUDE.md
records that `tsc` and the test suite do not catch that class. It did find one such defect. But the
more useful yield was a different shape, and it is worth naming because it recurred four times
across two independent reviewers:

> **A test that cannot fail, guarding the thing you were most worried about.**

Four of the findings below are tests that would have passed against a broken — in two cases,
entirely absent — implementation. Every one of them sat on the highest-risk behaviour in its file.
That is the M15 15.5 lesson (a concurrency test at the wrong layer cannot fail) generalising: the
tests written most anxiously are the ones most likely to be measuring nothing, because anxiety
produces a test that *looks* like it exercises the risk rather than one derived from what would
actually change if the code were wrong.

Every fix below was verified by **reverting it and watching the test go red**. Where that check was
not performed the finding is marked as such.

---

## Critical

None.

## High

### 1. `derivable ≠ detected`, one level up: the derive-list parity was enforced by a comment

```
severity: high
file: apps/ingest/src/alert-evaluator.ts (and apps/ingest/src/routes/monitor.ts)
line: the six-call derive list, duplicated in both
```

**issue:** The tick and `GET /v1/monitor` each held their own copy of the six-call alert
composition, with a comment in each saying the two must stay identical.

**detail:** `reconcileAlertFirings` resolves every open firing whose key is absent from the derived
set (D5). So two lists that disagree make every firing in the difference **flap**: the tick closes
what the dashboard opens, the dashboard reopens it, and the operator receives a resolve notice per
cycle for an outage that never ended. `tsc` cannot see this — both call sites are independently
valid — and no test covered it. Adding a tenth alert code to one list and forgetting the other
would have shipped green. This is the repo's own "a per-FILE grep exempts the file, not the call
site" lesson one layer up: a comment enforces strictly less than the grep that was already proven
insufficient.

**fix:** Extracted to `apps/ingest/src/alert-set.ts` — one exported pure `deriveAlertSet`, called by
both. Deliberately NOT a refactor of `buildSnapshot`, which the plan keeps private to the route:
what is shared is the composition that must not diverge, while the *reads* still differ
legitimately (the tick skips `activeSessions`, which no derive function touches).

**verified:** A new integration test seeds three distinct codes and interleaves tick → HTTP read →
tick. Reverting to a diverged list (dropping `deriveCatalogAlerts` from the tick's path) fails
exactly that test — `expected 2 to be greater than or equal to 3` — and nothing else.

### 2. Two teardown tests that could not fail

```
severity: high
file: apps/ingest/src/alert-evaluator.int.test.ts
line: the two `buildApp` teardown tests
```

**issue:** Both tests guarding the leak class the plan sent this review hunting were vacuous.

**detail:** Two distinct mechanisms, same outcome.

- _"clears its interval on close"_ built its app **without `alertDeliverer`**. `buildApp` decorates
  `alertDeliverer` to `null` when omitted, so `deliverPendingFirings` early-returns before any
  query and the suite-level spy was **unreachable from that app under any circumstances**. The final
  assertion compared 0 to 0 and would have passed against a plugin with no `onClose` hook at all.
- _"starts NO timer when the interval is 0"_ asserted `app.close()` returns within 2 s, on the
  stated theory that a leaked timer would make it hang. **That theory is false.** Fastify's
  `close()` neither inspects nor awaits `setInterval` handles, and the plugin `unref()`s its timer
  anyway. The comment was the worse half of the defect: a false claim about the mechanism, which the
  next reader trusts instead of re-deriving.

**fix:** The first now wires the deliverer and seeds an offline machine, and asserts the pre-close
count is **non-zero** before asserting it does not move — so the spy is provably reachable. The
second asserts a tick-observable side effect (an offline machine is seeded; a default-built app must
leave zero firings and zero deliveries after 150 ms). Both false comments replaced with what was
measured.

### 3. The fault record self-resolved on a drain that never contacted the archive

```
severity: high
file: apps/collector/src/cli.ts (with sync/sync-worker.ts)
```

**issue:** `syncOnce` returns `"ok"` immediately when the queue is empty — no POST is made — and
`runSyncLoop` fires `onSync` on every `"ok"`, i.e. every idle tick (~2 s). `clearFault` was wired to
that unconditionally.

**detail:** After a 401 and a WinSW restart, the first idle tick on a quiet machine **deletes
`fault.json` without a single byte having reached the archive**. `service/README.md` tells the
operator "a file that is still there is a fault that is still happening", whose contrapositive they
will read as "no file = healthy". The self-resolution mechanism the slice calls load-bearing was
resolving on a no-op.

**fix:** `syncOnce` fires a new internal `onDelivered` only after a 2xx `ack`, `runSyncLoop`
accumulates it per iteration, and `onSync` now carries `(at, delivered)`. Both the CLI and the
desktop clear the fault only when `delivered > 0`. `lastSyncAt` semantics are unchanged — an empty
drain is still a legitimate "we are alive" timestamp, which is why the count had to be threaded
rather than the callback simply moved.

**verified:** Three tests, at three layers — `sync-worker.test.ts` (an empty no-POST drain reports
`delivered = 0`), `cli.test.ts` and `serve.test.ts` (an empty drain leaves the file on disk). All
three go red when the clear is made unconditional again.

### 4. `since` was overwritten on every restart, destroying the field that measures the outage

```
severity: high
file: apps/collector/src/capture-engine.ts, apps/collector/src/fault.ts
```

**issue:** `saveFault` overwrote unconditionally with `since = now`.

**detail:** On a persistent 401 the loop is 401 → write → exit 1 → WinSW restarts (5/10/20 s) → 401
→ overwrite `since`. So after an **eight-day** outage the record reports `since` ≈ 20 seconds ago.
The record cannot answer the one question the slice exists to answer, and the regression is *caused*
by the new exit-1-plus-restart behaviour, so it did not exist before this change.

**fix:** `saveFault` reads the existing record first: same `(code, url)` keeps the original `since`
and stamps the new observation into a separate `lastObservedAt`; a different code or url starts a
new clock. `lastObservedAt` is optional on `CaptureFault` on purpose — the `onFatal` producers only
know "now", which IS `since` for a fresh fault, so `saveFault` is the field's sole writer. Hence the
deliberate asymmetry in the tests: the callback payload has four keys, the persisted file has five.

**verified:** Saving twice with a later clock and asserting `since` is unchanged goes red the moment
the continuity logic is removed.

### 5. `serve.ts`'s conditional clear left a stale fault file permanently

```
severity: high
file: apps/collector/src/serve.ts
```

**issue:** The desktop cleared the file only `if (fault)` — the in-memory flag — but `startEngine`
resets that flag on every start. So: run 1 faults and writes the file → operator re-pairs → run 2
syncs successfully → the condition is false → **the file survives forever**, inside a single
process, no cross-process case required.

**detail:** The comment justifying the asymmetry was also factually wrong: `serve`'s home defaults to
`homedir()`, which is exactly the path the documented service install (`watch --home
C:\Users\YOURNAME`) targets — same machine, same credentials. Together with finding 3 the pair were
matched opposites: the CLI cleared when it must not, the desktop failed to clear when it must.

**fix:** Clears unconditionally, using finding 3's delivered-count predicate. Wrong comment removed.

## Medium

### 6. `onClose` cleared the interval but did not await an in-flight tick

```
severity: medium
file: apps/ingest/src/plugins/alert-evaluator.ts
```

`clearInterval` stops FUTURE ticks; it does nothing about the one that started 1 ms ago and is four
awaits deep in a transaction. That tick outlives `app.close()` and keeps issuing queries against a
handle the caller believes is finished — in a test, against a pool `afterAll` is about to `end()`,
surfacing as `Cannot use a pool after calling end` attributed to whatever file runs next.

**fix:** The in-flight promise is retained (not a boolean) and `onClose` awaits it, behind a `closed`
flag so a queued callback cannot start a new one.

**verified — and the first attempt at the test was itself worthless.** It slept 25 ms against a
20 ms interval and passed identically with and without the fix, because a tick over this fixture
finishes in ~2 ms and the race window was never open. Only holding the tick inside a deliberately
slow deliverer makes `close()`'s behaviour observable. Removing `await inFlight` now fails that test
and only that test.

### 7. A never-settling tick would silently disable the evaluator forever

```
severity: medium (consequence: total, silent loss of detection)
file: apps/ingest/src/plugins/alert-evaluator.ts
```

`createDb` sets no `statement_timeout` and no `query_timeout`, and the tick has no timeout. A lock
wait on `alert_firings` or a half-open connection leaves the promise pending forever; every later
interval early-returns on the re-entrancy guard. **That is INC-2026-07 reproduced inside the
component built to prevent it**, and the only symptom was one `warn` per minute that reads like a
benign slow-tick notice.

There is no safe automatic recovery — resetting the guard on a timeout lets the abandoned tick
overlap the next one, which is the multi-table deadlock the guard exists to prevent. So the fix is
the one CLAUDE.md prescribes for a backstop that cannot self-heal: **make it loud.** A consecutive-
skip counter escalates from `warn` to `error` after five straight skips, with a message naming the
consequence ("alerts are NOT being evaluated or delivered"). One skip and a wedge no longer look
alike in the log.

### 8. `NaN` interval defeated the disabled guard and started a 1 ms timer

```
severity: medium
file: apps/ingest/src/plugins/alert-evaluator.ts
```

`NaN <= 0` is `false`, so the guard passed, and `setInterval(fn, NaN)` coerces to **1 ms** — a
runaway evaluator hammering the pool. `server.ts` cannot produce it (`parsePositiveInt` throws), but
the guard belongs where the value is consumed, not in whichever caller happens to be careful.
Fixed with `Number.isFinite`, pinned by a unit test.

### 9. The tick result — including `failed` — was invisible in production

```
severity: medium
file: apps/ingest/src/plugins/alert-evaluator.ts
```

Logged at `debug`, while `server.ts` defaults `LOG_LEVEL` to `info`. So production had **no
evidence the evaluator ever ran**, leaving "healthy, nothing to report" and "has not ticked since
boot" indistinguishable — the precise ambiguity INC-2026-07 was made of. Now `info` whenever
anything happened (`alerts > 0 || failed > 0`), `debug` when quiet.

### 10. No tick at boot

```
severity: medium
file: apps/ingest/src/plugins/alert-evaluator.ts
```

`setInterval` alone leaves a full-interval blind window after every restart, and the sharp case is
not the ordinary 60 s delay: a process crash-looping faster than the interval would **never**
complete a tick — and "the archive keeps restarting" is exactly when alerting matters most. Now
fires once immediately then schedules, matching the SSE route's existing fire-then-schedule order.

### 11. A failed `saveFault` was swallowed, then the CLI lied about it

```
severity: medium
file: apps/collector/src/cli.ts
```

`saveFault` was called unguarded; a throw (read-only disk, ENOSPC, EPERM — all plausible for a
LocalSystem service) was swallowed by the engine's blanket catch, and `main()` still printed
`Recorded at <path>` for a file that was never created. An operator following the README then gets
"file not found" and concludes the tooling is broken. Now guarded, logged, and the stderr line is
conditional on the write having succeeded. The pre-existing ordering — in-memory fault assigned
*before* the write, so the exit code stays 1 even when the write fails — was correct and is kept.

### 12. The only end-to-end "no token leaks" assertion was vacuous

```
severity: medium
file: apps/collector/src/capture-engine.test.ts
```

The injected credential was `token: "revoked"` but the assertion searched for `"revoked-token"` — a
string that never appears regardless of implementation. It passed even if `onFatal` emitted the
token. Since the sibling assertion in `fault.test.ts` is tautological (it constructs an object with
no token, then asserts the serialization has no token), the secret-leak property had **zero real
coverage at the layer where a future field would actually be added**. Now uses a unique sentinel,
verified to go red when the token is deliberately leaked.

### 13. The headline behaviour — exit 1 on 401, exit 0 on SIGINT — had no test

```
severity: medium
file: apps/collector/src/cli.ts
```

`main()` is not exported and `process.exit` is not seamed, so deleting the entire `if (fault)`
branch left every test green. The failure would be invisible until an operator has a revoked token
in production — i.e. INC-2026-07 recurring. Fixed by extracting a pure `watchExitCode` mapper and
unit-testing both branches, matching the repo's existing `pairSummary` / `formatCliError` precedent
for extracting entrypoint logic solely to make it testable.

### 14. A test named for nine codes exercised one

```
severity: medium
file: apps/ingest/src/alert-evaluator.int.test.ts
```

"does not flap on the nine codes" seeded a single offline machine, so only one code was ever
derived and no divergence could show up. Its name is what a future reader would have trusted when
adding a tenth code. Renamed to what it does ("resolves an open firing once the condition clears")
and the real parity test added — see finding 1.

### 15. The plugin had no unit test at all

```
severity: medium
file: apps/ingest/src/plugins/alert-evaluator.ts
```

The integration suite's docstring dismissed the plugin as "trivia", but it owns three of the four
highest-risk behaviours in the slice — overlap suppression, crash suppression, teardown — and its
two teardown tests were the vacuous ones in finding 2. Added
`plugins/alert-evaluator.test.ts`: seven tests, no database, fake timers, covering interval 0, NaN,
the boot tick, overlap skipping, no-wedge-after-rejection, no unhandled rejection escaping the
interval callback, and close-awaits-in-flight.

## Low (fixed)

- **`onError` carried no org identity** — it is also the sink for per-firing delivery failures from
  two other functions, so a bare stack trace could not be attributed. Now wrapped with the org id
  via `{ cause }`.
- **`errors` was never reset between tests** and only one test ever asserted on it, so a swallowed
  per-firing delivery error elsewhere went unnoticed. Reset in `beforeEach`; happy paths now assert
  it is empty.
- **`resolveHome(args)` called twice** in the `watch` branch rather than hoisted — the exact
  substitution footgun the `pair` branch hoists to avoid. Hoisted.
- **`loadFault` cast arbitrary JSON** with no shape check, so `{}` yielded a record with `undefined`
  fields. Now validates before returning.
- **`serve.ts` emitted the same fault message twice** (a log line and an `error` event). Now one.
- **`clearFault` did a redundant `existsSync` + `rmSync`** (TOCTOU, and it ran on every idle tick).
  Simplified to `rmSync(..., { force: true })`.
- **A hand-written `pricing_catalogs` INSERT in the new test guessed a `signed_by` column** that
  does not exist. Rewritten against the typed schema — which is what the 15.1 explicit-column-list
  habit exists to prevent.

## Second triage pass — the maintainer elected to fix the deferred set

The findings below were initially deferred by the author. At the post-execute triage gate the
maintainer chose to fix them, and five were closed. Each is pinned by a test measured **red on
revert** — the fix was removed, the test confirmed failing, the fix restored.

### 16. A 401 on the HEARTBEAT was swallowed as a log line — FIXED

```
severity: medium (consequence: the slice's own failure mode, unclosed)
file: apps/collector/src/capture-engine.ts
```

The only path to `onFatal` was an ingest POST 401. But the heartbeat makes a real authenticated
request every ~30 s **regardless of queue state**, so on a quiet machine — empty queue, therefore no
ingest POST ever — a collector could sit for days with a revoked token, write no fault, exit 0 and
report nothing. That is INC-2026-07's exact shape with a smaller queue, left open by the slice built
to close it.

Fixed by routing `isUnauthorized` heartbeat errors into the same `reportFatal` + `abort` path (the
existing predicate, not a second one), while **keeping the swallow for every other heartbeat error**
— a transient blip or an older archive must stay non-fatal.

**verified:** two tests over an *empty* queue, so the ingest path provably cannot be the reporter
(its injected `post` throws if called). Stubbing the branch out makes the fatal test hang to a 5 s
timeout — the engine idles forever, which is the real pre-fix behaviour. A 503 heartbeat is the
negative control and stays green in both states.

### 17. A 401 during the SHUTDOWN DRAIN produced no fault and exit 0 — FIXED

The drain called `syncOnce` directly with no `onFatal` wiring and discarded the outcome, so a token
revoked while the operator restarts the machine was silently ignored. `drainBeforeExit` now returns
its `SyncOutcome` and a `"stop"` reports the fault, de-duplicated against the sync-loop path by a
shared `reported` flag.

**verified:** disabling the branch fails only that test (`expected [] to have a length of 1`).

### 18. `loadFault` had no production caller — FIXED

Nothing surfaced a pre-existing fault at startup, so after a restart in which the archive was merely
*unreachable* (rather than 401) the operator got no signal at all. Now reported through the logger
in `runWatch` and emitted as the existing `error` ControlEvent in `serve`'s `startEngine`.
`CONTROL_PROTOCOL_VERSION` untouched.

**One deliberate deviation:** `serve` emits the event **only**, not an event plus a log line —
because in `serve` the logger *is* a control-protocol event, so doing both would reintroduce
verbatim the duplicate-report defect finding 14 above just fixed.

### 19. `ALERT_EVALUATOR_INTERVAL_MS=0` was rejected, leaving no off switch — FIXED

`parsePositiveInt` rejects `0`, so an operator could not disable the evaluator by setting it to
zero; they had to unset the key, which falls through to the 60 s default — the opposite of the
intent, silently. `0` is now accepted as an explicit off switch, with a loud boot warning naming
the consequence. An EMPTY value still throws: `""` is a misconfiguration, `"0"` is an intention.

### 20. `process.exit` could truncate the stderr notice on a pipe — FIXED

Node's stdio is async for pipes on some platforms and `process.exit` does not flush pending async
writes, so `collector watch … | tee` could lose the one human-readable notice this feature adds.
Now written with `fs.writeSync(2, …)`.

**Note the test asserts the MECHANISM, not a reproduction** — whether a pipe flushes in time is
platform-dependent, so a reproduction test would have passed on this machine regardless of the fix.
That is precisely the "test that cannot fail" this review found four times, avoided on purpose.

## Deferred to slice 16.7 — with a destination, not a label

Two findings are the **same underlying design issue** and were split out at the triage gate, because
fixing them requires a migration and this slice's acceptance criteria state "no migration, no new
table, no new alert code".

- **The two GLOBAL alert codes fan out per org.** `catalog.update_requires_approval` and
  `ingest.auth_failure` derive from tables with no `org_id`, so one pending catalog opens a firing in
  EVERY org and sends one notice per org. Not dormant: `ensurePersonalOrg` makes org count track
  USER count, so inviting two teammates makes this a 3–4 org deployment. **The fix cannot live on
  the tick side alone** — the derive list is now shared with the route, so gating there would make
  the tick derive fewer codes than the dashboard and reintroduce the flapping the sharing prevents.
  Any fix therefore changes the dashboard's alert semantics too.
- **Firings are keyed `(user_id, alert_key)`**, so a non-owner opening the monitor opens a second
  row and a second delivery for one condition. Predates 16.6, but the tick now guarantees the
  owner's row always exists, turning an edge case into the default for every non-owner viewer.

Measured cost of the combined fix, which is why it is its own slice: a migration changing
`alert_firings_open_key` from `(user_id, alert_key)` to `(org_id, alert_key)` — **which fails on any
deployment already holding two users' open firings for the same key**, so it needs a dedupe/merge
data migration first — plus five repository functions, three call sites in `routes/monitor.ts`,
three in `alert-evaluator.ts`, the ack route, and a rollback drill.

## Verdict

The slice's core design held up under both passes: transaction and connection discipline
(sequential awaits inside `withOrg`, delivery on the unwrapped handle outside it), the
`SERVICE_ROLE` choice, per-org error isolation, and the library/entrypoint logging boundary were
each verified call site by call site and needed no change. What needed work was the *evidence* — four
tests that could not fail, two comments asserting mechanisms that do not exist, and one genuine
teardown leak — plus, after the maintainer's triage, the three remaining 401 observation points that
the first cut left unwatched.


---

## Third pass — `prp-review --agents all` (PR #80)

Two specialists over the **PR diff** (correctness/errors, tests/types) rather than the working tree.
16 new findings, none duplicating the passes above. The maintainer chose to fix 1–12 and defer one
to 16.7. Every fix measured red-on-revert.

### 21. `npm test` DELETED the operator's real `~/.420ai/fault.json` — FIXED

```
severity: high (destroys state outside the repo)
file: apps/collector/src/serve.test.ts
```

`makeHarness()` never supplied `home`, so `runServe` fell through to `deps.home ?? homedir()`. The
M13 13.1 test was updated to `onSyncSuccess?.(…, 1)` — `delivered > 0` — which reaches 16.6's new
`clearFault(faultPathFor(home))` and `rmSync`es the REAL record. On a dogfood machine, where a
Windows service under the same profile is the documented writer, **running the test suite erases the
durable outage record this slice exists to create** — and `service/README.md` tells the operator "no
file = healthy", so the suite manufactures precisely the false negative the slice was built to
eliminate. The quieter read half: ~15 pre-existing serve tests called `loadFault(faultPathFor(
homedir()))`, making their event stream depend on the developer's machine.

Fixed with a per-harness `mkdtemp` home plus **two guards**: a structural assertion that throws if
any harness resolves `home` to `homedir()`, and a behavioural test that redirects the profile,
plants a real `fault.json`, drives the exact shape that deleted it, and asserts the file survives.
**verified:** reverting deletes the planted file (`expected false to be true`); reverting only the
home while keeping the assertion fails 12 tests with a named error.

### 22. Duplicate alert delivery — the tick and the dashboard drained the same rows — FIXED

```
severity: medium
file: packages/db/src/repositories/alert-firings.ts
```

`deliverPendingFirings` was `SELECT … WHERE delivery_attempted_at IS NULL` → `await deliver()` → 
`UPDATE … SET delivery_attempted_at`: a read-then-write with a **third-party network round trip**
inside the window, no lock and no claim. Survivable while the only second caller was another browser
tab; 16.6 makes an unattended one permanent, and `routes/monitor.ts` calls `deliverFirings` on every
request and every SSE frame **unthrottled** (unlike the reconcile). At a 3 s stream cadence: the tick
selects a firing and awaits a ~200 ms webhook, 50 ms later the SSE frame selects the same unstamped
row and posts it again. Two identical pages for one outage.

Fixed with an atomic `UPDATE … WHERE delivery_attempted_at IS NULL … RETURNING` claim in both
deliver functions. At-most-once is unchanged and arguably strengthened — the stamp now lands before
the attempt, so a crash mid-delivery costs one notice rather than duplicating it.

### 23. The tick bypassed the 15.4 reconcile throttle → deadlock → wedge — FIXED

```
severity: medium
file: apps/ingest/src/alert-evaluator.ts
```

The route gates `reconcileAlertFirings` behind `shouldReconcile`; the tick called it directly,
neither consulting nor updating `app.reconcileLastRunAt`. So two reconciles for the same
`(org, owner)` could run concurrently — and `reconcileAlertFirings` takes locks in two phases (a
per-alert upsert loop, then a bulk `UPDATE … WHERE alert_key NOT IN (keys)`). With **different**
derived sets, phase 1 of one holds rows phase 2 of the other wants: a lock-order inversion, `40P01`.
Divergent sets are ordinary, not exotic — every alert is time-windowed and the two callers hold
different `now` values, so one window boundary between them suffices. And that deadlock is exactly
the never-settling tick that wedges the re-entrancy guard permanently.

Fixed by injecting the route's gate into `EvaluatorDeps` so both share one throttle, with
`openFiringsDiverge` moved to `alert-set.ts` so a throttled tick still reconciles when the answer
would differ — otherwise a newly-derived alert would sit with no firing row, un-ackable and
undelivered, on the path whose whole job is to report that something broke.

### 24–26. Three earlier fixes had shipped UNPINNED — FIXED

The wedge escalation, the `info`/`debug` decision, and per-org error isolation each had zero
coverage. The first two **are log lines** — their entire value is visibility at the default level —
and the test app was built with `logger: false`, making them unassertable; reverting the escalation
constant to 500 or the level to `debug` left the suite green. `failed > 0` appeared in no test, so
deleting the try/catch around the org loop would have left the whole file green while making one bad
org cost every other org its detection.

Fixed with a capturing pino stream in the plugin test and a proxied `transaction` in the int suite
that fails exactly one org. **verified:** each reverts red.

### 27–32. Six lows — FIXED

`loadFault` now validates `lastObservedAt` (read by two production callers, so `12345` would reach an
operator message); `WatchRunResult.recorded` made required and pinned with `@ts-expect-error`; the
shutdown drain now reports its delivered count so a stale fault clears; `as never` casts replaced;
`deriveAlertSet` gained a **no-DB** unit test (its only coverage was behind a DOUBLE env gate —
`skipped ≠ passed` applied to the guard rather than the feature); the clock is now read per org
rather than frozen across the tick.

**The unhandled-rejection test was rewritten rather than kept.** It asserted
`process.on("unhandledRejection")` was never called — which passes for the wrong reason: without the
swallow, the rejection propagates into `inFlight` and `await app.close()` rejects FIRST, so the test
goes red at a line unrelated to its name, and it never established that Node would emit the event
under vitest with fake timers at all. It now asserts the two things that are true and load-bearing:
the error is logged, and `close()` resolves.

### Deferred to 16.7 — a persistently unreachable archive is silent

`consecutiveSyncFailures` is reported **only via the heartbeat**, which is the one channel that
cannot arrive when the archive is what is down. So a 500/ECONNREFUSED loop grows the queue without
bound, writes no fault, exits 0, and leaves WinSW seeing a healthy service — INC-2026-07's
*observable symptom* reached by a different cause. The archive-side `archive.unreachable` alert
cannot cover it either, since it derives from heartbeat rows that by definition stop arriving. The
cheap fix is a second `CaptureFault.code`, which 16.6's "no new alert code" criterion excludes.

### Not fixed (maintainer's call, stated)

- The `"Recorded at"` vs `WARNING` string selection in `cli.ts` — `main()` is not seamed, so pinning
  one string needs a child-process harness.

### A note on the test run

Two intermediate full-suite runs showed scattered failures — an FK violation for a row just created,
`unknown machine` immediately after inserting it, different tests each time. That is the documented
Docker Postgres checkpoint-stall signature, not a regression: `CHECKPOINT` on both databases and the
suite returned to 169 files / 1646 tests / 653 integration / **0 skipped**, green. Recorded here
because the instinct on seeing it is to bisect, and bisecting a checkpoint stall finds nothing.
