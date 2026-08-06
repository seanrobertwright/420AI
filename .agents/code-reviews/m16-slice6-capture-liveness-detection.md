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

## Accepted, NOT fixed — stated rather than quietly absorbed

These are real and were deliberately left, because each changes behaviour beyond the slice's stated
scope ("no migration, no new table, no new alert code"). They are recorded here and in the code so
the next reader inherits the measurement rather than rediscovering it.

- **A 401 first observed during the SHUTDOWN DRAIN produces no fault record and exit 0.** The drain
  calls `syncOnce` directly with no `onFatal` wiring and discards the outcome. Realistic shape: a
  token revoked while the operator happens to be restarting the machine.
- **A 401 on the HEARTBEAT is swallowed as a log line.** The only path to `onFatal` is an ingest
  POST 401, but the heartbeat makes a real authenticated request every 30 s regardless of queue
  state. On a quiet machine the collector can sit for days with a dead credential and report
  nothing — INC-2026-07's exact shape with a smaller queue. **This is the most significant residual
  gap in the slice** and the natural next increment; it would also give the fault-clearing predicate
  a positive "the credential is confirmed good" signal.
- **`loadFault` has no production caller** — nothing surfaces a pre-existing fault at startup, so
  after a restart in which the archive is merely unreachable the operator gets no signal unless they
  read the file by hand.
- **The two GLOBAL alert codes fan out per org**, and because `ensurePersonalOrg` gives every user
  their own org, org count tracks USER count. One pending catalog opens a firing in every org. The
  earlier code comment defended this as "the dashboard already does exactly this", which is false
  for auto-created personal orgs nobody ever opens; the comment has been corrected.
- **Firings are keyed `(user_id, alert_key)`**, so a non-owner opening the monitor still opens a
  second row and a second delivery. Predates 16.6, but the tick now guarantees the owner's row
  always exists, which turns an edge case into the default for any non-owner viewer.
- **`ALERT_EVALUATOR_INTERVAL_MS=0` is rejected** by `parsePositiveInt`, so an operator cannot
  disable the evaluator by setting it to zero — they must unset the key, which falls through to the
  60 s default, i.e. the opposite of what they intended.
- **`process.exit(1)` immediately after `process.stderr.write`** can truncate on a pipe (Node's
  stdio is async for pipes on Windows). WinSW captures via file handles so the service path is safe;
  `collector watch … | tee` may lose the line. The pre-existing `process.exit(0)` has the same
  exposure, so this is not new.

## Verdict

The slice's core design held up under both passes: transaction and connection discipline
(sequential awaits inside `withOrg`, delivery on the unwrapped handle outside it), the
`SERVICE_ROLE` choice, per-org error isolation, and the library/entrypoint logging boundary were
each verified call site by call site and needed no change. What needed work was the *evidence* — four
tests that could not fail, two comments asserting mechanisms that do not exist, and one genuine
teardown leak. All fixed and re-verified by reverting each fix.
