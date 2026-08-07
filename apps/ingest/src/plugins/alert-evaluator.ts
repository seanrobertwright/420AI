import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { runEvaluatorTick } from "../alert-evaluator.js";

/**
 * Consecutive skipped intervals before the log escalates from `warn` to `error`. Five is chosen so
 * a genuinely slow tick on a large deployment stays a `warn`, while five straight minutes of not
 * evaluating anything (at the 60 s default) is reported as what it is — an outage of the outage
 * detector. See `consecutiveSkips` below.
 */
const WEDGED_AFTER_SKIPS = 5;

/**
 * M16 16.6 — the TIMER that makes `alert-evaluator.ts` actually run (INC-2026-07).
 *
 * Everything interesting is in `../alert-evaluator.ts`; this plugin is the trivia layered on top:
 * it owns the interval, its teardown, and the entrypoint-side logging the library file refuses to
 * do itself (CLAUDE.md's logging boundary).
 *
 * OPT-IN, DEFAULT OFF. `app.alertEvaluatorIntervalMs` is `0` unless a caller passes one, and only
 * `server.ts` does. That default is not politeness — roughly thirty `*.int.test.ts` files call
 * `buildApp`, and a timer started in all of them would race `app.close()` and surface as flaky,
 * unrelated failures in suites that have nothing to do with alerts. Same shape as `alertDeliverer`
 * and `selfSignupEnabled`.
 */
