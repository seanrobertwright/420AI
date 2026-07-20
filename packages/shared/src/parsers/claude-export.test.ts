import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseClaudeExport,
  CLAUDE_EXPORT_CONNECTOR,
  CLAUDE_EXPORT_PARSER_VERSION,
} from "./claude-export.js";

// Redacted from a REAL 71-conversation Claude export (Task-1 Phase-0 gate). Covers:
// [0] normal human+assistant text, [1] assistant turn with thinking/tool_use blocks,
// [2] an EMPTY conversation (0 messages), [3] non-empty with an EMPTY title.
const fixture = readFileSync(
  new URL("./fixtures/sample-claude-export.json", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-07-20T00:00:00.000Z" };

describe("parseClaudeExport", () => {
  it("emits session/message events for every non-empty conversation", () => {
    const { events, rawRecords } = parseClaudeExport(fixture, opts);
    const byType = (t: string) => events.filter((e) => e.eventType === t);
    // 3 non-empty conversations (the 4th is empty) × {started, user, assistant, ended}.
    expect(byType("session.started")).toHaveLength(3);
    expect(byType("session.ended")).toHaveLength(3);
    expect(byType("message.user")).toHaveLength(3);
    expect(byType("message.assistant")).toHaveLength(3);
    expect(events).toHaveLength(12);
    // One raw record per message (SACRED verbatim payload), 3 convs × 2 messages.
    expect(rawRecords).toHaveLength(6);
    // No usage/cost events at all — chat exports are uncosted.
    expect(byType("usage.reported")).toHaveLength(0);
    expect(byType("cost.estimated")).toHaveLength(0);
  });

  it("emits NOTHING for an empty conversation (0 messages)", () => {
    const { events, rawRecords } = parseClaudeExport(fixture, opts);
    const emptyUuid = "95033e57"; // conv[2], 0 messages
    expect(events.some((e) => e.sessionId.startsWith(emptyUuid))).toBe(false);
    expect(rawRecords.some((r) => r.sessionId.startsWith(emptyUuid))).toBe(false);
  });

  it("attributes each event to a stable synthetic topic key (no repo/git)", () => {
    const { events } = parseClaudeExport(fixture, opts);
    for (const e of events) {
      expect(e.projectPath).toBe(`chat:claude:${e.sessionId}`);
      expect(e.gitBranch).toBeUndefined();
    }
    // sessionId is the conversation uuid.
    const started = events.find((e) => e.eventType === "session.started")!;
    expect(started.sessionId).toBe("52caf7a2-3a14-4a2d-8883-a8741b3c92d0");
    expect(started.projectPath).toBe("chat:claude:52caf7a2-3a14-4a2d-8883-a8741b3c92d0");
  });

  it("is UNCOSTED and unmodeled — no tokens, cost, model, or catalogVersion", () => {
    const { events } = parseClaudeExport(fixture, opts);
    for (const e of events) {
      expect(e.tokens).toBeUndefined();
      expect(e.cost).toBeUndefined();
      expect(e.model).toBeUndefined();
      expect(e.catalogVersion).toBeUndefined();
      expect(e.sourceConnector).toBe(CLAUDE_EXPORT_CONNECTOR);
      expect(e.parserVersion).toBe(CLAUDE_EXPORT_PARSER_VERSION);
    }
  });

  it("normalizes microsecond timestamps to canonical millisecond ISO", () => {
    const { events } = parseClaudeExport(fixture, opts);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const e of events) expect(e.ts).toMatch(iso);
    // conv[0] created_at 2025-08-07T15:32:40.100663Z → micros truncated to millis.
    const started = events.find(
      (e) => e.eventType === "session.started" && e.sessionId.startsWith("52caf7a2"),
    )!;
    expect(started.ts).toBe("2025-08-07T15:32:40.100Z");
  });

  it("carries the conversation title on session.started when present, omits it when empty", () => {
    const { events } = parseClaudeExport(fixture, opts);
    const withTitle = events.find(
      (e) => e.eventType === "session.started" && e.sessionId.startsWith("52caf7a2"),
    )!;
    expect(withTitle.payload).toEqual({ title: "redacted" });
    // conv[3] has an empty name → no payload title.
    const noTitle = events.find(
      (e) => e.eventType === "session.started" && e.sessionId.startsWith("39c9595a"),
    )!;
    expect(noTitle.payload).toBeUndefined();
  });

  it("keys rawRecordId on the stable message uuid (fingerprint-invariant across re-imports)", () => {
    const first = parseClaudeExport(fixture, opts);
    const second = parseClaudeExport(fixture, { ingestedAt: "2027-01-01T00:00:00.000Z" });
    // Re-parsing the SAME export — even with a different ingestedAt — yields
    // byte-identical fingerprints (the dedup invariant). ingestedAt is not a
    // fingerprint input, so it must not perturb them.
    const fps = (r: ReturnType<typeof parseClaudeExport>) => r.events.map((e) => e.fingerprint);
    expect(fps(second)).toEqual(fps(first));
    // rawRecordId of a message event is the message's own uuid.
    const msg = first.events.find((e) => e.eventType === "message.user")!;
    expect(first.rawRecords.some((r) => r.id === msg.rawRecordId)).toBe(true);
    // Fingerprints are unique per (rawRecordId, eventIndex, eventType).
    const set = new Set(fps(first));
    expect(set.size).toBe(first.events.length);
  });

  it("tolerates a malformed / mid-copy whole-file blob (empty result, skippedLines 1)", () => {
    const result = parseClaudeExport("[{not valid json", opts);
    expect(result.rawRecords).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.skippedLines).toBe(1);
  });

  it("tolerates valid-JSON-but-wrong-shape without throwing", () => {
    expect(() => parseClaudeExport("42", opts)).not.toThrow();
    expect(parseClaudeExport("42", opts).skippedLines).toBe(1);
    // A conversation missing a stable uuid is skipped, never keyed on position.
    const noUuid = JSON.stringify([
      { chat_messages: [{ sender: "human", uuid: "x", created_at: opts.ingestedAt }] },
    ]);
    const r = parseClaudeExport(noUuid, opts);
    expect(r.events).toHaveLength(0);
    expect(r.skippedLines).toBe(1);
  });
});
