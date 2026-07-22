import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  parseGeminiExport,
  GEMINI_EXPORT_CONNECTOR,
  GEMINI_EXPORT_PARSER_VERSION,
} from "./gemini-export.js";

// Redacted from a REAL 1452-record Gemini Takeout "My Activity" export (Phase-0
// gate). Covers: [0] a "Prompted" record WITH a safeHtmlItem response, [1] a
// "Prompted" record with NO response, [2] a non-"Prompted" record (skipped), [3] a
// "Prompted" record with an attachment, [4] another non-"Prompted" record (skipped).
const fixture = readFileSync(
  new URL("./fixtures/sample-gemini-export.json", import.meta.url),
  "utf8",
);

const opts = { ingestedAt: "2026-07-20T00:00:00.000Z" };

/** Reproduce the parser's derived key so we can assert attribution. */
const keyFor = (time: string, title: string) =>
  createHash("sha256").update(`${time}|${title}`).digest("hex").slice(0, 32);

describe("parseGeminiExport", () => {
  it("emits a single-turn session per 'Prompted' record", () => {
    const { events, rawRecords } = parseGeminiExport(fixture, opts);
    const byType = (t: string) => events.filter((e) => e.eventType === t);
    // 3 "Prompted" records → 3 sessions; the 2 non-"Prompted" records emit nothing.
    expect(byType("session.started")).toHaveLength(3);
    expect(byType("session.ended")).toHaveLength(3);
    expect(byType("message.user")).toHaveLength(3);
    // Only 2 of the 3 "Prompted" records carry a response.
    expect(byType("message.assistant")).toHaveLength(2);
    expect(events).toHaveLength(11);
    // One raw record per "Prompted" record (the whole activity entry, verbatim).
    expect(rawRecords).toHaveLength(3);
    // No usage/cost events at all.
    expect(byType("usage.reported")).toHaveLength(0);
    expect(byType("cost.estimated")).toHaveLength(0);
  });

  it("emits the 4-event turn for a Prompted-with-response record", () => {
    const { events } = parseGeminiExport(fixture, opts);
    const key = keyFor("2026-07-20T15:15:21.568Z", "Prompted redacted prompt one");
    const forRec = events.filter((e) => e.rawRecordId === key).map((e) => e.eventType);
    expect(forRec).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
      "session.ended",
    ]);
  });

  it("omits message.assistant for a Prompted record with NO response", () => {
    const { events } = parseGeminiExport(fixture, opts);
    const key = keyFor("2026-07-20T16:02:03.111Z", "Prompted redacted prompt two with no response");
    const forRec = events.filter((e) => e.rawRecordId === key).map((e) => e.eventType);
    expect(forRec).toEqual(["session.started", "message.user", "session.ended"]);
  });

  it("skips non-'Prompted' activity without inflating skippedLines", () => {
    const { events, rawRecords, skippedLines } = parseGeminiExport(fixture, opts);
    // The "Created …" and "Selected preferred draft" records produce nothing.
    const createdKey = keyFor(
      "2026-07-20T16:30:44.900Z",
      "Created Gemini Canvas titled redacted canvas",
    );
    expect(events.some((e) => e.rawRecordId === createdKey)).toBe(false);
    expect(rawRecords.some((r) => r.id === createdKey)).toBe(false);
    // Intentional skips are NOT parse failures.
    expect(skippedLines).toBe(0);
  });

  it("carries the stripped prompt as the session.started title", () => {
    const { events } = parseGeminiExport(fixture, opts);
    const key = keyFor("2026-07-20T15:15:21.568Z", "Prompted redacted prompt one");
    const started = events.find((e) => e.rawRecordId === key && e.eventType === "session.started")!;
    expect(started.payload).toEqual({ title: "redacted prompt one" });
  });

  it("attributes each event to a derived synthetic topic key (no repo/git)", () => {
    const { events } = parseGeminiExport(fixture, opts);
    const key = keyFor("2026-07-20T15:15:21.568Z", "Prompted redacted prompt one");
    for (const e of events) {
      expect(e.projectPath).toBe(`chat:gemini:${e.rawRecordId}`);
      expect(e.sessionId).toBe(`gemini-${e.rawRecordId}`);
      expect(e.gitBranch).toBeUndefined();
    }
    expect(events.some((e) => e.rawRecordId === key)).toBe(true);
  });

  it("is UNCOSTED and model-less — no tokens, cost, model, or catalogVersion", () => {
    const { events } = parseGeminiExport(fixture, opts);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const e of events) {
      expect(e.tokens).toBeUndefined();
      expect(e.cost).toBeUndefined();
      expect(e.model).toBeUndefined();
      expect(e.catalogVersion).toBeUndefined();
      expect(e.ts).toMatch(iso);
      expect(e.sourceConnector).toBe(GEMINI_EXPORT_CONNECTOR);
      expect(e.parserVersion).toBe(GEMINI_EXPORT_PARSER_VERSION);
    }
  });

  it("derives a stable key → identical fingerprints on re-parse (dedup invariant)", () => {
    const first = parseGeminiExport(fixture, opts);
    const second = parseGeminiExport(fixture, { ingestedAt: "2027-01-01T00:00:00.000Z" });
    const fps = (r: ReturnType<typeof parseGeminiExport>) => r.events.map((e) => e.fingerprint);
    // ingestedAt is not a fingerprint input, so re-parse is byte-identical.
    expect(fps(second)).toEqual(fps(first));
    // Fingerprints are unique per (rawRecordId, eventType) — eventIndex is always 0.
    const set = new Set(fps(first));
    expect(set.size).toBe(first.events.length);
  });

  it("tolerates a malformed / mid-copy whole-file blob (empty result, skippedLines 1)", () => {
    const result = parseGeminiExport("[{not valid json", opts);
    expect(result.rawRecords).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.skippedLines).toBe(1);
  });

  it("tolerates valid-JSON-but-wrong-shape without throwing", () => {
    expect(() => parseGeminiExport("42", opts)).not.toThrow();
    expect(parseGeminiExport("42", opts).skippedLines).toBe(1);
    expect(parseGeminiExport('{"foo":1}', opts).skippedLines).toBe(1);
  });
});
