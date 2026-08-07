import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "@420ai/db";
import alertEvaluatorPlugin from "./alert-evaluator.js";
import { reconcileThrottleKey, DEPLOYMENT_THROTTLE_KEY } from "../alert-set.js";

/**
 * M16 16.6 — the evaluator PLUGIN, unit-tested with no database.
 *
 * The integration suite drives `runEvaluatorTick` directly, which is the right layer for the
 * composition. But it leaves the plugin's own three behaviours — overlap suppression, crash
 * suppression, and teardown — covered only incidentally, and those are the highest-risk parts of
 * the slice: each one, when broken, makes the evaluator stop evaluating SILENTLY. That is the
 * failure this whole slice exists to prevent, so it is pinned here where fake timers make it
 * deterministic and no DB is involved.
 *
 * `runEvaluatorTick` is mocked. That is deliberate: this file is about the timer contract, not
 * about alerts, and mocking is what lets a tick "hang" or "throw" on demand — neither of which can
 * be provoked reliably against a real database.
 */
vi.mock("../alert-evaluator.js", () => ({
  runEvaluatorTick: vi.fn(),
}));
const { runEvaluatorTick } = await import("../alert-evaluator.js");
const tickMock = vi.mocked(runEvaluatorTick);

const OK = { orgs: 1, skipped: 0, alerts: 0, deploymentAlerts: 0, failed: 0 };

/** One captured pino line, reduced to the two things these tests care about. */
interface LogLine {
  level: string;
  msg: string;
}

/**
 * A minimal app carrying only what the plugin reads. No DB, no routes.
 *
 * IT CAPTURES LOGS, and that is not incidental. Two of this slice's review fixes — the
 * `warn`→`error` wedge escalation and the `info`-when-anything-happened decision — ARE log lines:
 * their entire value is being visible to an operator at the default level. Built with
 * `logger: false` (as this file originally was) they are unassertable, so both shipped pinned by
 * nothing and a revert to `debug` stayed green. A component whose thesis is `derivable ≠ detected`
 * must not have its own observability untested.
 *
 * `db` is `{} as unknown as Db` rather than `as never`: `as never` silences the decoration's
 * declared type entirely, and this file IS in the root `tsc -b` graph, so it would trade away real
 * checking. `alertDeliverer` needs no cast at all — `null` satisfies `AlertDeliverer | null`.
 */
async function buildTestApp(intervalMs: number, logs: LogLine[] = []): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: "trace",
      stream: {
        write(s: string) {
          const o = JSON.parse(s) as { level: number; msg: string };
          const names: Record<number, string> = {
            10: "trace",
            20: "debug",
            30: "info",
            40: "warn",
            50: "error",
            60: "fatal",
          };
          logs.push({ level: names[o.level] ?? String(o.level), msg: o.msg ?? "" });
        },
      },
    },
  });
  app.decorate("db", {} as unknown as Db);
  app.decorate("alertDeliverer", null);
  app.decorate("reconcileLastRunAt", new Map<string, number>());
  app.decorate("reconcileThrottleMs", 0);
  app.decorate("alertEvaluatorIntervalMs", intervalMs);
  await app.register(alertEvaluatorPlugin);
  await app.ready();
  return app;
}

