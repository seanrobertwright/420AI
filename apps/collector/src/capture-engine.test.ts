import { describe, it, expect, afterEach } from "vitest";
import { ARCHIVE_UNREACHABLE_MIN_FAILURES } from "@420ai/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainBeforeExit, pollLoop, runCaptureEngine } from "./capture-engine.js";
import { QueueStore, type SyncOutcome } from "./queue/queue-store.js";
import { IngestHttpError } from "./ingest-client.js";
import type { CaptureFault } from "./fault.js";
import type { Connector } from "./connectors/connector.js";

/**
 * C.8 regression: the shutdown drain must be BOUNDED. Before the fix, `collector watch` on
 * Ctrl-C drained the entire backlog (`while (outcome === "ok" && pending > 0)` with no deadline),
 * so a ~200k-item queue hung exit for minutes and held the SQLite handle open. drainBeforeExit
 * caps the drain by a wall-clock deadline so exit is always prompt; leftovers stay queued.
 */
describe("drainBeforeExit (C.8 — bounded shutdown drain)", () => {
  it("stops at the deadline instead of draining a huge backlog forever", async () => {
    let calls = 0;
    let clock = 1000;
    // Always "ok" and pending never reaches 0 → would loop forever without the deadline bound.
    const sync = async (): Promise<SyncOutcome> => {
      calls += 1;
      clock += 100; // each drain "takes" 100ms of wall-clock
      return "ok";
    };
    await drainBeforeExit(sync, () => 999_999, { deadlineMs: 500, now: () => clock });
    // deadline = 1000 + 500 = 1500; clock advances 100/call → ~5 calls then stops. Bounded, finite.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(20);
  });

  it("bounds each call by the REMAINING budget (hard cap, not ~2× the deadline)", async () => {
    const timeouts: number[] = [];
    let clock = 0;
    const sync = async (timeoutMs: number): Promise<SyncOutcome> => {
      timeouts.push(timeoutMs);
      clock += 100; // each drain call consumes 100ms of wall-clock
      return "ok";
    };
    // pending never hits 0 → only the shrinking budget can stop it.
    await drainBeforeExit(sync, () => 999_999, { deadlineMs: 500, now: () => clock });
    // First call gets the full budget; each later call gets only what's left; the LAST call's
    // timeout is small — so a single call can never overrun the deadline (the ~2× window is closed).
    expect(timeouts[0]).toBe(500);
    expect(timeouts.every((t) => t <= 500)).toBe(true);
    expect(timeouts[timeouts.length - 1]).toBeLessThanOrEqual(100);
  });

  it("stops early once the queue is empty (does not burn the deadline)", async () => {
    let pending = 3;
    const sync = async (): Promise<SyncOutcome> => {
      pending -= 1;
      return "ok";
    };
    await drainBeforeExit(sync, () => pending, { deadlineMs: 60_000, now: () => 0 });
    expect(pending).toBe(0);
  });

  it("stops immediately on a non-ok outcome (archive unreachable)", async () => {
    let calls = 0;
    const sync = async (): Promise<SyncOutcome> => {
      calls += 1;
      return "retry";
    };
    await drainBeforeExit(sync, () => 5, { deadlineMs: 60_000, now: () => 0 });
    expect(calls).toBe(1);
  });

  /**
   * M16 16.6 F2 — the outcome must reach the caller. It used to be swallowed, which is why a 401
   * first seen on the shutdown drain produced no fault record and exit 0.
   */
  it("RETURNS the final outcome, so a drain-only 401 is visible to the engine", async () => {
    await expect(
      drainBeforeExit(
        async () => "stop",
        () => 5,
        { deadlineMs: 60_000, now: () => 0 },
      ),
    ).resolves.toBe("stop");
    await expect(
      drainBeforeExit(
        async () => "ok",
        () => 0,
        { deadlineMs: 60_000, now: () => 0 },
      ),
    ).resolves.toBe("ok");
  });
});

