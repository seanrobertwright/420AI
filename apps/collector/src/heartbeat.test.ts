import { describe, it, expect, vi } from "vitest";
import { maybeSendHeartbeat, newHeartbeatState, type HeartbeatDeps } from "./heartbeat.js";
import type { QueueStore } from "./queue/queue-store.js";

const INTERVAL = 30_000;
const T0 = Date.parse("2026-06-14T12:00:00.000Z");

/** A minimal QueueStore stub — maybeSendHeartbeat only ever calls `stats()`. */
function stubQueue(pending: number, inflight: number): QueueStore {
  return { stats: () => ({ pending, inflight }) } as unknown as QueueStore;
}

/** Build deps with an injected, mutable clock + a stub post. */
function makeDeps(opts: {
  nowRef: { ms: number };
  post: HeartbeatDeps["post"];
  pending?: number;
  inflight?: number;
}): HeartbeatDeps {
  return {
    url: "http://ingest",
    token: "machine-token",
    queue: stubQueue(opts.pending ?? 0, opts.inflight ?? 0),
    collectorVersion: "1.2.3",
    intervalMs: INTERVAL,
    now: () => new Date(opts.nowRef.ms),
    post: opts.post,
  };
}

describe("maybeSendHeartbeat", () => {
  it("sends on the first call (never sent) then throttles within the interval", async () => {
    const nowRef = { ms: T0 };
    const post = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps({ nowRef, post });
    const state = newHeartbeatState();

    await maybeSendHeartbeat(deps, state); // first call always sends
    expect(post).toHaveBeenCalledTimes(1);

    nowRef.ms = T0 + INTERVAL - 1; // still inside the cadence window
    await maybeSendHeartbeat(deps, state);
    expect(post).toHaveBeenCalledTimes(1); // throttled — no second send

    nowRef.ms = T0 + INTERVAL; // exactly at the cadence → sends again
    await maybeSendHeartbeat(deps, state);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("carries the queue backlog + collector version in the body", async () => {
    const nowRef = { ms: T0 };
    const post = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps({ nowRef, post, pending: 12, inflight: 3 });

    await maybeSendHeartbeat(deps, newHeartbeatState());

    expect(post).toHaveBeenCalledWith("http://ingest", "machine-token", {
      queuePending: 12,
      queueInflight: 3,
      collectorVersion: "1.2.3",
      consecutiveSyncFailures: 0, // M12 12.6 — defaults to 0 when the loop doesn't track it
    });
  });

  it("carries the consecutiveSyncFailures count when set (M12 12.6 archive.unreachable signal)", async () => {
    const nowRef = { ms: T0 };
    const post = vi.fn().mockResolvedValue({ ok: true });
    const deps = {
      ...makeDeps({ nowRef, post, pending: 1, inflight: 0 }),
      consecutiveSyncFailures: 4,
    };

    await maybeSendHeartbeat(deps, newHeartbeatState());

    expect(post).toHaveBeenCalledWith("http://ingest", "machine-token", {
      queuePending: 1,
      queueInflight: 0,
      collectorVersion: "1.2.3",
      consecutiveSyncFailures: 4,
    });
  });

  it("swallows a post failure (best-effort) and still sends on the next interval", async () => {
    const nowRef = { ms: T0 };
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("ingest unreachable"))
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps({ nowRef, post });
    const state = newHeartbeatState();

    // First send rejects — must NOT throw out of maybeSendHeartbeat.
    await expect(maybeSendHeartbeat(deps, state)).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);

    // A prior failure does not block the next scheduled send.
    nowRef.ms = T0 + INTERVAL;
    await maybeSendHeartbeat(deps, state);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
