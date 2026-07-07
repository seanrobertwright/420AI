import { describe, it, expect } from "vitest";
import { drainBeforeExit } from "./capture-engine.js";
import type { SyncOutcome } from "./queue/queue-store.js";

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