/**
 * M13 13.7: the poll loop drives a POLL-mode connector (Cursor) beside the watcher/sync
 * loops. It must enqueue changed sessions, skip unchanged ones (via the persistent
 * `pollChanged`/`pollCommit` gate on the REAL queue), and stop promptly on abort.
 */
describe("pollLoop (M13 13.7 — poll-mode capture)", () => {
  /** A fake poll connector whose store is a fixed composer whose content never changes after run 1. */
  function fakePollConnector(runs: { n: number }): Connector {
    return {
      id: "fake-poll",
      captureMode: "poll",
      fidelity: {
        status: "experimental",
        captureMethod: "poll-test",
        liveness: "snapshot",
        tokens: "none",
        cost: "none",
        knownGaps: [],
        requiredPermissions: [],
      },
      watchGlobs: () => [],
      parse: () => ({ rawRecords: [], events: [], skippedLines: 0 }),
      poll: {
        intervalMs: 5,
        sources: () => ["/fake/store"],
        run: (_path, ctx) => {
          runs.n += 1;
          // The same composer content on every tick → changes only the FIRST time.
          const changed = ctx.changed("composer:c1", "content-v1");
          if (changed) {
            ctx.enqueue({
              rawRecords: [
                {
                  id: "c1:composer",
                  sourceConnector: "fake-poll",
                  sessionId: "c1",
                  ingestedAt: "2026-07-08T00:00:00.000Z",
                  payload: "{}",
                },
              ],
              events: [],
              skippedLines: 0,
            });
            ctx.commit("composer:c1", "content-v1"); // record only after enqueue
          }
          return { swept: 1, changed: changed ? 1 : 0, rawRecords: changed ? 1 : 0, events: 0 };
        },
      },
    };
  }

  it("enqueues a changed session once, skips it thereafter, and stops on abort", async () => {
    const queue = new QueueStore(":memory:");
    const runs = { n: 0 };
    const ctrl = new AbortController();
    const loop = pollLoop(
      { connector: fakePollConnector(runs), home: "/home", queue, log: () => {} },
      ctrl.signal,
    );
    // Let it tick several times (interval 5ms).
    await new Promise((r) => setTimeout(r, 45));
    ctrl.abort();
    await loop; // resolves promptly on abort — proves teardown

    expect(runs.n).toBeGreaterThan(1); // it looped
    // Only the first tick enqueued (content unchanged after) → exactly one durable item.
    expect(queue.stats().pending).toBe(1);
    queue.close();
  });

  it("returns immediately for a connector without a poll capability", async () => {
    const queue = new QueueStore(":memory:");
    const noPoll: Connector = {
      id: "no-poll",
      fidelity: {
        status: "stable",
        captureMethod: "tail",
        liveness: "batch",
        tokens: "none",
        cost: "none",
        knownGaps: [],
        requiredPermissions: [],
      },
      watchGlobs: () => [],
      parse: () => ({ rawRecords: [], events: [], skippedLines: 0 }),
    };
    // Never-aborting signal: if pollLoop didn't early-return, this would hang.
    await pollLoop(
      { connector: noPoll, home: "/h", queue, log: () => {} },
      new AbortController().signal,
    );
    expect(queue.stats().pending).toBe(0);
    queue.close();
  });
});

/**
 * M16 16.6 — a fatal 401 must leave a REASON behind it.
 *
 * INC-2026-07: `runSyncLoop` returned "stop", the engine unwound *normally*, and every layer above
 * it read that as a clean finish. The engine knew; nothing else did. `onFatal` is the additive
 * callback that carries the fact out — additive precisely because `cli.ts` types its engine seam as
 * `runEngine?: typeof runCaptureEngine`, so a widened return type would break at compile time.
 */
