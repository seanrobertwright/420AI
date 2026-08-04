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

describe("maybeSendHeartbeat — the M16 16.3 connector inventory", () => {
  const report = {
    id: "claude-code",
    enabled: true,
    approval: "approved" as const,
    status: "stable" as const,
    captureMethod: "jsonl tail",
    liveness: "streaming" as const,
    tokens: "exact" as const,
    cost: "computed" as const,
    knownGaps: [],
    requiredPermissions: [],
    custom: false,
    lastErrorMessage: null,
    lastErrorAt: null,
    errorCount: 0,
  };

  it("omits `connectors` ENTIRELY when no thunk is wired", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await maybeSendHeartbeat(makeDeps({ nowRef: { ms: T0 }, post }), newHeartbeatState());
    const body = post.mock.calls[0]![2] as Record<string, unknown>;
    // `undefined` and `[]` are different facts to the server (D-16.3-2) — the KEY must be absent,
    // not present-and-undefined, since `JSON.stringify` would drop it either way but a future
    // structured client would not.
    expect("connectors" in body).toBe(false);
  });

  it("includes the inventory when the thunk is wired", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const deps: HeartbeatDeps = {
      ...makeDeps({ nowRef: { ms: T0 }, post }),
      connectorReports: () => [report],
    };
    await maybeSendHeartbeat(deps, newHeartbeatState());
    expect((post.mock.calls[0]![2] as { connectors: unknown[] }).connectors).toEqual([report]);
  });

  it("sends an EMPTY array as an empty array — it means 'prune', not 'nothing to say'", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const deps: HeartbeatDeps = {
      ...makeDeps({ nowRef: { ms: T0 }, post }),
      connectorReports: () => [],
    };
    await maybeSendHeartbeat(deps, newHeartbeatState());
    const body = post.mock.calls[0]![2] as Record<string, unknown>;
    expect("connectors" in body).toBe(true);
    expect(body.connectors).toEqual([]);
  });

  it("reads the thunk at SEND time, not at construction time", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    let errorCount = 0;
    const nowRef = { ms: T0 };
    const deps: HeartbeatDeps = {
      ...makeDeps({ nowRef, post }),
      connectorReports: () => [{ ...report, errorCount }],
    };
    const state = newHeartbeatState();

    await maybeSendHeartbeat(deps, state);
    errorCount = 5; // capture fails between heartbeats
    nowRef.ms = T0 + INTERVAL;
    await maybeSendHeartbeat(deps, state);

    expect(
      (post.mock.calls[0]![2] as { connectors: [{ errorCount: number }] }).connectors[0]!
        .errorCount,
    ).toBe(0);
    expect(
      (post.mock.calls[1]![2] as { connectors: [{ errorCount: number }] }).connectors[0]!
        .errorCount,
    ).toBe(5);
  });

  it("calls onError on a rejection and STILL does not throw (D-16.3-6)", async () => {
    const post = vi.fn().mockRejectedValue(new Error("400 Bad Request"));
    const onError = vi.fn();
    const deps: HeartbeatDeps = { ...makeDeps({ nowRef: { ms: T0 }, post }), onError };

    await expect(maybeSendHeartbeat(deps, newHeartbeatState())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain("400 Bad Request");
  });

  it("an onError that itself throws does not become the failure it was reporting", async () => {
    const post = vi.fn().mockRejectedValue(new Error("boom"));
    const deps: HeartbeatDeps = {
      ...makeDeps({ nowRef: { ms: T0 }, post }),
      onError: () => {
        throw new Error("the observer exploded");
      },
    };
    // The swallow is what keeps the sync loop alive (residual risk e); an observer must not
    // reintroduce the stall it exists to report.
    await expect(maybeSendHeartbeat(deps, newHeartbeatState())).resolves.toBeUndefined();
  });
});
