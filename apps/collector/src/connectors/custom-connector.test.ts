import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventFingerprint, type EventType } from "@420ai/shared";
import {
  CUSTOM_CONNECTOR_CONFIG_VERSION,
  MAPPABLE_EVENT_TYPES,
  validateCustomDef,
  loadCustomConnectors,
  saveCustomConnectors,
  makeCustomConnector,
  type CustomConnectorDef,
} from "./custom-connector.js";

/**
 * The factory + loader + validation — the core of M10-S2. Mirrors
 * `connector-config.test.ts` (mkdtemp path seam, never the real ~/.420ai) and
 * `claude-code.test.ts` (event-field assertions). These reproduce the four proofs
 * of the pre-flight spike as the permanent unit test.
 */

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "customconn-")), "custom-connectors.json");
}

describe("custom-connector factory", () => {
  it("(a) jsonl dot-path mapping → one event per line with mapped fields + tokens", () => {
    const def: CustomConnectorDef = {
      id: "custom-jsonl",
      watchGlobs: ["/tmp/x/*.log"],
      format: "jsonl",
      tsField: "meta.ts",
      sessionIdField: "meta.session",
      projectPathField: "cwd",
      modelField: "model",
      eventTypeField: "kind",
      tokenMap: { input: "usage.in", output: "usage.out" },
    };
    const conn = makeCustomConnector(def);
    const line = JSON.stringify({
      meta: { ts: "2026-06-19T00:00:00.000Z", session: "s1" },
      cwd: "/proj",
      model: "opus",
      kind: "message.assistant",
      usage: { in: 10, out: 20 },
    });
    const result = conn.parse(line + "\n");

    expect(result.skippedLines).toBe(0);
    expect(result.rawRecords).toHaveLength(1);
    expect(result.rawRecords[0]).toMatchObject({
      id: "s1:0",
      sourceConnector: "custom-jsonl",
      sessionId: "s1",
      payload: line,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      fingerprint: eventFingerprint("custom-jsonl", "s1:0", 0, "message.assistant"),
      sourceConnector: "custom-jsonl",
      parserVersion: CUSTOM_CONNECTOR_CONFIG_VERSION,
      rawRecordId: "s1:0",
      eventIndex: 0,
      eventType: "message.assistant",
      sessionId: "s1",
      projectPath: "/proj",
      model: "opus",
      ts: "2026-06-19T00:00:00.000Z",
    });
    expect(result.events[0]?.tokens).toMatchObject({ input: 10, output: 20, total: 30 });
    // A custom connector prices nothing → catalog_version is honestly NULL/undefined (D2).
    expect(result.events[0]?.catalogVersion).toBeUndefined();
  });

  it("(b) regex named-capture mapping → mapped fields from match.groups", () => {
    const def: CustomConnectorDef = {
      id: "custom-regex",
      watchGlobs: ["/tmp/y/*.log"],
      format: "regex",
      pattern: "^(?<ts>\\S+)\\s+session=(?<sessionId>\\S+)\\s+kind=(?<kind>\\S+)\\s+(?<msg>.*)$",
      tsField: "ts",
      sessionIdField: "sessionId",
      eventTypeField: "kind",
    };
    const conn = makeCustomConnector(def);
    const result = conn.parse("2026-06-19T00:00:00Z session=s2 kind=message.user hello there\n");

    expect(result.skippedLines).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "message.user",
      sessionId: "s2",
      ts: "2026-06-19T00:00:00Z",
      sourceConnector: "custom-regex",
      rawRecordId: "s2:0",
    });
    // No tokenMap ⇒ no tokens on the event, and honest fidelity.
    expect(result.events[0]?.tokens).toBeUndefined();
    expect(conn.fidelity.tokens).toBe("none");
    expect(conn.fidelity.status).toBe("experimental");
    expect(conn.fidelity.captureMethod).toBe("custom-tail-regex");
  });

  it("(c) tolerant: blank, unparseable, and non-mappable lines skip without throwing", () => {
    const def: CustomConnectorDef = {
      id: "custom-tolerant",
      watchGlobs: ["/tmp/z/*.log"],
      format: "jsonl",
      sessionIdField: "session",
      eventTypeField: "kind",
    };
    const conn = makeCustomConnector(def);
    const text = [
      "", //                                          blank ⇒ ignored (not counted)
      "{ this is not json", //                         unparseable ⇒ skippedLines++
      JSON.stringify({ kind: "nope.bad", session: "s" }), // junk eventType ⇒ skippedLines++
      JSON.stringify({ kind: "message.user", session: "s" }), // valid ⇒ 1 event
    ].join("\n");

    let result!: ReturnType<typeof conn.parse>;
    expect(() => {
      result = conn.parse(text);
    }).not.toThrow();
    expect(result.skippedLines).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("message.user");
  });

  it("(d) validateCustomDef accepts a good def and rejects bad ones with reasons", () => {
    const good = validateCustomDef({
      id: "custom-ok",
      watchGlobs: ["/x/*.log"],
      format: "jsonl",
      eventType: "message.user",
    } satisfies CustomConnectorDef);
    expect("ok" in good && good.ok.id).toBe("custom-ok");

    const empties = validateCustomDef({
      id: "c",
      watchGlobs: [],
      format: "jsonl",
      eventType: "message.user",
    });
    expect("error" in empties && empties.error).toMatch(/watchGlobs/);

    const badRegex = validateCustomDef({
      id: "c",
      watchGlobs: ["/x"],
      format: "regex",
      pattern: "(",
      eventType: "message.user",
    });
    expect("error" in badRegex && badRegex.error).toMatch(/invalid regex/);

    const unknownType = validateCustomDef({
      id: "c",
      watchGlobs: ["/x"],
      format: "jsonl",
      eventType: "made.up" as EventType,
    });
    expect("error" in unknownType && unknownType.error).toMatch(/unknown eventType/);

    // A mapped tsField whose group is absent from the pattern is rejected (catches the typo)…
    const tsFieldTypo = validateCustomDef({
      id: "c",
      watchGlobs: ["/x"],
      format: "regex",
      pattern: "^(?<sessionId>\\S+)$",
      tsField: "ts",
      eventType: "message.user",
    });
    expect("error" in tsFieldTypo && tsFieldTypo.error).toMatch(/tsField/);

    // …but a regex with NO tsField and no ts group is valid (timestamp falls back to capture time).
    const captureTimeOnly = validateCustomDef({
      id: "c",
      watchGlobs: ["/x"],
      format: "regex",
      pattern: "^(?<sessionId>\\S+)\\s+(?<msg>.*)$",
      eventType: "message.user",
    });
    expect("ok" in captureTimeOnly).toBe(true);

    const noEventType = validateCustomDef({ id: "c", watchGlobs: ["/x"], format: "jsonl" });
    expect("error" in noEventType && noEventType.error).toMatch(/eventType/);
  });

  it("(e) loadCustomConnectors returns [] on an absent or corrupt file (never throws)", () => {
    expect(loadCustomConnectors(tempConfigPath())).toEqual([]);
    const corrupt = tempConfigPath();
    writeFileSync(corrupt, "{ not valid json");
    expect(loadCustomConnectors(corrupt)).toEqual([]);
  });

  it("(f) save → load round-trips the declarations", () => {
    const path = tempConfigPath();
    const defs: CustomConnectorDef[] = [
      {
        id: "custom-a",
        watchGlobs: ["/a/*.log"],
        format: "jsonl",
        sessionIdField: "session",
        eventType: "message.user",
      },
    ];
    saveCustomConnectors(defs, path);
    expect(loadCustomConnectors(path)).toEqual(defs);
  });

  it("(g) MAPPABLE_EVENT_TYPES is exactly the EventType union", () => {
    // Forward direction is enforced at compile time by `as const satisfies` in the
    // source; reverse direction (every EventType is mappable) is asserted here:
    type Uncovered = Exclude<EventType, (typeof MAPPABLE_EVENT_TYPES)[number]>;
    const _allCovered: Uncovered extends never ? true : false = true;
    expect(_allCovered).toBe(true);
    expect(MAPPABLE_EVENT_TYPES).toHaveLength(13);
    expect(MAPPABLE_EVENT_TYPES).toContain("session.started");
    expect(MAPPABLE_EVENT_TYPES).toContain("cost.estimated");
    expect(new Set(MAPPABLE_EVENT_TYPES).size).toBe(MAPPABLE_EVENT_TYPES.length);
  });
});