describe("M16 16.6 alert-evaluator plugin (timer contract)", () => {
  afterEach(() => {
    vi.useRealTimers();
    tickMock.mockReset();
  });

  it("starts NO timer when the interval is 0", async () => {
    vi.useFakeTimers();
    tickMock.mockResolvedValue(OK);
    const app = await buildTestApp(0);
    // THE ASSERTION THAT CAN ACTUALLY FAIL. An earlier version of this check timed `app.close()`
    // and claimed a leaked timer would make it hang — which is false: Fastify's `close()` neither
    // inspects nor awaits `setInterval` handles, and the plugin `unref()`s its timer anyway, so
    // that test passed no matter what. Advancing the clock and asserting the tick was never
    // invoked tests the actual invariant.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("starts NO timer for a NaN interval (NaN <= 0 is false — setInterval would coerce to 1 ms)", async () => {
    vi.useFakeTimers();
    tickMock.mockResolvedValue(OK);
    const app = await buildTestApp(Number.NaN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("ticks once IMMEDIATELY at boot, before the first interval elapses", async () => {
    vi.useFakeTimers();
    tickMock.mockResolvedValue(OK);
    const app = await buildTestApp(60_000);
    // Without the boot tick this is 0 for a full minute after every restart — and forever for a
    // process that crash-loops faster than the interval.
    expect(tickMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("SKIPS an interval while a tick is still running (no overlap)", async () => {
    vi.useFakeTimers();
    // EVERY pending tick is collected, not just the latest. Releasing only the most recent one
    // leaves an earlier promise hanging, and `onClose` awaits the in-flight tick by design — so
    // the test itself would hang. (It did, on the first run: a 5 s vitest timeout, caused by the
    // fix this file is testing working correctly.)
    const releases: (() => void)[] = [];
    tickMock.mockImplementation(
      () => new Promise((r) => releases.push(() => r(OK))) as ReturnType<typeof runEvaluatorTick>,
    );
    const app = await buildTestApp(100);
    expect(tickMock).toHaveBeenCalledTimes(1); // the boot tick, now hanging

    await vi.advanceTimersByTimeAsync(350); // three more intervals fire…
    expect(tickMock).toHaveBeenCalledTimes(1); // …and every one is skipped

    releases.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(100);
    expect(tickMock).toHaveBeenCalledTimes(2); // the guard released

    releases.forEach((r) => r()); // drain the second tick so close() can complete
    await app.close();
  });

  it("does NOT wedge after a tick that REJECTS — the next interval still runs", async () => {
    // The failure mode that would be catastrophic and invisible: a guard stuck `true` disables the
    // evaluator for the life of the process. `runTick` swallows, and the `finally` clears the slot,
    // so a rejection must cost exactly one tick.
    vi.useFakeTimers();
    tickMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(OK);
    const app = await buildTestApp(100);
    expect(tickMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(tickMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(tickMock).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("a rejecting tick is SWALLOWED and logged, and never rejects close()", async () => {
    // WHAT THIS ASSERTS AND WHY IT CHANGED. The previous version probed
    // `process.on("unhandledRejection")` and asserted it was never called. Review pointed out that
    // this passes for the wrong reason: remove the `try/catch` in `runTick` and the rejection
    // propagates through `.finally()` into `inFlight`, so `onClose`'s `await inFlight` throws and
    // `await app.close()` rejects FIRST — the test goes red, but at a line unrelated to the
    // mechanism its name claimed, and it never established that Node would have emitted
    // `unhandledRejection` under vitest with fake timers at all. That is the "unverified mechanism
    // claim" this slice's review flagged twice elsewhere.
    //
    // So assert the two things that are actually true and actually load-bearing: the error is
    // LOGGED (the operator can see it), and `close()` RESOLVES (a rejecting tick cannot wedge
    // teardown). Both go red without the swallow.
    vi.useFakeTimers();
    const logs: LogLine[] = [];
    tickMock.mockRejectedValue(new Error("boom"));
    const app = await buildTestApp(50, logs);
    await vi.advanceTimersByTimeAsync(200);

    await expect(app.close()).resolves.toBeUndefined();
    const errors = logs.filter((l) => l.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((l) => l.msg.includes("alert evaluator tick failed"))).toBe(true);
  });

  it("ESCALATES to error after WEDGED_AFTER_SKIPS consecutive skips", async () => {
    // The whole fix for the wedge finding is loudness — there is no safe automatic recovery from a
    // tick whose promise never settles (resetting the guard would let the abandoned tick overlap
    // the next, which is the deadlock the guard prevents). So the escalation IS the defence, and it
    // was previously untested: the only skip-producing test advanced 3 intervals against a
    // threshold of 5, and `logger: false` made log assertions impossible. Deleting the branch, or
    // raising the constant to 500, left the suite green.
    vi.useFakeTimers();
    const logs: LogLine[] = [];
    tickMock.mockImplementation(
      () => new Promise(() => {}) as ReturnType<typeof runEvaluatorTick>, // never settles
    );
    await buildTestApp(50, logs);
    expect(tickMock).toHaveBeenCalledTimes(1); // boot tick, now hanging forever

    // One skip is ordinary (a slow tick); it must stay `warn`.
    await vi.advanceTimersByTimeAsync(60);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(0);
    expect(logs.filter((l) => l.level === "warn").length).toBeGreaterThan(0);

    // Five consecutive skips is a wedge, and must be reported as one.
    await vi.advanceTimersByTimeAsync(300);
    const errors = logs.filter((l) => l.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    // The message must name the CONSEQUENCE, not just the symptom — an operator scanning logs has
    // to be able to tell "slow" from "alerts are not being delivered".
    expect(errors[0]!.msg).toMatch(/NOT being evaluated or delivered/);
  });

  it("logs a completed tick at INFO when anything happened, DEBUG when quiet", async () => {
    // `server.ts` defaults LOG_LEVEL to `info`, so a debug-only line means production has no
    // evidence the evaluator ever ran — leaving "healthy, nothing to report" and "has not ticked
    // since boot" indistinguishable, which is the exact ambiguity INC-2026-07 was made of.
    vi.useFakeTimers();
    const quiet: LogLine[] = [];
    tickMock.mockResolvedValue(OK); // 0 alerts, 0 failed
    const a = await buildTestApp(60_000, quiet);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      quiet.filter((l) => l.level === "info" && l.msg.includes("alert evaluator")),
    ).toHaveLength(0);
    await a.close();

    const noisy: LogLine[] = [];
    tickMock.mockResolvedValue({ orgs: 1, skipped: 0, alerts: 2, deploymentAlerts: 0, failed: 0 });
    const b = await buildTestApp(60_000, noisy);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      noisy.filter((l) => l.level === "info" && l.msg.includes("alert evaluator")).length,
    ).toBeGreaterThan(0);
    await b.close();
  });

  it("passes the app's db, deliverer, error sink and SHARED reconcile throttle to the tick", async () => {
    // Pins the wiring at the cheapest layer. Without it, hard-coding `deliverer: null`, handing the
    // tick a fresh `Db`, or dropping the shared `shouldReconcile` would break nothing here — the
    // only proof would live behind the int suite's DOUBLE env gate (`skipIf(!TEST_URL || !APP_URL)`),
    // i.e. exactly the `skipped ≠ passed` window.
    vi.useFakeTimers();
    tickMock.mockResolvedValue(OK);
    const app = await buildTestApp(60_000);
    expect(tickMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db: app.db,
        deliverer: app.alertDeliverer,
        onError: expect.any(Function),
        shouldReconcile: expect.any(Function),
      }),
    );
    // And the throttle really is the APP's map, not a private one — the whole point of sharing it
    // with `routes/monitor.ts` is that a route reconcile and a tick reconcile cannot both fire.
    // M16 16.7: the closure takes an opaque KEY, because there is now a third caller with no org
    // and no user (the deployment pass). `alert-set.ts` owns both spellings.
    const deps = tickMock.mock.calls[0]![0] as { shouldReconcile: (k: string, n: Date) => boolean };
    expect(deps.shouldReconcile(reconcileThrottleKey("org-1", "user-1"), new Date(10_000))).toBe(
      true,
    );
    expect(app.reconcileLastRunAt.get("org-1:user-1")).toBe(10_000);
    // …and the deployment sentinel throttles through the SAME map, which is what stops N connected
    // dashboards and the tick each writing the single shared deployment row.
    expect(deps.shouldReconcile(DEPLOYMENT_THROTTLE_KEY, new Date(20_000))).toBe(true);
    expect(app.reconcileLastRunAt.get(DEPLOYMENT_THROTTLE_KEY)).toBe(20_000);
    await app.close();
  });

  it("stops ticking after close(), and close() awaits a tick already in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let settled = false;
    tickMock.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => {
            settled = true;
            r(OK);
          };
        }) as ReturnType<typeof runEvaluatorTick>,
    );
    const app = await buildTestApp(100);
    expect(tickMock).toHaveBeenCalledTimes(1); // boot tick in flight

    const closing = app.close();
    // `close()` must not resolve while the tick is still running: abandoning it leaves queries
    // executing against a handle the caller believes is finished.
    let closedEarly = false;
    void closing.then(() => (closedEarly = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closedEarly).toBe(false);
    expect(settled).toBe(false);

    release();
    await closing;
    expect(settled).toBe(true);

    // …and no further ticks, ever.
    const after = tickMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(tickMock.mock.calls.length).toBe(after);
  });
});
