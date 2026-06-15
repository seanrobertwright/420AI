import { describe, it, expect } from "vitest";
import {
  deriveMachineStatus,
  isBacklogHigh,
  MONITOR_THRESHOLDS,
  MONITOR_VERSION,
} from "./monitor.js";

// A fixed reference clock so every case is deterministic (no real `new Date()`).
const NOW = Date.parse("2026-06-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("deriveMachineStatus", () => {
  it("fresh heartbeat -> online", () => {
    expect(deriveMachineStatus({ lastHeartbeatAt: ago(10_000), lastSeenAt: null }, NOW)).toBe(
      "online",
    );
  });

  it("heartbeat exactly at the stale boundary is still online (strict >)", () => {
    expect(
      deriveMachineStatus({ lastHeartbeatAt: ago(MONITOR_THRESHOLDS.staleMs), lastSeenAt: null }, NOW),
    ).toBe("online");
  });

  it("heartbeat past stale but within offline -> stale", () => {
    expect(
      deriveMachineStatus(
        { lastHeartbeatAt: ago(MONITOR_THRESHOLDS.staleMs + 1), lastSeenAt: null },
        NOW,
      ),
    ).toBe("stale");
  });

  it("heartbeat exactly at the offline boundary is still stale (strict >)", () => {
    expect(
      deriveMachineStatus(
        { lastHeartbeatAt: ago(MONITOR_THRESHOLDS.offlineMs), lastSeenAt: null },
        NOW,
      ),
    ).toBe("stale");
  });

  it("heartbeat past offline -> offline", () => {
    expect(
      deriveMachineStatus(
        { lastHeartbeatAt: ago(MONITOR_THRESHOLDS.offlineMs + 1), lastSeenAt: null },
        NOW,
      ),
    ).toBe("offline");
  });

  it("no heartbeat -> falls back to lastSeenAt (D5)", () => {
    // A pre-M9 machine that has never sent a heartbeat but was just seen.
    expect(deriveMachineStatus({ lastHeartbeatAt: null, lastSeenAt: ago(5_000) }, NOW)).toBe(
      "online",
    );
    expect(
      deriveMachineStatus({ lastHeartbeatAt: null, lastSeenAt: ago(MONITOR_THRESHOLDS.offlineMs + 1) }, NOW),
    ).toBe("offline");
  });

  it("heartbeat takes precedence over lastSeenAt when both present (D5)", () => {
    // lastSeenAt is fresh (idle requests keep touching it) but the real heartbeat is old.
    expect(
      deriveMachineStatus(
        { lastHeartbeatAt: ago(MONITOR_THRESHOLDS.offlineMs + 1), lastSeenAt: ago(1_000) },
        NOW,
      ),
    ).toBe("offline");
  });

  it("neither timestamp -> offline (never crashes on nulls)", () => {
    expect(deriveMachineStatus({ lastHeartbeatAt: null, lastSeenAt: null }, NOW)).toBe("offline");
  });

  it("unparseable timestamp -> offline (fail safe, never falsely online)", () => {
    expect(deriveMachineStatus({ lastHeartbeatAt: "not-a-date", lastSeenAt: null }, NOW)).toBe(
      "offline",
    );
  });

  it("is deterministic under an injected clock (different now -> different verdict)", () => {
    const hb = { lastHeartbeatAt: ago(10_000), lastSeenAt: null };
    expect(deriveMachineStatus(hb, NOW)).toBe("online");
    // 6 minutes later, the same heartbeat is offline — proves the clock is injected.
    expect(deriveMachineStatus(hb, NOW + 360_000)).toBe("offline");
  });
});

describe("isBacklogHigh", () => {
  it("at the threshold is NOT high (strict >)", () => {
    expect(isBacklogHigh(MONITOR_THRESHOLDS.backlogHigh)).toBe(false);
  });

  it("above the threshold is high", () => {
    expect(isBacklogHigh(MONITOR_THRESHOLDS.backlogHigh + 1)).toBe(true);
  });

  it("null backlog treated as 0 -> not high", () => {
    expect(isBacklogHigh(null)).toBe(false);
  });

  it("zero -> not high", () => {
    expect(isBacklogHigh(0)).toBe(false);
  });
});

describe("MONITOR_VERSION", () => {
  it("is the stable shape stamp", () => {
    expect(MONITOR_VERSION).toBe("m9-monitor-v1");
  });
});
