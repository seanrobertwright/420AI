import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./queue/queue-store.js";
import { IngestHttpError } from "./ingest-client.js";
import { runSync } from "./cli.js";

/**
 * C.11 regression: `runSync` must report whether the queue was ACTUALLY delivered. Before the fix
 * it returned only stats and the CLI printed "Sync complete." with exit 0 even when the archive was
 * unreachable (every item still pending). Now it returns the final outcome so the CLI can say
 * "Sync incomplete" and exit non-zero.
 */
let dir: string | undefined;

function tmpQueuePath(): string {
  dir = mkdtempSync(join(tmpdir(), "run-sync-"));
  return join(dir, "queue.sqlite");
}

function seedOneEvent(path: string): void {
  const q = new QueueStore(path);
  q.enqueue("event", "fp1", { fingerprint: "fp1" });
  q.close();
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

describe("runSync (C.11 — outcome reflects real delivery)", () => {
  it("returns outcome 'ok' and drains the queue when the archive accepts", async () => {
    const path = tmpQueuePath();
    seedOneEvent(path);
    const res = await runSync({
      url: "http://x",
      token: "t",
      queuePath: path,
      post: async () => ({ recordsInserted: 0, eventsUpserted: 1 }),
    });
    expect(res.outcome).toBe("ok");
    expect(res.stats.pending).toBe(0);
  });

  it("returns outcome 'retry' and leaves items queued when the archive is unreachable", async () => {
    const path = tmpQueuePath();
    seedOneEvent(path);
    const res = await runSync({
      url: "http://x",
      token: "t",
      queuePath: path,
      post: async () => {
        throw new TypeError("fetch failed"); // node's connection-refused shape
      },
    });
    expect(res.outcome).toBe("retry");
    expect(res.stats.pending).toBe(1);
  });

  it("returns outcome 'stop' on a 401 (token revoked) and leaves items queued", async () => {
    const path = tmpQueuePath();
    seedOneEvent(path);
    const res = await runSync({
      url: "http://x",
      token: "t",
      queuePath: path,
      post: async () => {
        throw new IngestHttpError(401, "unauthorized");
      },
    });
    expect(res.outcome).toBe("stop");
    expect(res.stats.pending).toBe(1);
  });
});
