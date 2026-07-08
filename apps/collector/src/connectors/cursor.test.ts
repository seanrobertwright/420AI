import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCursorComposer,
  cursorConnector,
  CURSOR_CONNECTOR,
  CURSOR_PARSER_VERSION,
} from "./cursor.js";
import type { CursorBubbleRow } from "./cursor-store.js";
import type { PollContext } from "./connector.js";
import type { ParseResult } from "@420ai/shared";

const opts = { ingestedAt: "2026-07-08T00:00:00.000Z" };

/** A composer created at a fixed epoch (2026-07-08T00:00:00Z = 1783468800000). */
const CREATED_MS = 1783468800000;

function bubble(composerId: string, bubbleId: string, value: unknown): CursorBubbleRow {
  return { key: `bubbleId:${composerId}:${bubbleId}`, value: JSON.stringify(value) };
}

describe("parseCursorComposer", () => {
  it("emits a composer-envelope raw record (verbatim value) so the session is re-parseable", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const { rawRecords } = parseCursorComposer(composerJson, [], opts);
    const envelope = rawRecords.find((r) => r.id === "compA:composer")!;
    expect(envelope.payload).toBe(composerJson); // verbatim
    expect(envelope.sourceConnector).toBe(CURSOR_CONNECTOR);
    expect(envelope.sessionId).toBe("compA");
  });

  it("brackets the session with started/ended events stamped from composer timestamps", () => {
    const composerJson = JSON.stringify({
      composerId: "compA",
      createdAt: CREATED_MS,
      lastUpdatedAt: CREATED_MS + 60_000,
    });
    const { events } = parseCursorComposer(composerJson, [], opts);
    const started = events.find((e) => e.eventType === "session.started")!;
    const ended = events.find((e) => e.eventType === "session.ended")!;
    expect(started.ts).toBe("2026-07-08T00:00:00.000Z");
    expect(ended.ts).toBe("2026-07-08T00:01:00.000Z"); // lastUpdatedAt
    expect(started.sessionId).toBe("compA");
  });

  it("maps a user bubble to message.user and an assistant bubble to message.assistant", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const bubbles = [
      bubble("compA", "b1", { type: 1, text: "do the thing" }),
      bubble("compA", "b2", { type: 2, text: "done" }),
    ];
    const { events, rawRecords } = parseCursorComposer(composerJson, bubbles, opts);
    expect(events.some((e) => e.eventType === "message.user")).toBe(true);
    expect(events.some((e) => e.eventType === "message.assistant")).toBe(true);
    // envelope + 2 bubble raw records
    expect(rawRecords.map((r) => r.id).sort()).toEqual(["b1", "b2", "compA:composer"]);
  });

  it("emits usage.reported for non-zero tokens; skips it for {0,0}", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const bubbles = [
      bubble("compA", "b1", { type: 2, tokenCount: { inputTokens: 100, outputTokens: 20 } }),
      bubble("compA", "b2", { type: 2, tokenCount: { inputTokens: 0, outputTokens: 0 } }),
    ];
    const usage = parseCursorComposer(composerJson, bubbles, opts).events.filter(
      (e) => e.eventType === "usage.reported",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]!.tokens).toMatchObject({ input: 100, output: 20, total: 120 });
  });

  it("costs an assistant bubble ONLY when a real model name exists (not 'default')", () => {
    const withDefault = JSON.stringify({
      composerId: "compA",
      createdAt: CREATED_MS,
      modelConfig: { modelName: "default" },
    });
    const withReal = JSON.stringify({
      composerId: "compB",
      createdAt: CREATED_MS,
      modelConfig: { modelName: "claude-sonnet-4-6" },
    });
    const tokBubble = (id: string) =>
      bubble(id, "b1", { type: 2, tokenCount: { inputTokens: 1000, outputTokens: 500 } });

    const defaultEvents = parseCursorComposer(withDefault, [tokBubble("compA")], opts).events;
    expect(defaultEvents.some((e) => e.eventType === "cost.estimated")).toBe(false);
    // usage still captured; assistant model is undefined (not "default")
    expect(defaultEvents.find((e) => e.eventType === "message.assistant")!.model).toBeUndefined();

    const realEvents = parseCursorComposer(withReal, [tokBubble("compB")], opts).events;
    const cost = realEvents.find((e) => e.eventType === "cost.estimated")!;
    expect(cost.model).toBe("claude-sonnet-4-6");
    expect(cost.cost?.confidence).toBe("estimated-model-known");
    expect(cost.cost?.usd).toBeGreaterThan(0);
  });

  it("classifies tool calls: toolFormerData presence → started + completed/failed by status", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const bubbles = [
      bubble("compA", "b1", {
        type: 2,
        toolFormerData: { name: "read_file", status: "completed" },
      }),
      bubble("compA", "b2", { type: 2, toolFormerData: { name: "edit_file", status: "error" } }),
    ];
    const { events } = parseCursorComposer(composerJson, bubbles, opts);
    expect(events.filter((e) => e.eventType === "tool.call.started")).toHaveLength(2);
    expect(events.filter((e) => e.eventType === "tool.call.completed")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "tool.call.failed")).toHaveLength(1);
  });

  it("reconstructs a bubbleId containing embedded ':' separators (delimiter in a value)", () => {
    // The bubble key is split on ':'; a bubbleId that itself contains ':' must survive round-trip.
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const weird: CursorBubbleRow = {
      key: "bubbleId:compA:weird:id:99",
      value: JSON.stringify({ type: 1 }),
    };
    const { rawRecords, events } = parseCursorComposer(composerJson, [weird], opts);
    expect(rawRecords.some((r) => r.id === "weird:id:99")).toBe(true);
    expect(events.find((e) => e.eventType === "message.user")!.rawRecordId).toBe("weird:id:99");
  });

  it("tolerates a malformed composer blob (empty result, skippedLines 1)", () => {
    const result = parseCursorComposer("{not json", [], opts);
    expect(result.rawRecords).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.skippedLines).toBe(1);
  });

  it("counts a malformed bubble into skippedLines while the rest parse", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const bubbles: CursorBubbleRow[] = [
      { key: "bubbleId:compA:good", value: JSON.stringify({ type: 1 }) },
      { key: "bubbleId:compA:bad", value: "{broken" },
    ];
    const result = parseCursorComposer(composerJson, bubbles, opts);
    expect(result.skippedLines).toBe(1);
    expect(result.rawRecords.some((r) => r.id === "good")).toBe(true);
    expect(result.rawRecords.some((r) => r.id === "bad")).toBe(false);
  });

  it("a zero-bubble composer yields only the envelope + session events", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const { rawRecords, events } = parseCursorComposer(composerJson, [], opts);
    expect(rawRecords).toHaveLength(1); // envelope only
    expect(events.map((e) => e.eventType).sort()).toEqual(["session.ended", "session.started"]);
  });

  it("derives the composerId from a bubble key when the composer JSON omits it", () => {
    const composerJson = JSON.stringify({ createdAt: CREATED_MS }); // no composerId
    const { sessionId } = parseCursorComposer(
      composerJson,
      [bubble("derivedC", "b1", { type: 1 })],
      opts,
    );
    expect(sessionId).toBe("derivedC");
  });

  it("guards a NaN/absent createdAt (falls back to ingestedAt, never 'Invalid Date')", () => {
    const composerJson = JSON.stringify({ composerId: "compA" }); // no createdAt
    const started = parseCursorComposer(composerJson, [], opts).events.find(
      (e) => e.eventType === "session.started",
    )!;
    expect(started.ts).toBe(opts.ingestedAt);
  });

  it("produces identical fingerprints across two parses (stable across re-observation)", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const bubbles = [
      bubble("compA", "b1", { type: 2, tokenCount: { inputTokens: 5, outputTokens: 5 } }),
    ];
    const a = parseCursorComposer(composerJson, bubbles, {
      ingestedAt: "2026-07-08T00:00:00.000Z",
    });
    const b = parseCursorComposer(composerJson, bubbles, {
      ingestedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(a.events.map((e) => e.fingerprint)).toEqual(b.events.map((e) => e.fingerprint));
    const fps = a.events.map((e) => e.fingerprint);
    expect(new Set(fps).size).toBe(fps.length); // all distinct
  });

  it("stamps parserVersion + connector on every event", () => {
    const composerJson = JSON.stringify({ composerId: "compA", createdAt: CREATED_MS });
    const { events } = parseCursorComposer(
      composerJson,
      [bubble("compA", "b1", { type: 1 })],
      opts,
    );
    expect(events.every((e) => e.parserVersion === CURSOR_PARSER_VERSION)).toBe(true);
    expect(events.every((e) => e.sourceConnector === CURSOR_CONNECTOR)).toBe(true);
  });
});

