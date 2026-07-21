import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseClaudeWire,
  CLAUDE_LIVE_CONNECTOR,
  CLAUDE_WIRE_PARSER_VERSION,
} from "./claude-wire.js";

// Redacted from the VERIFIED live wire shape (2026-07-20 recon). Covers:
// [0] normal human+assistant text WITH a conversation model + title,
// [1] assistant turn whose content[] carries thinking/tool_use/tool_result blocks
//     (proves they are IGNORED, not crashed on) WITH a model,
// [2] an EMPTY conversation (0 messages),
// [3] non-empty with an EMPTY title AND model:null (assistant carries no model).
const fixture = readFileSync(
  new URL("./fixtures/sample-claude-wire.json", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-07-20T00:00:00.000Z" };

describe("parseClaudeWire", () => {
  it("emits session/message events for every non-empty conversation, ignoring non-text blocks", () => {
    const { events, rawRecords } = parseClaudeWire(fixture, opts);
    const byType = (t: string) => events.filter((e) => e.eventType === t);
    // 3 non-empty conversations (conv[2] is empty) × {started, user, assistant, ended}.
    expect(byType("session.started")).toHaveLength(3);
    expect(byType("session.ended")).toHaveLength(3);
    expect(byType("message.user")).toHaveLength(3);
    expect(byType("message.assistant")).toHaveLength(3);
    expect(events).toHaveLength(12);
    // Exactly one message event per message even when content[] has thinking/tool_use/
    // tool_result blocks — those are ignored, not exploded into tool events.
    expect(rawRecords).toHaveLength(6);
    // No usage/cost events at all — chat wire is uncosted.
    expect(byType("usage.reported")).toHaveLength(0);
    expect(byType("cost.estimated")).toHaveLength(0);
  });

  it("stamps the conversation model on message.assistant ONLY (absent on user/session)", () => {
    const { events } = parseClaudeWire(fixture, opts);
    // conv[0] assistant → its conversation model.
    const a0 = events.find(
      (e) => e.eventType === "message.assistant" && e.sessionId.startsWith("52caf7a2"),
    )!;
    expect(a0.model).toBe("claude-opus-4-1");
    // conv[1] assistant → its (different) conversation model.
    const a1 = events.find(
      (e) => e.eventType === "message.assistant" && e.sessionId.startsWith("4cad368d"),
    )!;
    expect(a1.model).toBe("claude-sonnet-4-5");
    // conv[3] has model:null → assistant event carries NO model (still valid, uncosted).
    const a3 = events.find(
      (e) => e.eventType === "message.assistant" && e.sessionId.startsWith("39c9595a"),
    )!;
    expect(a3.model).toBeUndefined();
    // user + session events NEVER carry a model, even in a conversation that has one.
    for (const e of events) {
      if (e.eventType !== "message.assistant") expect(e.model).toBeUndefined();
    }
  });

  it("emits NOTHING for an empty conversation (0 messages)", () => {
    const { events, rawRecords } = parseClaudeWire(fixture, opts);
    const emptyUuid = "95033e57"; // conv[2], 0 messages
    expect(events.some((e) => e.sessionId.startsWith(emptyUuid))).toBe(false);
    expect(rawRecords.some((r) => r.sessionId.startsWith(emptyUuid))).toBe(false);
  });

  it("attributes each event to the SHARED chat:claude:<uuid> topic key (no repo/git)", () => {
    const { events } = parseClaudeWire(fixture, opts);
    for (const e of events) {
      expect(e.projectPath).toBe(`chat:claude:${e.sessionId}`);
      expect(e.gitBranch).toBeUndefined();
    }
    const started = events.find((e) => e.eventType === "session.started")!;
    expect(started.sessionId).toBe("52caf7a2-3a14-4a2d-8883-a8741b3c92d0");
    expect(started.projectPath).toBe("chat:claude:52caf7a2-3a14-4a2d-8883-a8741b3c92d0");
  });

  it("is UNCOSTED — no tokens, cost, or catalogVersion (only assistant model set)", () => {
    const { events } = parseClaudeWire(fixture, opts);
    for (const e of events) {
      expect(e.tokens).toBeUndefined();
      expect(e.cost).toBeUndefined();
      expect(e.catalogVersion).toBeUndefined();
      expect(e.sourceConnector).toBe(CLAUDE_LIVE_CONNECTOR);
      expect(e.parserVersion).toBe(CLAUDE_WIRE_PARSER_VERSION);
    }
  });

  it("normalizes microsecond timestamps to canonical millisecond ISO", () => {
    const { events } = parseClaudeWire(fixture, opts);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const e of events) expect(e.ts).toMatch(iso);
    // conv[0] created_at 2025-08-07T15:32:40.100663Z → micros truncated to millis.
    const started = events.find(
      (e) => e.eventType === "session.started" && e.sessionId.startsWith("52caf7a2"),
    )!;
    expect(started.ts).toBe("2025-08-07T15:32:40.100Z");
  });

  it("carries the conversation title on session.started when present, omits it when empty", () => {
    const { events } = parseClaudeWire(fixture, opts);
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

  it("keys rawRecordId on the stable message uuid (fingerprint-invariant across re-pushes)", () => {
    const first = parseClaudeWire(fixture, opts);
    const second = parseClaudeWire(fixture, { ingestedAt: "2027-01-01T00:00:00.000Z" });
    // Re-parsing the SAME conversations — even with a different ingestedAt — yields
    // byte-identical fingerprints (the dedup invariant). ingestedAt is not a
    // fingerprint input, so it must not perturb them.
    const fps = (r: ReturnType<typeof parseClaudeWire>) => r.events.map((e) => e.fingerprint);
    expect(fps(second)).toEqual(fps(first));
    // rawRecordId of a message event is the message's own uuid.
    const msg = first.events.find((e) => e.eventType === "message.user")!;
    expect(first.rawRecords.some((r) => r.id === msg.rawRecordId)).toBe(true);
    // Fingerprints are unique per (rawRecordId, eventIndex, eventType).
    const set = new Set(fps(first));
    expect(set.size).toBe(first.events.length);
  });

  it("shares the attribution key with the export parser (live+export group under one session)", () => {
    // The claude-live projectPath is IDENTICAL to what parseClaudeExport emits for the
    // same conversation uuid — the documented cross-connector grouping (two sessions,
    // one topic key). Assert the key shape here so a future refactor can't silently
    // diverge it.
    const { events } = parseClaudeWire(fixture, opts);
    const e = events[0]!;
    expect(e.projectPath).toBe(`chat:claude:${e.sessionId}`);
  });

  it("tolerates a malformed / mid-flight body (empty result, skippedLines 1)", () => {
    const result = parseClaudeWire("[{not valid json", opts);
    expect(result.rawRecords).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.skippedLines).toBe(1);
  });

  it("tolerates valid-JSON-but-wrong-shape and a single bare conversation object", () => {
    // A scalar is not a conversation container → skippedLines.
    expect(() => parseClaudeWire("42", opts)).not.toThrow();
    expect(parseClaudeWire("42", opts).skippedLines).toBe(1);
    // A conversation missing a stable uuid is skipped, never keyed on position.
    const noUuid = JSON.stringify([
      { chat_messages: [{ sender: "human", uuid: "x", created_at: opts.ingestedAt }] },
    ]);
    const r = parseClaudeWire(noUuid, opts);
    expect(r.events).toHaveLength(0);
    expect(r.skippedLines).toBe(1);
    // A SINGLE bare conversation object (not wrapped in an array) is accepted.
    const single = JSON.stringify({
      uuid: "single-1",
      name: "solo",
      model: "claude-opus-4-1",
      created_at: opts.ingestedAt,
      updated_at: opts.ingestedAt,
      chat_messages: [
        { uuid: "m1", sender: "human", text: "hi", created_at: opts.ingestedAt },
        { uuid: "m2", sender: "assistant", text: "hello", created_at: opts.ingestedAt },
      ],
    });
    const rs = parseClaudeWire(single, opts);
    expect(rs.events.filter((e) => e.eventType === "message.assistant")).toHaveLength(1);
    expect(rs.events.find((e) => e.eventType === "message.assistant")!.model).toBe(
      "claude-opus-4-1",
    );
  });

  it("accepts a {conversations:[…]} wrapper defensively", () => {
    const wrapped = JSON.stringify({
      conversations: [
        {
          uuid: "wrap-1",
          name: "w",
          created_at: opts.ingestedAt,
          updated_at: opts.ingestedAt,
          chat_messages: [{ uuid: "m1", sender: "human", text: "x", created_at: opts.ingestedAt }],
        },
      ],
    });
    const r = parseClaudeWire(wrapped, opts);
    expect(r.events.filter((e) => e.eventType === "session.started")).toHaveLength(1);
  });
});
