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

  it("releases the claim (no attempt bump) when the POST is aborted on shutdown (C.8)", async () => {
    const queue = tmpQueue();
    // A SIGINT/timeout-cancelled fetch throws AbortError/TimeoutError — not a delivery failure.
    const post = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const outcome = await syncOnce({ queue, url: "http://x", token: "t", post });
      expect(outcome).toBe("retry");
      // Pending, immediately claimable (NO backoff), and attempts NOT bumped — a graceful stop must
      // not penalize the item on the next start (contrast the 503 path, which bumps attempts).
      expect(queue.stats().pending).toBe(1);
      const reclaimed = queue.claimBatch(10);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.attempts).toBe(0);
    } finally {
      queue.close();
    }
  });

  it("forwards the abort signal and timeout to the ingest client (C.8)", async () => {
    const queue = tmpQueue();
    const controller = new AbortController();
    const post = vi.fn().mockResolvedValue({ recordsInserted: 0, eventsUpserted: 1 });
    try {
      queue.enqueue("event", "fp1", { fingerprint: "fp1" });
      await syncOnce({
        queue,
        url: "http://x",
        token: "t",
        post,
        signal: controller.signal,
        timeoutMs: 1234,
      });
      // 4th arg is the RequestOptions — proves SIGINT/timeout can reach fetch (the C.8 hang fix).
      const opts = post.mock.calls[0]![3] as { signal?: AbortSignal; timeoutMs?: number };
      expect(opts.signal).toBe(controller.signal);
      expect(opts.timeoutMs).toBe(1234);
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

describe("runSyncLoop (M13 13.1 — onSync surfaces a live last-sync time)", () => {
  it("calls onSync with the injected clock's ISO time on every successful drain", async () => {
    let nowMs = Date.parse("2026-07-07T00:00:00.000Z");
    const queue = tmpQueue(() => new Date(nowMs));
    const post = vi.fn().mockResolvedValue({ recordsInserted: 0, eventsUpserted: 1 });
    const synced: string[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("event", "fp1", { fingerprint: "fp1" });
      const onSync = (at: string): void => {
        synced.push(at);
        nowMs += 1000;
        if (synced.length >= 2) controller.abort();
      };
      const reason = await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSync,
          idleMs: 1,
          retryMs: 1,
          now: () => new Date(nowMs),
        },
        controller.signal,
      );
      expect(reason).toBe("aborted");
      expect(synced).toEqual(["2026-07-07T00:00:00.000Z", "2026-07-07T00:00:01.000Z"]);
    } finally {
      queue.close();
    }
  });

  it("does not call onSync on a retry outcome (archive unreachable)", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
    const synced: string[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      // A long retryMs means the loop is still asleep in its post-failure delay when the
      // abort fires — so exactly one (failing) syncOnce runs and the item's backoff never
      // has a chance to expire into a spurious empty-queue "ok".
      setTimeout(() => controller.abort(), 50);
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSync: (at) => synced.push(at),
          idleMs: 1,
          retryMs: 10_000,
        },
        controller.signal,
      );
      expect(post).toHaveBeenCalledTimes(1);
      expect(synced).toEqual([]);
    } finally {
      queue.close();
    }
  });

  /**
   * M16 16.6 (F1) — "ok" does not mean "we reached the archive".
   *
   * `syncOnce` returns "ok" immediately on an empty queue WITHOUT posting, and this loop fires
   * `onSync` on every such idle tick. A caller that reads that as proof of contact (clearing the
   * durable fault record) resolves an outage it never re-tested. `delivered` is the discriminator:
   * 0 for the no-op drain, the acked item count for a real one.
   */
  it("reports delivered=0 for an empty (no-POST) drain and the acked count for a real one", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockResolvedValue({ recordsInserted: 0, eventsUpserted: 2 });
    const drains: number[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("event", "fp1", { fingerprint: "fp1" });
      queue.enqueue("event", "fp2", { fingerprint: "fp2" });
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          idleMs: 1,
          retryMs: 1,
          onSync: (_at, delivered) => {
            drains.push(delivered);
            if (drains.length >= 2) controller.abort();
          },
        },
        controller.signal,
      );
      // First drain delivered both queued items; the second found an empty queue and never posted.
      expect(drains).toEqual([2, 0]);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      queue.close();
    }
  });
});