describe("runCaptureEngine onFatal (M16 16.6 — a 401 is no longer silent)", () => {
  /**
   * A token that appears NOWHERE else in the repo, so `not.toContain(SENTINEL_TOKEN)` can only pass
   * because the record genuinely omits the credential — the discriminating form of the assertion.
   */
  const SENTINEL_TOKEN = "tok-SENTINEL-8f3a";
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /**
   * Run the real engine against an injected `post` that always 401s, over a temp home with one
   * queued item (an empty queue never POSTs, so it could never reach the 401 path).
   */
  async function runUntilFatal(onFatal?: (f: CaptureFault) => void): Promise<CaptureFault[]> {
    const home = mkdtempSync(join(tmpdir(), "m16-engine-"));
    homes.push(home);
    const queuePath = join(home, "queue.sqlite");
    const seed = new QueueStore(queuePath);
    seed.enqueue("event", "fp-1", { fingerprint: "fp-1" });
    seed.close();

    const seen: CaptureFault[] = [];
    await runCaptureEngine({
      // A UNIQUE sentinel token (F5). The previous fixture used `token: "revoked"` and asserted the
      // serialized record did not contain `"revoked-token"` — a string no implementation could ever
      // emit, so the only end-to-end "no credential leaks" assertion passed vacuously.
      creds: { url: "https://archive.example", token: SENTINEL_TOKEN, machineId: "m1" },
      signal: new AbortController().signal,
      queuePath,
      home,
      connectors: [], // no capture surface — the sync loop is the only thing under test
      gitIntervalMs: 0, // no background git sweep
      intervalMs: 5,
      post: async () => {
        throw new IngestHttpError(401, "unauthorized");
      },
      onFatal: (f) => {
        seen.push(f);
        onFatal?.(f);
      },
    });
    return seen;
  }

  it("invokes onFatal exactly once with a token-free auth_revoked record", async () => {
    const seen = await runUntilFatal();
    expect(seen.length).toBe(1);
    expect(seen[0]!.code).toBe("auth_revoked");
    expect(seen[0]!.url).toBe("https://archive.example");
    expect(seen[0]!.message).toMatch(/401/);
    expect(Date.parse(seen[0]!.since)).not.toBeNaN();
    // The record names the archive, never the credential it rejected.
    expect(JSON.stringify(seen[0])).not.toContain(SENTINEL_TOKEN);
    expect(Object.keys(seen[0]!).sort()).toEqual(["code", "message", "since", "url"]);
  });

  it("a reporter that THROWS does not stop the engine unwinding cleanly (F-16.3-2 shape)", async () => {
    // Without the try/catch in `onStop` this rejects the sync loop instead of taking the "stop"
    // path — the observer becoming the outage it was reporting.
    await expect(
      runUntilFatal(() => {
        throw new Error("fault reporter exploded");
      }),
    ).resolves.toHaveLength(1);
  });
});

/**
 * M16 16.6 F1 — a 401 on the HEARTBEAT is the same evidence as a 401 on ingest.
 *
 * The ONLY path to `onFatal` was an ingest POST 401. But `syncOnce` returns "ok" without making a
 * request when the queue is empty, so on a QUIET machine the sync loop never talks to the archive at
 * all — while the heartbeat makes a real authenticated request every ~30 s regardless. A 401 there
 * landed in `onHeartbeatError` → `log(…)` and went no further: no fault file, no exit code, nothing.
 * That is INC-2026-07's exact shape with a smaller queue.
 *
 * The paired negative is the point of the fix, not decoration: every OTHER heartbeat failure must
 * stay swallowed (residual risk e), or a network blip becomes an outage.
 */
