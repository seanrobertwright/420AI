import { describe, it, expect } from "vitest";
import { drainBeforeExit, pollLoop } from "./capture-engine.js";
import { QueueStore, type SyncOutcome } from "./queue/queue-store.js";
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
