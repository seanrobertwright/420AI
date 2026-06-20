import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectors as defaultConnectors } from "./connector.js";
import { saveCustomConnectors, type CustomConnectorDef } from "./custom-connector.js";
import { loadRegistry } from "./registry.js";

/**
 * The merge point: built-ins + valid custom, dropping collisions/invalid with a
 * surfaced reason. Default-on safety — an absent config yields exactly the builtins.
 */

const BUILTIN_IDS = defaultConnectors.map((c) => c.id);

function tempCustomPath(): string {
  return join(mkdtempSync(join(tmpdir(), "registry-")), "custom-connectors.json");
}

function def(id: string, extra: Partial<CustomConnectorDef> = {}): CustomConnectorDef {
  return {
    id,
    watchGlobs: ["/tmp/x/*.log"],
    format: "jsonl",
    sessionIdField: "session",
    eventType: "message.user",
    ...extra,
  };
}

describe("loadRegistry", () => {
  it("absent config ⇒ exactly the builtins, nothing dropped (fresh-install parity)", () => {
    const { connectors, dropped } = loadRegistry("/fake/home", { customPath: tempCustomPath() });
    expect(connectors.map((c) => c.id)).toEqual(BUILTIN_IDS);
    expect(dropped).toEqual([]);
  });

  it("one valid custom def ⇒ appended after the builtins", () => {
    const path = tempCustomPath();
    saveCustomConnectors([def("custom-mytool")], path);
    const { connectors, dropped } = loadRegistry("/fake/home", { customPath: path });
    expect(connectors.map((c) => c.id)).toEqual([...BUILTIN_IDS, "custom-mytool"]);
    expect(dropped).toEqual([]);
    // The appended connector is a real, experimental tail connector.
    const custom = connectors.find((c) => c.id === "custom-mytool");
    expect(custom?.captureMode).toBe("tail");
    expect(custom?.fidelity.status).toBe("experimental");
  });

  it("a custom id colliding with a built-in is dropped with a reason", () => {
    const path = tempCustomPath();
    saveCustomConnectors([def("claude-code")], path);
    const { connectors, dropped } = loadRegistry("/fake/home", { customPath: path });
    expect(connectors.map((c) => c.id)).toEqual(BUILTIN_IDS); // built-in claude-code untouched
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: "claude-code" });
    expect(dropped[0]?.reason).toMatch(/collides/);
  });

  it("two custom defs sharing an id ⇒ first wins, second dropped", () => {
    const path = tempCustomPath();
    saveCustomConnectors([def("custom-dup", { displayName: "first" }), def("custom-dup")], path);
    const { connectors, dropped } = loadRegistry("/fake/home", { customPath: path });
    expect(connectors.map((c) => c.id)).toEqual([...BUILTIN_IDS, "custom-dup"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: "custom-dup" });
  });

  it("an invalid def is dropped with its validation reason; builtins survive", () => {
    const path = tempCustomPath();
    saveCustomConnectors([def("custom-bad", { watchGlobs: [] })], path);
    const { connectors, dropped } = loadRegistry("/fake/home", { customPath: path });
    expect(connectors.map((c) => c.id)).toEqual(BUILTIN_IDS);
    expect(dropped[0]).toMatchObject({ id: "custom-bad" });
    expect(dropped[0]?.reason).toMatch(/watchGlobs/);
  });

  it("a null / non-object entry in connectors[] is dropped, never crashes (D4 tolerance)", () => {
    // saveCustomConnectors can't emit these — write the raw JSON a hand-edited config might contain.
    const path = tempCustomPath();
    writeFileSync(
      path,
      JSON.stringify({ version: "m10-custom-v1", connectors: [null, 42, "oops", def("custom-ok")] }),
    );
    let result!: ReturnType<typeof loadRegistry>;
    expect(() => {
      result = loadRegistry("/fake/home", { customPath: path });
    }).not.toThrow();
    // The one valid def still loads; the three junk entries are dropped as "(unknown)".
    expect(result.connectors.map((c) => c.id)).toEqual([...BUILTIN_IDS, "custom-ok"]);
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped.every((d) => d.id === "(unknown)")).toBe(true);
  });
});