describe("runCaptureEngine heartbeat 401 (M16 16.6 F1)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /** An engine over an EMPTY queue, so the ingest path can never be the one that reports. */
  function engineOpts(
    postHeartbeat: () => Promise<never>,
    signal: AbortSignal,
    seen: CaptureFault[],
    logs: string[],
  ): Parameters<typeof runCaptureEngine>[0] {
    const home = mkdtempSync(join(tmpdir(), "m16-hb-"));
    homes.push(home);
    return {
      creds: { url: "https://archive.example", token: "tok-hb", machineId: "m1" },
      signal,
      queuePath: join(home, "queue.sqlite"),
      home,
      connectors: [],
      gitIntervalMs: 0,
      intervalMs: 5,
      collectorVersion: "9.9.9",
      heartbeatIntervalMs: 1,
      // The queue is empty, so this must never be called; if it ever is, fail loudly rather than
      // let the ingest path quietly become the thing under test.
      post: async () => {
        throw new Error("the ingest path must not be exercised by a heartbeat test");
      },
      postHeartbeat,
      logger: (m) => logs.push(m),
      onFatal: (f) => seen.push(f),
    };
  }

  it("reports a fatal auth_revoked fault and stops capture", async () => {
    const seen: CaptureFault[] = [];
    const logs: string[] = [];
    await runCaptureEngine(
      engineOpts(
        async () => {
          throw new IngestHttpError(401, "unauthorized");
        },
        new AbortController().signal,
        seen,
        logs,
      ),
    );

    // Without the fix this is 0: the engine idles forever and the test times out instead.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("auth_revoked");
    expect(seen[0]!.url).toBe("https://archive.example");
    expect(seen[0]!.message).toMatch(/heartbeat returned 401/);
    expect(JSON.stringify(seen[0])).not.toContain("tok-hb");
  });

  it("keeps swallowing every NON-401 heartbeat failure (a blip must not stop capture)", async () => {
    const seen: CaptureFault[] = [];
    const logs: string[] = [];
    const ctrl = new AbortController();
    let sawCall!: () => void;
    const called = new Promise<void>((r) => (sawCall = r));

    const engine = runCaptureEngine(
      engineOpts(
        async () => {
          sawCall();
          throw new IngestHttpError(503, "service unavailable");
        },
        ctrl.signal,
        seen,
        logs,
      ),
    );
    await called;
    // Let the swallow + log land before stopping the engine ourselves.
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await engine;

    expect(seen).toHaveLength(0); // a 503 is NOT a revoked credential
    expect(logs.join("\n")).toMatch(/heartbeat failed \(capture health not reported\)/);
  });
});

/**
 * M16 16.6 F2 — a 401 first observed during the SHUTDOWN DRAIN.
 *
 * The drain called `syncOnce` directly with no `onStop`/`onFatal` wiring and DISCARDED the outcome
 * (the `while` merely stopped on anything that was not "ok"). Realistic shape, and the one this test
 * reproduces: the operator restarts the machine, so SIGINT cancels the in-flight POST and the sync
 * loop unwinds through its "aborted" branch having reported nothing — then the drain re-POSTs the
 * released items and gets the 401. Before the fix that run wrote no fault record and exited 0, which
 * WinSW reads as a deliberate stop.
 */
describe("runCaptureEngine shutdown-drain 401 (M16 16.6 F2)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("reports the fault the drain observed, instead of exiting silently", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-drain-"));
    homes.push(home);
    const queuePath = join(home, "queue.sqlite");
    const seed = new QueueStore(queuePath);
    seed.enqueue("event", "fp-drain", { fingerprint: "fp-drain" });
    seed.close();

    const ctrl = new AbortController();
    const seen: CaptureFault[] = [];
    await runCaptureEngine({
      creds: { url: "https://archive.example", token: "tok-drain", machineId: "m1" },
      signal: ctrl.signal,
      queuePath,
      home,
      connectors: [],
      gitIntervalMs: 0,
      intervalMs: 5,
      post: async (_url, _token, _batch, o) => {
        if (o?.signal) {
          // The SYNC LOOP's call — it always threads the loop's abort signal. Simulate Ctrl-C
          // cancelling the in-flight POST: `syncOnce` releases the claim with no backoff and
          // returns "retry", and the loop breaks on `signal.aborted` WITHOUT ever seeing a 401.
          ctrl.abort();
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        // The SHUTDOWN DRAIN's call (bounded by a timeout, no external signal) — the token was
        // revoked while the machine was being restarted.
        throw new IngestHttpError(401, "unauthorized");
      },
      onFatal: (f) => seen.push(f),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("auth_revoked");
    expect(seen[0]!.message).toMatch(/draining the queue on shutdown/);
    expect(JSON.stringify(seen[0])).not.toContain("tok-drain");
  });
});