// --- Poll capability (runs the REAL parser + store against a fixture vscdb) ---

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function buildFixtureStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-poll-"));
  tempDirs.push(dir);
  const path = join(dir, "state.vscdb");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const ins = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  ins.run(
    "composerData:compA",
    Buffer.from(JSON.stringify({ composerId: "compA", createdAt: CREATED_MS })),
  );
  ins.run(
    "composerData:compB",
    Buffer.from(JSON.stringify({ composerId: "compB", createdAt: CREATED_MS })),
  );
  ins.run("bubbleId:compA:b1", Buffer.from(JSON.stringify({ type: 1, text: "hi" })));
  db.close();
  return path;
}

/** A test PollContext: read-only `changed` + `commit` records, mirroring pollChanged/pollCommit. */
function fakeCtx(alwaysChanged: boolean): {
  ctx: PollContext;
  enqueued: ParseResult[];
  seen: Set<string>;
} {
  const enqueued: ParseResult[] = [];
  const seen = new Set<string>();
  const ctx: PollContext = {
    changed: (key) => alwaysChanged || !seen.has(key),
    enqueue: (result) => enqueued.push(result),
    commit: (key) => {
      seen.add(key);
    },
  };
  return { ctx, enqueued, seen };
}

describe("cursorConnector.poll", () => {
  it("declares empty watchGlobs (poll-mode; the FileWatcher ignores it)", () => {
    expect(cursorConnector.watchGlobs("/home")).toEqual([]);
    expect(cursorConnector.captureMode).toBe("poll");
    expect(cursorConnector.poll).toBeTruthy();
  });

  it("fetches + parses every composer whose content changed", () => {
    const path = buildFixtureStore();
    const { ctx, enqueued } = fakeCtx(true);
    const outcome = cursorConnector.poll!.run(path, ctx);
    expect(outcome.swept).toBe(2);
    expect(outcome.changed).toBe(2);
    expect(enqueued).toHaveLength(2);
    // compA carried a bubble → envelope + bubble raw records
    const compA = enqueued.find((r) => r.sessionId === "compA")!;
    expect(compA.rawRecords.map((r) => r.id).sort()).toEqual(["b1", "compA:composer"]);
  });

  it("skips composers whose content is unchanged (no fetch, no enqueue)", () => {
    const path = buildFixtureStore();
    const { ctx, enqueued } = fakeCtx(false);
    // First pass: both change.
    cursorConnector.poll!.run(path, ctx);
    enqueued.length = 0;
    // Second pass (same store, same ctx): nothing changed.
    const outcome = cursorConnector.poll!.run(path, ctx);
    expect(outcome.changed).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("reports an absent store as unavailable, never throws", () => {
    const { ctx } = fakeCtx(true);
    const outcome = cursorConnector.poll!.run(join(tmpdir(), "no-such-420ai.vscdb"), ctx);
    expect(outcome.unavailable).toBe(true);
    expect(outcome.changed).toBe(0);
  });

  it("does NOT commit a composer whose enqueue fails (commit-point ordering → retried next tick)", () => {
    const path = buildFixtureStore();
    const seen = new Set<string>();
    const ctx: PollContext = {
      changed: (key) => !seen.has(key),
      enqueue: () => {
        throw new Error("queue down");
      },
      commit: (key) => {
        seen.add(key);
      },
    };
    expect(() => cursorConnector.poll!.run(path, ctx)).toThrow("queue down");
    // Nothing committed — a transient enqueue failure must leave every composer eligible for retry.
    expect(seen.size).toBe(0);
  });
});
