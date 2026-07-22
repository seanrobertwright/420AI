import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseChatgptExport,
  CHATGPT_EXPORT_CONNECTOR,
  CHATGPT_EXPORT_PARSER_VERSION,
} from "./chatgpt-export.js";

// Redacted from a REAL 63-conversation ChatGPT export (Phase-0 gate). Covers:
// [0] normal user+assistant text, [1] assistant turn with thoughts + reasoning_recap
// nodes (raw-kept-but-not-evented), [2] a multimodal_text user message, [3] an
// empty conversation (root node only, no messages).
const fixture = readFileSync(
  new URL("./fixtures/sample-chatgpt-export.json", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-07-20T00:00:00.000Z" };

describe("parseChatgptExport", () => {
  it("emits session/message events for every non-empty conversation", () => {
    const { events } = parseChatgptExport(fixture, opts);
    const byType = (t: string) => events.filter((e) => e.eventType === t);
    // 3 non-empty conversations (the 4th is root-only) × {started, ended}.
    expect(byType("session.started")).toHaveLength(3);
    expect(byType("session.ended")).toHaveLength(3);
    // message.user: conv0 text + conv1 text + conv2 multimodal_text.
    expect(byType("message.user")).toHaveLength(3);
    // message.assistant: conv0 text + conv1 text (thoughts/recap emit nothing) + conv2 text.
    expect(byType("message.assistant")).toHaveLength(3);
    expect(events).toHaveLength(12);
    // No usage/cost events at all — the export has no token counts.
    expect(byType("usage.reported")).toHaveLength(0);
    expect(byType("cost.estimated")).toHaveLength(0);
  });

  it("emits NOTHING for a conversation with only a root node (no messages)", () => {
    const { events, rawRecords } = parseChatgptExport(fixture, opts);
    const emptyId = "6919dead-beef-0000-1111-222233334444"; // conv[3], root only
    expect(events.some((e) => e.sessionId === emptyId)).toBe(false);
    expect(rawRecords.some((r) => r.sessionId === emptyId)).toBe(false);
  });

  it("orders messages by create_time (not mapping key order)", () => {
    const { events } = parseChatgptExport(fixture, opts);
    // conv0: the user message (earlier create_time) must event before the assistant.
    const conv0 = events.filter((e) => e.sessionId === "6919eca9-1470-8332-a4c6-264eb782adeb");
    const user = conv0.findIndex((e) => e.eventType === "message.user");
    const asst = conv0.findIndex((e) => e.eventType === "message.assistant");
    expect(user).toBeLessThan(asst);
  });

  it("keeps thoughts/reasoning_recap as raw records but emits NO event for them", () => {
    const { events, rawRecords } = parseChatgptExport(fixture, opts);
    // conv1 has 4 message nodes (user, thoughts, asst, recap) → 4 raw records.
    const conv1Raw = rawRecords.filter(
      (r) => r.sessionId === "6919abcd-2233-4455-6677-8899aabbccdd",
    );
    expect(conv1Raw).toHaveLength(4);
    // The thoughts + recap nodes are stored raw...
    for (const id of ["msg-1-thoughts", "msg-1-recap"]) {
      expect(rawRecords.some((r) => r.id === id)).toBe(true);
      // ...but referenced by NO normalized event.
      expect(events.some((e) => e.rawRecordId === id)).toBe(false);
    }
    // Total raw (8) exceeds the message events (6) precisely because of the two
    // raw-kept-not-evented reasoning nodes.
    const messageEvents = events.filter((e) => e.eventType.startsWith("message."));
    expect(rawRecords.length).toBeGreaterThan(messageEvents.length);
  });

  it("maps a multimodal_text user message to a message.user event", () => {
    const { events } = parseChatgptExport(fixture, opts);
    const mm = events.find((e) => e.rawRecordId === "msg-2-user");
    expect(mm?.eventType).toBe("message.user");
  });

  it("converts epoch-seconds create_time to canonical millisecond ISO (×1000)", () => {
    const { events } = parseChatgptExport(fixture, opts);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const e of events) expect(e.ts).toMatch(iso);
    // conv0 create_time 1763306665.654753 (epoch SECONDS) → ×1000 → ms ISO.
    const started = events.find(
      (e) =>
        e.eventType === "session.started" && e.sessionId === "6919eca9-1470-8332-a4c6-264eb782adeb",
    )!;
    expect(started.ts).toBe(new Date(1763306665.654753 * 1000).toISOString());
  });

  it("stamps model on message events (from model_slug) but stays uncosted", () => {
    const { events } = parseChatgptExport(fixture, opts);
    const asst = events.find(
      (e) => e.eventType === "message.assistant" && e.rawRecordId === "msg-0-asst",
    )!;
    expect(asst.model).toBe("gpt-5-1");
    // Uncosted: no tokens/cost/catalogVersion anywhere.
    for (const e of events) {
      expect(e.tokens).toBeUndefined();
      expect(e.cost).toBeUndefined();
      expect(e.catalogVersion).toBeUndefined();
      expect(e.sourceConnector).toBe(CHATGPT_EXPORT_CONNECTOR);
      expect(e.parserVersion).toBe(CHATGPT_EXPORT_PARSER_VERSION);
    }
  });

  it("attributes each event to a stable synthetic topic key (no repo/git)", () => {
    const { events } = parseChatgptExport(fixture, opts);
    for (const e of events) {
      expect(e.projectPath).toBe(`chat:chatgpt:${e.sessionId}`);
      expect(e.gitBranch).toBeUndefined();
    }
    const started = events.find((e) => e.eventType === "session.started")!;
    expect(started.projectPath).toBe(`chat:chatgpt:${started.sessionId}`);
  });

  it("carries the conversation title on session.started when present", () => {
    const { events } = parseChatgptExport(fixture, opts);
    const started = events.find(
      (e) =>
        e.eventType === "session.started" && e.sessionId === "6919eca9-1470-8332-a4c6-264eb782adeb",
    )!;
    expect(started.payload).toEqual({ title: "redacted title zero" });
  });

  it("keys rawRecordId on the stable message id (fingerprint-invariant across re-imports)", () => {
    const first = parseChatgptExport(fixture, opts);
    const second = parseChatgptExport(fixture, { ingestedAt: "2027-01-01T00:00:00.000Z" });
    // Re-parsing the SAME export — even with a different ingestedAt — yields
    // byte-identical fingerprints (the dedup invariant).
    const fps = (r: ReturnType<typeof parseChatgptExport>) => r.events.map((e) => e.fingerprint);
    expect(fps(second)).toEqual(fps(first));
    // Fingerprints are unique per (rawRecordId, eventIndex, eventType).
    const set = new Set(fps(first));
    expect(set.size).toBe(first.events.length);
  });

  it("tolerates a malformed / mid-copy whole-file blob (empty result, skippedLines 1)", () => {
    const result = parseChatgptExport("[{not valid json", opts);
    expect(result.rawRecords).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.skippedLines).toBe(1);
  });

  it("tolerates valid-JSON-but-wrong-shape without throwing", () => {
    expect(() => parseChatgptExport("42", opts)).not.toThrow();
    expect(parseChatgptExport("42", opts).skippedLines).toBe(1);
    // A conversation missing a stable conversation_id is skipped, never keyed on position.
    const noId = JSON.stringify([{ mapping: {} }]);
    const r = parseChatgptExport(noId, opts);
    expect(r.events).toHaveLength(0);
    expect(r.skippedLines).toBe(1);
  });
});
