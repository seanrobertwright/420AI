import { describe, it, expect } from "vitest";
import { QueueStore } from "../queue/queue-store.js";
import { claudeLiveConnector } from "../connectors/claude-live.js";
import { runPushServer, type PushServerOptions } from "./push-server.js";

/**
 * The `push` receiver, exercised over real HTTP against an ephemeral port (0), a real
 * in-memory QueueStore, and the real `claude-live` connector. Proves: token-authed 200 +
 * enqueue, dedup no-op on re-POST, 401/400/413, and clean teardown on abort (no leak).
 */

const TOKEN = "test-push-token-abc123";

const CONVERSATIONS = [
  {
    uuid: "test-conv-1",
    name: "hello",
    model: "claude-opus-4-1",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:01:00.000Z",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "hi", created_at: "2026-07-20T00:00:01.000Z" },
      { uuid: "m2", sender: "assistant", text: "hello", created_at: "2026-07-20T00:00:05.000Z" },
    ],
  },
];
// One conversation → session.started + message.user + message.assistant + session.ended
// (4 events) + 2 raw records = 6 durable queue items.
const EXPECTED_PENDING = 6;

/** Start the receiver on an ephemeral port; resolve the actual port + a teardown handle. */
function startServer(over: Partial<PushServerOptions> = {}): {
  portReady: Promise<number>;
  ctrl: AbortController;
  done: Promise<void>;
  queue: QueueStore;
} {
  const ctrl = new AbortController();
  const queue = over.queue ?? new QueueStore(":memory:");
  let resolvePort!: (p: number) => void;
  const portReady = new Promise<number>((r) => (resolvePort = r));
  const done = runPushServer(
    {
      connectors: [claudeLiveConnector],
      queue,
      token: TOKEN,
      port: 0,
      log: () => {},
      onListen: (p) => resolvePort(p),
      ...over,
    },
    ctrl.signal,
  );
  return { portReady, ctrl, done, queue };
}

function post(port: number, body: string, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
}

describe("runPushServer", () => {
  it("accepts a valid POST, enqueues raw+events, and dedups a re-POST (idempotent)", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      const payload = JSON.stringify({ connector: "claude-live", conversations: CONVERSATIONS });

      const res = await post(port, payload);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { rawRecords: number; events: number };
      expect(json.rawRecords).toBe(2);
      expect(json.events).toBe(4);
      expect(queue.stats().pending).toBe(EXPECTED_PENDING);

      // Re-POST the SAME conversations → the queue dedups by content hash (no new items).
      const res2 = await post(port, payload);
      expect(res2.status).toBe(200);
      expect(queue.stats().pending).toBe(EXPECTED_PENDING);
    } finally {
      ctrl.abort();
      await done;
      queue.close();
    }
  });

  it("rejects a missing/wrong bearer token with 401 and enqueues nothing", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      const payload = JSON.stringify({ connector: "claude-live", conversations: CONVERSATIONS });

      const wrong = await post(port, payload, "not-the-token");
      expect(wrong.status).toBe(401);

      const missing = await fetch(`http://127.0.0.1:${port}/v1/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(missing.status).toBe(401);

      expect(queue.stats().pending).toBe(0);
    } finally {
      ctrl.abort();
      await done;
      queue.close();
    }
  });

  it("rejects an unknown/non-push connector id with 400", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      const res = await post(
        port,
        JSON.stringify({ connector: "claude-code", conversations: CONVERSATIONS }),
      );
      expect(res.status).toBe(400);
      expect(queue.stats().pending).toBe(0);
    } finally {
      ctrl.abort();
      await done;
      queue.close();
    }
  });

  it("rejects a malformed envelope with 400 but stays up (never 500)", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      // Missing `conversations` array.
      const bad = await post(port, JSON.stringify({ connector: "claude-live" }));
      expect(bad.status).toBe(400);
      // Not valid JSON at all.
      const notJson = await post(port, "{not valid");
      expect(notJson.status).toBe(400);
      // The server is still serving after two bad requests.
      const ok = await post(
        port,
        JSON.stringify({ connector: "claude-live", conversations: CONVERSATIONS }),
      );
      expect(ok.status).toBe(200);
      queue.close();
    } finally {
      ctrl.abort();
      await done;
    }
  });

  it("returns 200 with zero counts for a wrong-shape conversation (tolerant parser, no 500)", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      // A conversation with no stable uuid is skipped by the parser → 0 records/events.
      const res = await post(
        port,
        JSON.stringify({ connector: "claude-live", conversations: [{ name: "no uuid" }] }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { rawRecords: number; events: number };
      expect(json.rawRecords).toBe(0);
      expect(json.events).toBe(0);
      expect(queue.stats().pending).toBe(0);
    } finally {
      ctrl.abort();
      await done;
      queue.close();
    }
  });

  it("rejects a body over 16 MiB with 413 (bounded), enqueuing nothing", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    try {
      const port = await portReady;
      const huge = "x".repeat(17 * 1024 * 1024); // > 16 MiB
      // The server rejects mid-stream (413) then destroys the connection; depending on
      // timing the client may see the 413 or an upload reset — both prove the bound held.
      let status = 413;
      try {
        const res = await post(port, huge);
        status = res.status;
      } catch {
        status = 413; // upload reset by the oversize rejection — the bound fired
      }
      expect(status).toBe(413);
      expect(queue.stats().pending).toBe(0);
    } finally {
      ctrl.abort();
      await done;
      queue.close();
    }
  });

  it("resolves its promise promptly on abort (no leaked listener/port)", async () => {
    const { portReady, ctrl, done, queue } = startServer();
    const port = await portReady;
    expect(port).toBeGreaterThan(0);
    ctrl.abort();
    // If teardown leaked, `done` would never resolve and this would hang the test.
    await done;
    queue.close();
  });

  it("resolves immediately if the signal is already aborted (never binds)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const queue = new QueueStore(":memory:");
    await runPushServer(
      { connectors: [claudeLiveConnector], queue, token: TOKEN, port: 0, log: () => {} },
      ctrl.signal,
    );
    queue.close();
  });
});