/**
 * M16 16.6 (F-D) — a SHUTDOWN DRAIN that delivers must resolve a stale fault, like any other
 * delivery.
 *
 * The drain called `syncOnce` without `onDelivered`, so its acks never reached `onSyncSuccess` —
 * the only path `cli.ts` / `serve.ts` clear `fault.json` from. Realistic run: a fault is on disk
 * from a previous run, the operator re-pairs, and the run is short enough (a `Stop-Service`, or a
 * desktop pause landing inside the ~2 s idle cadence) that the ONLY successful delivery happens in
 * the 5 s drain. The record then survives a run that demonstrably re-reached the archive and reads
 * as a live outage — `service/README.md` tells the operator a file that is still there is a fault
 * that is still happening.
 *
 * Same fixture shape as F2 above: the sync loop's POST is cancelled by SIGINT (so the loop unwinds
 * through "aborted" having delivered NOTHING and fired no `onSync`), which makes the drain the only
 * possible source of any `onSyncSuccess` call in this test.
 */
describe("runCaptureEngine shutdown-drain delivery (M16 16.6 F-D)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /** Seed `items` queued events under a fresh temp home and return its queue path. */
  function seedQueue(items: number): { home: string; queuePath: string } {
    const home = mkdtempSync(join(tmpdir(), "m16-drain-deliver-"));
    homes.push(home);
    const queuePath = join(home, "queue.sqlite");
    const seed = new QueueStore(queuePath);
    for (let i = 0; i < items; i += 1)
      seed.enqueue("event", `fp-d-${i}`, { fingerprint: `fp-d-${i}` });
    seed.close();
    return { home, queuePath };
  }

  it("reports what the drain DELIVERED through onSyncSuccess, so a stale fault self-resolves", async () => {
    const { home, queuePath } = seedQueue(3);
    const ctrl = new AbortController();
    const syncs: { at: string; delivered: number }[] = [];

    await runCaptureEngine({
      creds: { url: "https://archive.example", token: "tok-dd", machineId: "m1" },
      signal: ctrl.signal,
      queuePath,
      home,
      connectors: [],
      gitIntervalMs: 0,
      intervalMs: 5,
      post: async (_url, _token, batch, o) => {
        if (o?.signal) {
          // The SYNC LOOP's call — Ctrl-C cancels it. `syncOnce` releases the claim with no
          // backoff and returns "retry"; the loop breaks on `signal.aborted` and fires no `onSync`.
          ctrl.abort();
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        // The SHUTDOWN DRAIN's call — the archive is reachable again and accepts the backlog.
        return { recordsInserted: batch.records.length, eventsUpserted: batch.events.length };
      },
      onSyncSuccess: (at, delivered) => syncs.push({ at, delivered }),
    });

    // Exactly one report, carrying a POSITIVE count — the predicate `cli.ts`/`serve.ts` gate the
    // `clearFault` on. Without the fix this array is EMPTY and the fault file survives forever.
    expect(syncs).toHaveLength(1);
    expect(syncs[0]!.delivered).toBe(3);
    expect(Date.parse(syncs[0]!.at)).not.toBeNaN();
  });

  /**
   * The negative half, preserved deliberately: an EMPTY drain makes no request at all, so it proves
   * nothing about the archive and must NOT reach the callers' `delivered > 0` clear. Threading the
   * count out of the drain would be worthless if it also invented a delivery here.
   */
  it("an EMPTY drain reports nothing at all (it contacted no archive)", async () => {
    const { home, queuePath } = seedQueue(0);
    const ctrl = new AbortController();
    const syncs: { at: string; delivered: number }[] = [];

    const engine = runCaptureEngine({
      creds: { url: "https://archive.example", token: "tok-dd", machineId: "m1" },
      signal: ctrl.signal,
      queuePath,
      home,
      connectors: [],
      gitIntervalMs: 0,
      intervalMs: 5,
      post: async () => {
        throw new Error("an empty queue must never POST");
      },
      onSyncSuccess: (at, delivered) => syncs.push({ at, delivered }),
    });
    // Let the loop take one idle turn, then stop it: the sync loop's own empty-drain `onSync`
    // carries delivered=0, and the shutdown drain must add nothing.
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    await engine;

    expect(syncs.every((s) => s.delivered === 0)).toBe(true);
  });
});

