import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../queue/queue-store.js";
import { connectors } from "../connectors/connector.js";
import { claudeCodeConnector } from "../connectors/claude-code.js";
import { geminiCliConnector } from "../connectors/gemini-cli.js";
import { toRawRecordPayload, toEventPayload } from "@420ai/shared";
import { FileWatcher } from "./file-watcher.js";

let dir: string | undefined;

const REC1 =
  '{"type":"user","uuid":"u-1","sessionId":"s1","cwd":"/p","gitBranch":"main","timestamp":"2026-06-13T10:00:00.000Z","message":{"role":"user","content":"hi"}}';
const REC2 =
  '{"type":"user","uuid":"u-2","sessionId":"s1","cwd":"/p","gitBranch":"main","timestamp":"2026-06-13T10:00:05.000Z","message":{"role":"user","content":"again"}}';

function setup(): { home: string; queue: QueueStore; projectsDir: string } {
  dir = mkdtempSync(join(tmpdir(), "m3-watcher-"));
  const home = join(dir, "home");
  const projectsDir = join(home, ".claude", "projects", "slug");
  mkdirSync(projectsDir, { recursive: true });
  const queue = new QueueStore(join(dir, "queue.sqlite"));
  return { home, queue, projectsDir };
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

describe("FileWatcher.tickOnce (poll-based discovery + capture)", () => {
  it("captures a new session file, then only the new prefix on append (dedup)", async () => {
    const { home, queue, projectsDir } = setup();
    const calls: string[] = [];
    const enqueueFromParse = (connector = claudeCodeConnector, text: string): void => {
      const parsed = connector.parse(text);
      for (const r of parsed.rawRecords) {
        queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
      }
      for (const e of parsed.events) queue.enqueue("event", e.fingerprint, toEventPayload(e));
    };
    const watcher = new FileWatcher({
      connectors,
      home,
      queue,
      onChange: (connector, text) => {
        calls.push(text);
        enqueueFromParse(connector, text);
      },
    });

    const file = join(projectsDir, "11111111-1111-1111-1111-111111111111.jsonl");
    writeFileSync(file, REC1 + "\n", "utf8");

    await watcher.tickOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(REC1 + "\n");
    // Look up the cursor via the path the watcher actually discovered (glob's
    // path normalization may differ from a hand-built path).
    const [discovered] = await watcher.discover();
    const cursor = queue.getCursor(claudeCodeConnector.id, discovered!.path);
    expect(cursor?.byteOffset).toBe(Buffer.byteLength(REC1 + "\n"));
    const rawAfterFirst = queue.stats().pending; // raws + events for 1 record

    // Append a second line — onChange gets the WHOLE prefix; dedup means only
    // the new record's raw is added (the first raw is a no-op).
    appendFileSync(file, REC2 + "\n", "utf8");
    await watcher.tickOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(REC1 + "\n" + REC2 + "\n");
    expect(queue.stats().pending).toBeGreaterThan(rawAfterFirst); // grew, but not doubled blindly

    // A tick with no growth does nothing.
    const before = calls.length;
    await watcher.tickOnce();
    expect(calls).toHaveLength(before);

    queue.close();
  });

  it("captures a snapshot connector on rewrite and skips an unchanged tick", async () => {
    dir = mkdtempSync(join(tmpdir(), "m4-watcher-snap-"));
    const home = join(dir, "home");
    const chatsDir = join(home, ".gemini", "tmp", "proj", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const queue = new QueueStore(join(dir, "queue.sqlite"));

    const captured: string[] = [];
    const watcher = new FileWatcher({
      connectors: [geminiCliConnector],
      home,
      queue,
      onChange: (_c, text) => {
        captured.push(text);
      },
    });

    const file = join(chatsDir, "session-1.json");
    const v1 = JSON.stringify({
      sessionId: "g1",
      projectHash: "h1",
      startTime: "2026-06-13T10:00:00.000Z",
      lastUpdated: "2026-06-13T10:00:01.000Z",
      messages: [{ id: "m1", type: "user", content: "hi" }],
    });
    writeFileSync(file, v1, "utf8");

    await watcher.tickOnce();
    expect(captured).toHaveLength(1);

    // An unchanged tick is a no-op (size+mtime gate).
    await watcher.tickOnce();
    expect(captured).toHaveLength(1);

    // A whole-file rewrite (different length) is re-read.
    const v2 = JSON.stringify({
      sessionId: "g1",
      projectHash: "h1",
      startTime: "2026-06-13T10:00:00.000Z",
      lastUpdated: "2026-06-13T10:00:05.000Z",
      messages: [
        { id: "m1", type: "user", content: "hi" },
        { id: "m2", type: "user", content: "again, with more bytes" },
      ],
    });
    writeFileSync(file, v2, "utf8");
    await watcher.tickOnce();
    expect(captured).toHaveLength(2);
    expect(captured[1]).toContain("m2");

    queue.close();
  });

  it("discovers a second session file created mid-run", async () => {
    const { home, queue, projectsDir } = setup();
    const captured: string[] = [];
    const watcher = new FileWatcher({
      connectors,
      home,
      queue,
      onChange: (_c, text) => {
        captured.push(text);
      },
    });

    const f1 = join(projectsDir, "aaaaaaaa-0000-0000-0000-000000000000.jsonl");
    writeFileSync(f1, REC1 + "\n", "utf8");
    await watcher.tickOnce();
    expect(captured).toHaveLength(1);

    // New file appears without restart -> discovered on the next tick.
    const f2 = join(projectsDir, "bbbbbbbb-0000-0000-0000-000000000000.jsonl");
    writeFileSync(f2, REC2 + "\n", "utf8");
    await watcher.tickOnce();
    expect(captured).toHaveLength(2);

    queue.close();
  });
});