describe("runSyncLoop (C.8 — SIGINT cancels an in-flight stalled sync)", () => {
  it("returns 'aborted' promptly when the archive stalls and the signal aborts", async () => {
    // A server that ACCEPTS the connection but NEVER responds — the exact half-open stall that, with
    // an unbounded fetch, hung `collector watch` on Ctrl-C (the engine awaited the in-flight POST
    // forever). With the abort signal threaded into fetch, aborting unwinds the loop at once.
    server = createServer(() => {
      /* intentionally never responds */
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server!.address() as AddressInfo;

    const queue = tmpQueue();
    const controller = new AbortController();
    try {
      queue.enqueue("event", "fp1", { fingerprint: "fp1" });
      // Abort once the (hanging) POST is in flight; without the fix this test would hang to timeout.
      const timer = setTimeout(() => controller.abort(), 100);
      const reason = await runSyncLoop(
        { queue, url: `http://127.0.0.1:${port}`, token: "t", idleMs: 1, retryMs: 1 },
        controller.signal,
      );
      clearTimeout(timer);
      expect(reason).toBe("aborted");
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

/**
 * M16 16.7 — `onSyncFailure`: the streak the heartbeat could never deliver.
 *
 * `consecutiveSyncFailures` existed since 12.6 but was reported ONLY through the heartbeat — the
 * one channel that by definition cannot arrive when the archive is what is down. A 500 /
 * ECONNREFUSED loop therefore grew the queue without bound, wrote nothing anywhere, and exited 0.
 * This callback is what lets the engine leave a durable local record instead.
 */
describe("runSyncLoop (M16 16.7 — onSyncFailure reports the unreachable-archive streak)", () => {
  it("fires with an INCREASING count on consecutive failures", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
    const counts: number[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: (n) => {
            counts.push(n);
            if (counts.length >= 3) controller.abort();
          },
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      expect(counts).toEqual([1, 2, 3]);
    } finally {
      queue.close();
    }
  });

  // Reaching the second failure crosses the 1 s backoff, hence the raised bound.
  it(
    "RESETS the streak on a drain that DELIVERED — a recovered archive starts from zero",
    { timeout: 15_000 },
    async () => {
      const queue = tmpQueue();
      // Fail twice, then succeed, then fail again. The count after recovery must be 1, not 3: the
      // engine's threshold compares against this number, so a counter that never reset would record
      // a fault for an archive that had been reachable in between.
      let calls = 0;
      const post = vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new IngestHttpError(503, "down"));
        if (calls === 3) return Promise.resolve({ recordsInserted: 1, eventsUpserted: 0 });
        return Promise.reject(new IngestHttpError(503, "down"));
      });
      const counts: number[] = [];
      const controller = new AbortController();
      try {
        queue.enqueue("raw", "r1", { a: 1 });
        await runSyncLoop(
          {
            queue,
            url: "http://x",
            token: "t",
            post,
            onSyncFailure: (n) => {
              counts.push(n);
              if (counts.length >= 3) controller.abort();
            },
            // The successful drain empties the queue, so give the loop something to fail on again —
            // otherwise there is no fourth POST and the streak has nothing to report. Enqueued from
            // the success callback rather than up front so the recovery drain is genuinely the one
            // that clears the backlog.
            onSync: (_at, delivered) => {
              if (delivered > 0) queue.enqueue("raw", "r2", { a: 2 });
            },
            idleMs: 1,
            retryMs: 1,
          },
          controller.signal,
        );
        // 1, 2 before the delivering drain; back to 1 after it.
        expect(counts).toEqual([1, 2, 1]);
      } finally {
        queue.close();
      }
    },
  );

  /**
   * M16 16.7 code-review finding 2 — REACHED AND REFUSED IS NOT UNREACHABLE.
   *
   * `syncOnce` collapses every non-401 failure into "retry", and the queue has NO dead-letter path,
   * so a batch the archive will never accept is retried forever. Once the streak stopped resetting
   * on a no-op drain (the fix directly above), such a batch grew it without bound — and the streak
   * is the only input to `ARCHIVE_UNREACHABLE_MIN_FAILURES` on BOTH surfaces. The result would have
   * been a permanent `archive_unreachable` fault, and a permanent server-side alert, naming the
   * wrong cause for an archive that was answering every request.
   *
   * A clean non-401 4xx is positive proof of reachability, so it resets the streak exactly as a
   * delivered drain does.
   */
  it("a REFUSED batch (clean 4xx) never grows the streak — it is proof the archive is UP", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(400, "malformed payload"));
    const counts: number[] = [];
    const refusals: number[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: (n) => counts.push(n),
          onSyncRefused: (status) => {
            refusals.push(status);
            if (refusals.length >= 3) controller.abort();
          },
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      // Reported every time, as the operator's only signal for an undeliverable batch...
      expect(refusals).toEqual([400, 400, 400]);
      // ...and the unreachable streak never moved. This is the assertion the finding is about.
      expect(counts).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it("a 5xx still counts as unreachable — the archive being DOWN is what the alert means", async () => {
    // The complement of the test above, and the reason the predicate is `4xx` and not `any HTTP
    // status`: a 502/503 is exactly the condition `archive.unreachable` exists to report.
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
    const counts: number[] = [];
    const refusals: number[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: (n) => {
            counts.push(n);
            if (counts.length >= 2) controller.abort();
          },
          onSyncRefused: (status) => refusals.push(status),
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      expect(counts).toEqual([1, 2]);
      expect(refusals).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it("a refusal RESETS an accumulated streak — same evidence standard as a delivered drain", async () => {
    // Fail transport-wise twice, then get a clean 400. The archive answered, so the streak must go
    // back to zero rather than continue climbing toward a false `archive_unreachable`.
    const queue = tmpQueue();
    let calls = 0;
    const post = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new IngestHttpError(503, "down"));
      return Promise.reject(new IngestHttpError(422, "unprocessable"));
    });
    const counts: number[] = [];
    let refused = 0;
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: (n) => counts.push(n),
          onSyncRefused: () => {
            refused += 1;
            if (refused >= 1) controller.abort();
          },
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      expect(counts).toEqual([1, 2]);
      expect(refused).toBe(1);
    } finally {
      queue.close();
    }
  });

  it("a THROWING onSyncRefused does not unwind the loop either (the F-16.3-2 shape)", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(413, "too large"));
    let fired = 0;
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const reason = await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncRefused: () => {
            fired += 1;
            if (fired >= 2) controller.abort();
            throw new Error("logger exploded");
          },
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      expect(reason).toBe("aborted");
      expect(fired).toBe(2);
    } finally {
      queue.close();
    }
  });

  it("a THROWING onSyncFailure does not unwind the loop (the F-16.3-2 shape)", async () => {
    // The callback writes a FILE. An unguarded throw would unwind the sync loop through a rejected
    // promise, turning "the archive is down" into "capture stopped" — in the component whose job is
    // to keep queueing until it comes back.
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
    let fired = 0;
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const reason = await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: () => {
            fired += 1;
            if (fired >= 2) controller.abort();
            throw new Error("disk full");
          },
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      // It survived TWO throws and ended for the ordinary reason.
      expect(reason).toBe("aborted");
      expect(fired).toBe(2);
    } finally {
      queue.close();
    }
  });

  it("is NOT called for a 401 — that is the fatal path, which has onStop", async () => {
    const queue = tmpQueue();
    const post = vi.fn().mockRejectedValue(new IngestHttpError(401, "revoked"));
    const counts: number[] = [];
    const stops: number[] = [];
    const controller = new AbortController();
    try {
      queue.enqueue("raw", "r1", { a: 1 });
      const reason = await runSyncLoop(
        {
          queue,
          url: "http://x",
          token: "t",
          post,
          onSyncFailure: (n) => counts.push(n),
          onStop: () => stops.push(1),
          idleMs: 1,
          retryMs: 1,
        },
        controller.signal,
      );
      expect(reason).toBe("stop");
      expect(stops).toHaveLength(1);
      expect(counts).toEqual([]);
    } finally {
      queue.close();
    }
  });
});

