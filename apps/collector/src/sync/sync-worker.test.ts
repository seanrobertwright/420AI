import { describe, it, expect, afterEach, vi } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { QueueStore } from "../queue/queue-store.js";
import { IngestHttpError } from "../ingest-client.js";
import { syncOnce, runSyncLoop } from "./sync-worker.js";
import type { HeartbeatRequest, IngestBatch } from "@420ai/shared";

let dir: string | undefined;
let server: Server | undefined;

function tmpQueue(now?: () => Date): QueueStore {
  dir = mkdtempSync(join(tmpdir(), "m3-sync-"));
  return new QueueStore(join(dir, "queue.sqlite"), now);
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
  }
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    dir = undefined;
  }
});

describe("syncOnce (injected post)", () => {
  it("no-ops on an empty queue (no post call)", async () => {
    const queue = tmpQueue();
    const post = vi.fn();
    try {
      const outcome = await syncOnce({ queue, url: "http://x", token: "t", post });
      expect(outcome).toBe("ok");
      expect(post).not.toHaveBeenCalled();
    } finally {
      queue.close();
    }
  });

  it("groups raw+events into one batch, posts, and acks on success", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockResolvedValue({ recordsInserted: 1, eventsUpserted: 1 });
    try {
      queue.enqueue("raw", "claude-code:r1", { sourceRecordId: "r1" });
      queue.enqueue("event", "fp1", { fingerprint: "fp1" });

      const outcome = await syncOnce({ queue, url: "http://x", token: "tok", post });
      expect(outcome).toBe("ok");
      expect(post).toHaveBeenCalledTimes(1);
      const [, token, batch] = post.mock.calls[0]!;
      expect(token).toBe("tok");
      expect((batch as IngestBatch).records).toHaveLength(1);
      expect((batch as IngestBatch).events).toHaveLength(1);
      expect(queue.stats()).toEqual({ pending: 0, inflight: 0 }); // acked (deleted)
    } finally {
      queue.close();
    }
  });

  it("returns retry and backs off the item on a 503", async () => {
    let nowMs = Date.parse("2026-06-13T00:00:00.000Z");
    const queue = tmpQueue(() => new Date(nowMs));
    const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const outcome = await syncOnce({ queue, url: "http://x", token: "t", post });
      expect(outcome).toBe("retry");
      // Item is pending but backed off (not immediately claimable).
      expect(queue.stats().pending).toBe(1);
      expect(queue.claimBatch(10)).toHaveLength(0);
      // After the backoff window it is claimable again with attempts bumped.
      nowMs += 1001;
      const reclaimed = queue.claimBatch(10);
      expect(reclaimed[0]!.attempts).toBe(1);
    } finally {
      queue.close();
    }
  });

  it("returns stop and leaves the item pending on a 401 (no drop)", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(401, "revoked"));
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const outcome = await syncOnce({ queue, url: "http://x", token: "t", post });
      expect(outcome).toBe("stop");
      // Still pending, immediately claimable (no backoff bump) — ready for re-pair.
      expect(queue.stats().pending).toBe(1);
      expect(queue.claimBatch(10)).toHaveLength(1);
    } finally {
      queue.close();
    }
  });
});

describe("runSyncLoop (M12 12.6 consecutive-sync-failure counter → heartbeat)", () => {
  it("reports an increasing count across retries, then resets to 0 on a successful drain", async () => {
    // A queue clock we advance each heartbeat so a backed-off item is re-claimable next loop.
    let nowMs = Date.parse("2026-06-13T00:00:00.000Z");
    const queue = tmpQueue(() => new Date(nowMs));
    // ingest post: fail (retry) twice, then succeed (ok) → drives count 0→1→2 then reset to 0.
    let failuresRemaining = 2;
    const post = vi.fn(async () => {
      if (failuresRemaining-- > 0) throw new IngestHttpError(503, "down");
      return { recordsInserted: 0, eventsUpserted: 0 };
    });
    // Capture the consecutiveSyncFailures each heartbeat reports; advance the clock + abort after 4.
    const reported: Array<number | undefined> = [];
    const controller = new AbortController();
    const postHeartbeat = vi.fn(async (_url: string, _token: string, body: HeartbeatRequest) => {
      reported.push(body.consecutiveSyncFailures);
      nowMs += 60_000; // past any backoff so the item is claimable on the upcoming drain
      if (reported.length >= 4) controller.abort();
      return { ok: true } as const;
    });
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const reason = await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          postHeartbeat,
          collectorVersion: "1.2.3",
          heartbeatIntervalMs: 0, // never throttle — one heartbeat per loop iteration
          idleMs: 1,
          retryMs: 1,
          now: () => new Date(nowMs),
        },
        controller.signal,
      );
      expect(reason).toBe("aborted");
      // HB(before any sync)=0, after 1st retry=1, after 2nd retry=2, after the ok-drain reset=0.
      expect(reported.slice(0, 4)).toEqual([0, 1, 2, 0]);
    } finally {
      queue.close();
    }
  });
});

describe("syncOnce (real node:http round-trip)", () => {
  it("POSTs a bearer-authed IngestBatch over real fetch and acks on 2xx", async () => {
    let captured: { auth?: string; body?: IngestBatch } = {};
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        captured = {
          auth: req.headers.authorization,
          body: JSON.parse(raw) as IngestBatch,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ recordsInserted: 1, eventsUpserted: 1 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server!.address() as AddressInfo;

    const queue = tmpQueue();
    try {
      queue.enqueue("raw", "claude-code:r1", {
        sourceConnector: "claude-code",
        sessionId: "s1",
        sourceRecordId: "r1",
        payload: "{}",
      });
      const outcome = await syncOnce({
        queue,
        url: `http://127.0.0.1:${port}`,
        token: "tok-xyz",
      });
      expect(outcome).toBe("ok");
      expect(captured.auth).toBe("Bearer tok-xyz");
      expect(captured.body!.records).toHaveLength(1);
      expect(queue.stats()).toEqual({ pending: 0, inflight: 0 });
    } finally {
      queue.close();
    }
  });
});