/**
 * M16 16.7 — the DEGRADED reporter: an unreachable archive is no longer silent, and no longer
 * fatal either.
 *
 * `consecutiveSyncFailures` was reported ONLY through the heartbeat — the one channel that by
 * definition cannot arrive when the archive is what is down. So a 500/ECONNREFUSED loop grew the
 * queue without bound, wrote no record, exited 0 and left WinSW seeing a healthy service:
 * INC-2026-07's observable symptom reached by a different cause.
 *
 * The four properties under test are the ones that make it DEGRADED rather than FATAL (D-16.7-8):
 * it fires at the threshold, it re-stamps sparsely rather than on every failed drain, it never
 * aborts the engine, and it does not consume the fatal path's `reported` guard.
 */
describe("runCaptureEngine onDegraded (M16 16.7 — an unreachable archive)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /** A temp home seeded with one queued item — an empty queue never POSTs, so never fails. */
  function seededHome(tag: string): string {
    const home = mkdtempSync(join(tmpdir(), tag));
    homes.push(home);
    const seed = new QueueStore(join(home, "queue.sqlite"));
    seed.enqueue("event", "fp-1", { fingerprint: "fp-1" });
    seed.close();
    return home;
  }

  /**
   * Drive the real engine against an archive that always 503s, stopping once `stopAfter` degraded
   * reports have arrived, or on the wall-clock bound. Returns what was reported and how many POST
   * attempts actually happened.
   */
  async function runUntilDegraded(
    stopAfter: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ seen: CaptureFault[]; failures: number }> {
    const home = seededHome("m16-degraded-");
    const controller = new AbortController();
    const seen: CaptureFault[] = [];
    let failures = 0;
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
    try {
      await runCaptureEngine({
        creds: { url: "https://archive.example", token: "tok-degraded", machineId: "m1" },
        signal: controller.signal,
        queuePath: join(home, "queue.sqlite"),
        home,
        connectors: [],
        gitIntervalMs: 0,
        intervalMs: 5,
        post: async () => {
          failures += 1;
          throw new IngestHttpError(503, "service unavailable");
        },
        onDegraded: (f) => {
          seen.push(f);
          if (seen.length >= stopAfter) controller.abort();
        },
      });
    } finally {
      clearTimeout(timer);
    }
    return { seen, failures };
  }

  it(
    "fires at the THRESHOLD with a token-free archive_unreachable record",
    { timeout: 20_000 },
    async () => {
      const { seen } = await runUntilDegraded(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.code).toBe("archive_unreachable");
      expect(seen[0]!.url).toBe("https://archive.example");
      // The message must say capture is still running — the operator's decision hangs on it.
      expect(seen[0]!.message).toMatch(/STILL RUNNING/);
      expect(seen[0]!.message).toContain(String(ARCHIVE_UNREACHABLE_MIN_FAILURES));
      expect(Date.parse(seen[0]!.since)).not.toBeNaN();
      expect(JSON.stringify(seen[0])).not.toContain("tok-degraded");
      expect(Object.keys(seen[0]!).sort()).toEqual(["code", "message", "since", "url"]);
    },
  );

  it(
    "keeps the engine RUNNING past the threshold, and re-stamps sparsely",
    { timeout: 40_000 },
    async () => {
      // Stop on the WALL CLOCK rather than on a report count, so the engine's own liveness is what
      // ends the test.
      //
      // THE BOUND IS DICTATED BY THE QUEUE'S BACKOFF, NOT BY TASTE — it was 6 s and went red on CI
      // while passing locally, which is the signature of a bound with no margin rather than a bug.
      // `markFailed` backs an item off `1000 * 2^attempts` ms, so consecutive failed drains land at
      // t ≈ 0, 1 s, 3 s, 7 s, 15 s (the loop's own `retryMs` is irrelevant — in between, the claim
      // finds nothing due and returns "ok"). The two assertions below need the 3rd failure
      // (`ARCHIVE_UNREACHABLE_MIN_FAILURES`, t ≈ 3 s) AND a 4th (`failures > 3`, t ≈ 7 s), so 6 s
      // left under a second of slack for engine boot, sqlite open and watcher start on a cold
      // runner. 20 s clears the 4th failure by 13 s and still ends well inside the test timeout.
      const { seen, failures } = await runUntilDegraded(999, { timeoutMs: 20_000 });
      // It reported, so the threshold was crossed…
      expect(seen.length).toBeGreaterThanOrEqual(1);
      // …and the engine was STILL RUNNING when the external abort arrived, which is the whole
      // distinction from `onFatal`. Had `reportDegraded` called `internal.abort()`, the engine
      // would have unwound at the threshold and `failures` would have stopped climbing there.
      expect(failures).toBeGreaterThan(ARCHIVE_UNREACHABLE_MIN_FAILURES);
      // SPARSE: one report per 60 further failures, not one per failed drain. Without that,
      // `saveFault` (a read-modify-write of a file) runs once a second for the whole outage.
      expect(seen.length).toBeLessThan(failures);
    },
  );

  it("a THROWING degraded reporter does not unwind the engine", { timeout: 20_000 }, async () => {
    const home = seededHome("m16-degraded-throw-");
    const controller = new AbortController();
    let fired = 0;
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      await expect(
        runCaptureEngine({
          creds: { url: "https://archive.example", token: "t", machineId: "m1" },
          signal: controller.signal,
          queuePath: join(home, "queue.sqlite"),
          home,
          connectors: [],
          gitIntervalMs: 0,
          intervalMs: 5,
          post: async () => {
            throw new IngestHttpError(503, "down");
          },
          onDegraded: () => {
            fired += 1;
            controller.abort();
            throw new Error("disk full");
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
    expect(fired).toBe(1);
  });

  it(
    "does NOT consume the fatal `reported` guard — unreachable, then 401, still reports the 401",
    { timeout: 20_000 },
    async () => {
      // THE SUBTLE ONE. If `reportDegraded` set `reported = true`, an archive that is down now and
      // rejects the credential once it comes back would never produce an `auth_revoked` record —
      // the fatal path silently consumed by the non-fatal one.
      const home = seededHome("m16-degraded-then-401-");
      const degraded: CaptureFault[] = [];
      const fatal: CaptureFault[] = [];
      const controller = new AbortController();
      let unauthorized = false;
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        await runCaptureEngine({
          creds: { url: "https://archive.example", token: "t", machineId: "m1" },
          signal: controller.signal,
          queuePath: join(home, "queue.sqlite"),
          home,
          connectors: [],
          gitIntervalMs: 0,
          intervalMs: 5,
          post: async () => {
            // The archive comes back — with a revoked credential.
            if (unauthorized) throw new IngestHttpError(401, "unauthorized");
            throw new IngestHttpError(503, "down");
          },
          onDegraded: (f) => {
            degraded.push(f);
            unauthorized = true; // threshold crossed; now flip the archive to 401
          },
          onFatal: (f) => fatal.push(f),
        });
      } finally {
        clearTimeout(timer);
      }
      expect(degraded.length).toBeGreaterThanOrEqual(1);
      expect(degraded[0]!.code).toBe("archive_unreachable");
      // The fatal path still fired, after the degraded one.
      expect(fatal).toHaveLength(1);
      expect(fatal[0]!.code).toBe("auth_revoked");
    },
  );
});
