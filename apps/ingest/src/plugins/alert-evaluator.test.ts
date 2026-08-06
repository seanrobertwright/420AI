import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import alertEvaluatorPlugin from "./alert-evaluator.js";

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

const OK = { orgs: 1, skipped: 0, alerts: 0, failed: 0 };

/** A minimal app carrying only what the plugin reads. No DB, no routes. */
async function buildTestApp(intervalMs: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("db", {} as never);
  app.decorate("alertDeliverer", null as never);
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

  it("a rejecting tick does not escape as an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      tickMock.mockRejectedValue(new Error("boom"));
      const app = await buildTestApp(50);
      await vi.advanceTimersByTimeAsync(200);
      await app.close();
      await vi.advanceTimersByTimeAsync(0);
      // An unhandled rejection inside a `setInterval` callback takes the process down — in the one
      // component whose job is to survive to report other components' failures.
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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