export default fp(async function alertEvaluatorPlugin(app: FastifyInstance): Promise<void> {
  const intervalMs = app.alertEvaluatorIntervalMs;
  // `Number.isFinite` FIRST, and not merely for tidiness: `NaN <= 0` is `false`, so a bare
  // `<= 0` guard PASSES for NaN and `setInterval(fn, NaN)` is coerced to **1 ms** — a runaway
  // evaluator hammering the pool. `server.ts` cannot produce that (its `parsePositiveInt` throws),
  // but the guard belongs where the value is consumed, not in whichever caller happens to be
  // careful: any future embedder writing `alertEvaluatorIntervalMs: Number(someEnv)` gets it.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return; // disabled — no timer to tear down

  // Ticks must NOT overlap. A tick opens a transaction per org spanning six reads plus the
  // reconcile write, so two concurrent ticks are two transactions taking multi-table locks in
  // whatever order the planner picks — the deadlock shape M15 15.3 measured on the SSE path
  // (40P01, aborting unrelated suites' TRUNCATEs). Skipping is also the right semantic: a tick
  // wants the CURRENT state, never a backlog of stale ones.
  //
  // The promise itself is retained, not just a boolean, because `onClose` must AWAIT it — see the
  // teardown note at the bottom.
  let inFlight: Promise<void> | null = null;
  // Set by `onClose`. Distinct from `inFlight`: it stops a tick that has not STARTED yet, which a
  // cleared interval alone does not guarantee (the callback may already be queued on the event loop
  // when `clearInterval` runs).
  let closed = false;
  /**
   * Consecutive intervals skipped because a tick was still running.
   *
   * THIS COUNTER IS THE SLICE'S OWN LESSON TURNED ON ITSELF. The `inFlight` guard cannot wedge via
   * the throw path (`runTick` swallows everything, and the `finally` always clears the slot), but
   * it CAN wedge on a promise that never settles — and one is reachable: `createDb` sets no
   * `statement_timeout` and no `query_timeout`, so a lock wait on `alert_firings` or a half-open
   * connection to Postgres leaves the tick pending forever. Every later interval then early-returns
   * and the evaluator is silently dead for the life of the process. That is INC-2026-07 reproduced
   * inside the component built to prevent it.
   *
   * There is no safe automatic recovery: resetting the guard on a timeout would let the abandoned
   * tick overlap the next one, which is the multi-table deadlock the guard exists to prevent. So
   * the answer is the one CLAUDE.md gives for a backstop that cannot self-heal — MAKE IT LOUD. A
   * single skip is ordinary (a slow tick on a large deployment); a run of them is a wedge, and the
   * two must not look alike in the log. One `warn` per skip would have been indistinguishable
   * noise.
   */
  let consecutiveSkips = 0;

  const runTick = async (): Promise<void> => {
    try {
      const result = await runEvaluatorTick({
        db: app.db,
        deliverer: app.alertDeliverer,
        now: new Date(),
        onError: (err) => app.log.error(err),
        // THE SAME MAP AND THE SAME THRESHOLD `routes/monitor.ts` uses, so the tick and the route
        // share ONE throttle per key rather than each keeping its own idea of when the last
        // reconcile happened. Stamped BEFORE the caller awaits anything, exactly as the route
        // does it, so two overlapping evaluations cannot both observe a stale `last`.
        //
        // M16 16.7: the key is opaque here. `alert-set.ts` owns both spellings —
        // `reconcileThrottleKey(orgId, userId)` for an org and the `DEPLOYMENT_THROTTLE_KEY`
        // sentinel for the once-per-tick deployment pass — so this closure stays a pure throttle.
        shouldReconcile: (key, now) => {
          const last = app.reconcileLastRunAt.get(key) ?? 0;
          const due = now.getTime() - last >= app.reconcileThrottleMs;
          if (due) app.reconcileLastRunAt.set(key, now.getTime());
          return due;
        },
      });
      // AT `info` WHEN ANYTHING HAPPENED, and that is not a logging preference. `server.ts`
      // defaults `LOG_LEVEL` to `info`, so a `debug`-only line means production has NO evidence the
      // evaluator ever ran — leaving "healthy, nothing to report" and "has not ticked since boot"
      // indistinguishable, which is the precise ambiguity INC-2026-07 was made of. A component
      // whose thesis is `derivable ≠ detected` must not be silent about its own liveness.
      // Quiet ticks stay at `debug` so a healthy archive does not write a line every minute.
      const line = "alert evaluator tick";
      if (result.alerts > 0 || result.failed > 0) {
        app.log.info({ ...result, intervalMs }, line);
      } else {
        app.log.debug({ ...result, intervalMs }, line);
      }
    } catch (err) {
      // SWALLOW. An unhandled rejection inside a `setInterval` callback takes the PROCESS down,
      // and this is the one component whose entire job is to survive in order to report other
      // components' failures — a crash here reproduces INC-2026-07's silence with extra steps.
      // Same reasoning as the collector heartbeat's swallow. `runEvaluatorTick` already isolates
      // per-org failures; this catch only covers the loop's own scaffolding (e.g. the
      // `listOrganizations` read), which is exactly the part that has no other handler.
      app.log.error(err, "alert evaluator tick failed");
    }
  };

  /**
   * Start a tick unless one is already running or the app is closing.
   *
   * The re-entrancy guard is `inFlight !== null`. It cannot get stuck: `runTick` swallows every
   * error internally, so the promise always settles, and the `finally` below always clears the
   * slot. That matters more here than almost anywhere else in the codebase — a guard wedged `true`
   * would silently disable the evaluator for the life of the process, i.e. reproduce INC-2026-07
   * exactly, in the component built to prevent it.
   */
  const tick = (): void => {
    if (closed) return;
    if (inFlight) {
      consecutiveSkips += 1;
      if (consecutiveSkips >= WEDGED_AFTER_SKIPS) {
        app.log.error(
          { consecutiveSkips, intervalMs },
          "alert evaluator: a tick has not completed for many intervals — alerts are NOT being " +
            "evaluated or delivered. Suspect a stuck query or an unbounded deliverer.",
        );
      } else {
        app.log.warn("alert evaluator: previous tick still running — skipping this interval");
      }
      return;
    }
    consecutiveSkips = 0;
    const running = runTick().finally(() => {
      inFlight = null;
    });
    inFlight = running;
  };

  const timer = setInterval(tick, intervalMs);
  // Never hold the process open on our own. A pending evaluator timer is not a reason for the
  // archive to stay alive; `app.listen`'s server handle is.
  timer.unref();
  // FIRE ONCE IMMEDIATELY, then schedule — the same order the SSE route uses (it pushes a first
  // frame before arming its interval). `setInterval` alone leaves a full-interval blind window
  // after every restart, and the sharp case is not the ordinary 60 s delay: a process that
  // crash-loops faster than the interval would NEVER complete a tick, and "the archive keeps
  // restarting" is exactly when alerting matters most. Not awaited (this must stay synchronous so
  // the `onClose` hook below is armed with no `await` before it); `tick` returns void and swallows
  // its own errors, so there is nothing to float.
  tick();

  // ARMED IMMEDIATELY AFTER THE TIMER AND BEFORE ANY `await` (CLAUDE.md's long-lived-resource
  // rule). There is deliberately no `await` between `setInterval` and this line: a close during an
  // initial await would fire before the hook existed, leaking the timer and hanging vitest — the
  // exact class `/lril:code-review` caught in M9. Note this plugin body has no awaits at all,
  // which is the cheapest possible way to satisfy the rule.
  //
  // IT ALSO AWAITS THE IN-FLIGHT TICK, and that half is not decoration. `clearInterval` stops
  // FUTURE ticks; it does nothing about the one that started 1 ms ago and is now four `await`s deep
  // in a transaction. Without this await that tick outlives `app.close()` and keeps issuing queries
  // against a handle the caller believes is finished — in a test, against a pool that `afterAll` is
  // about to `end()`, which surfaces as `Cannot use a pool after calling end` attributed to
  // whatever file happens to run next. A closed resource that is still working is the same leak
  // shape as a timer that was never cleared, just harder to see.
  app.addHook("onClose", async () => {
    closed = true;
    clearInterval(timer);
    await inFlight;
  });
});