/**
 * M16 16.7 — THE COUNTER MUST BE ABLE TO COUNT.
 *
 * `consecutiveSyncFailures` reset on EVERY `"ok"` outcome, including the empty-queue drain that
 * makes no request at all. Combined with the queue's exponential backoff (a failed item is unclaim-
 * able for 1 s → 2 s → … → 30 s while `retryMs` stays at 1 s), that meant the streak oscillated
 * 1 → 0 → 1 → 0 during a sustained outage and NEVER reached
 * `ARCHIVE_UNREACHABLE_MIN_FAILURES` = 3.
 *
 * So both consumers of the counter were detectors that could not fire: the server-side
 * `archive.unreachable` alert (fed by the heartbeat) and 16.7's own collector fault record. This
 * test drives the real backoff rather than mocking it, because the backoff IS the mechanism that
 * produced the interleaved no-op drains — a test that only failed `syncOnce` back-to-back would
 * have passed against the broken code.
 */
describe("runSyncLoop (M16 16.7 — the failure streak survives no-op drains)", () => {
  // The real backoff is 1 s → 2 s → 4 s, so reaching the threshold takes ~3 s of wall clock. That
  // is deliberately NOT mocked away: the interleaved no-op drains the backoff produces ARE the
  // regression, and a test that failed `syncOnce` back-to-back would pass against the broken code.
  it(
    "keeps counting across the empty drains the backoff interleaves",
    { timeout: 15_000 },
    async () => {
      const queue = tmpQueue();
      const post = vi.fn().mockRejectedValue(new IngestHttpError(503, "down"));
      const counts: number[] = [];
      const oks: number[] = [];
      const controller = new AbortController();
      try {
        queue.enqueue("raw", "r1", { a: 1 });
        await runSyncLoop(
          {
            queue,
            url: "http://x",
            token: "t",
            post,
            onSyncFailure: (n) => {
              counts.push(n);
              // Abort once we REACH the alert threshold — the property that was unreachable before.
              if (n >= 3) controller.abort();
            },
            // `delivered` is 0 on every one of these: the archive is down, so no drain delivers.
            onSync: (_at, delivered) => oks.push(delivered),
            idleMs: 1,
            // Shorter than the very first backoff (1 s), so the loop MUST hit empty claims between
            // real POST attempts. That interleaving is the exact shape that zeroed the counter.
            retryMs: 1,
          },
          controller.signal,
        );
        // Monotonic, and it got past the threshold.
        expect(counts).toEqual([...counts].sort((a, b) => a - b));
        expect(counts.at(-1)).toBeGreaterThanOrEqual(3);
        // Proof the interleaving really happened — these are the no-op "ok" drains that used to
        // reset the streak. If this is empty the test is not exercising the regression.
        expect(oks.length).toBeGreaterThan(0);
        expect(oks.every((d) => d === 0)).toBe(true);
      } finally {
        queue.close();
      }
    },
  );
});
