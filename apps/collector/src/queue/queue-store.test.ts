import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./queue-store.js";

let dir: string | undefined;

function tmpDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "m3-queue-"));
  return join(dir, "queue.sqlite");
}

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    dir = undefined;
  }
});

describe("QueueStore — dedup semantics (PRE-FLIGHT #2)", () => {
  it("inserts immutable raw once, then no-ops", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      expect(q.enqueue("raw", "claude-code:rec1", { payload: "{}" })).toBe("inserted");
      expect(q.enqueue("raw", "claude-code:rec1", { payload: "{}" })).toBe("noop");
    } finally {
      q.close();
    }
  });

  it("updates and resets-to-pending only when an event's content changed", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      expect(q.enqueue("event", "fp1", { ts: "T1" })).toBe("inserted");
      expect(q.enqueue("event", "fp1", { ts: "T1" })).toBe("noop");
      // content changed (ts advanced) -> update + reset to pending
      expect(q.enqueue("event", "fp1", { ts: "T2" })).toBe("updated");

      // Drain it so we can prove the reset re-queues it.
      const claimed = q.claimBatch(10);
      expect(claimed).toHaveLength(1);
      q.ack(claimed.map((r) => r.id));
      expect(q.stats().pending).toBe(0);

      // A genuine change after ack re-inserts (the row was deleted on ack).
      expect(q.enqueue("event", "fp1", { ts: "T3" })).toBe("inserted");
    } finally {
      q.close();
    }
  });
});

describe("QueueStore — claim / ack", () => {
  it("claims pending items, flips them to inflight, and ack removes them", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      q.enqueue("raw", "r1", { a: 1 });
      q.enqueue("event", "e1", { b: 2 });

      const first = q.claimBatch(10);
      expect(first).toHaveLength(2);
      expect(q.stats()).toEqual({ pending: 0, inflight: 2 });

      // A second claim returns nothing (already inflight).
      expect(q.claimBatch(10)).toHaveLength(0);

      q.ack(first.map((r) => r.id));
      expect(q.stats()).toEqual({ pending: 0, inflight: 0 });
    } finally {
      q.close();
    }
  });

  it("groups raw and event kinds correctly in claimed rows", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      q.enqueue("raw", "r1", { a: 1 });
      q.enqueue("event", "e1", { b: 2 });
      const rows = q.claimBatch(10);
      const kinds = rows.map((r) => r.kind).sort();
      expect(kinds).toEqual(["event", "raw"]);
    } finally {
      q.close();
    }
  });
});

describe("QueueStore — backoff (PRE-FLIGHT #3, injected clock)", () => {
  it("markFailed delays the item past the next claim until its time arrives", () => {
    let nowMs = Date.parse("2026-06-13T00:00:00.000Z");
    const q = new QueueStore(tmpDbPath(), () => new Date(nowMs));
    try {
      q.enqueue("raw", "r1", { a: 1 });
      const [row] = q.claimBatch(10);
      expect(row).toBeDefined();

      // attempts=0 -> backoff = 1000ms; item should not be claimable yet.
      q.markFailed(row!.id, row!.attempts);
      expect(q.claimBatch(10)).toHaveLength(0);

      // Advance past the backoff window -> claimable again, attempts incremented.
      nowMs += 1001;
      const reclaimed = q.claimBatch(10);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.attempts).toBe(1);
    } finally {
      q.close();
    }
  });

  it("caps the backoff at 30s for large attempt counts", () => {
    let nowMs = Date.parse("2026-06-13T00:00:00.000Z");
    const q = new QueueStore(tmpDbPath(), () => new Date(nowMs));
    try {
      q.enqueue("raw", "r1", { a: 1 });
      const [row] = q.claimBatch(10);
      q.markFailed(row!.id, 20); // 1000 * 2^20 is huge -> must clamp to 30s
      // Just before +30s: still backed off.
      nowMs += 29_999;
      expect(q.claimBatch(10)).toHaveLength(0);
      // At +30s (1ms more): claimable -> proves the cap.
      nowMs += 1;
      expect(q.claimBatch(10)).toHaveLength(1);
    } finally {
      q.close();
    }
  });
});

describe("QueueStore — restart recovery (PRE-FLIGHT #3)", () => {
  it("recoverInflight returns crash-orphaned inflight items to pending across reopen", () => {
    const path = tmpDbPath();
    const q1 = new QueueStore(path);
    q1.enqueue("raw", "r1", { a: 1 });
    q1.claimBatch(10); // -> inflight
    expect(q1.stats()).toEqual({ pending: 0, inflight: 1 });
    q1.close(); // simulate crash mid-send (item left inflight, durable)

    const q2 = new QueueStore(path);
    try {
      expect(q2.stats()).toEqual({ pending: 0, inflight: 1 }); // survived the restart
      q2.recoverInflight();
      expect(q2.stats()).toEqual({ pending: 1, inflight: 0 });
    } finally {
      q2.close();
    }
  });

  it("releaseInflight returns items to pending without bumping attempts (401 path)", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      q.enqueue("raw", "r1", { a: 1 });
      const [row] = q.claimBatch(10);
      q.releaseInflight([row!.id]);
      const reclaimed = q.claimBatch(10);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.attempts).toBe(0);
    } finally {
      q.close();
    }
  });
});

describe("QueueStore — file cursors", () => {
  it("persists and updates a per-file cursor in place", () => {
    const q = new QueueStore(tmpDbPath());
    try {
      expect(q.getCursor("claude-code", "/p")).toBeUndefined();
      q.saveCursor("claude-code", "/p", 128, 128);
      expect(q.getCursor("claude-code", "/p")).toEqual({ byteOffset: 128, size: 128 });
      q.saveCursor("claude-code", "/p", 256, 256);
      expect(q.getCursor("claude-code", "/p")).toEqual({ byteOffset: 256, size: 256 });
    } finally {
      q.close();
    }
  });
});
