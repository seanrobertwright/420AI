import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorCatalogPayload } from "@420ai/shared";
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

  it("no catalog ⇒ the registry is byte-identical to today (regression guard)", () => {
    const path = tempCustomPath();
    const withoutCatalog = loadRegistry("/fake/home", { customPath: path });
    const withUndefinedCatalog = loadRegistry("/fake/home", {
      customPath: path,
      catalog: undefined,
    });
    expect(withUndefinedCatalog.connectors.map((c) => c.id)).toEqual(
      withoutCatalog.connectors.map((c) => c.id),
    );
    expect(withUndefinedCatalog.connectors.map((c) => c.id)).toEqual(BUILTIN_IDS);
  });

  it("a catalog overlays watchGlobs + permissions onto a built-in by id (parser preserved)", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [
        {
          id: "claude-code",
          watchGlobs: ["/override/**/*.jsonl"],
          fidelity: { requiredPermissions: ["Read OVERRIDDEN scope"] },
        },
      ],
    };
    const { connectors } = loadRegistry("/fake/home", {
      customPath: tempCustomPath(),
      catalog,
    });
    const claude = connectors.find((c) => c.id === "claude-code")!;
    expect(claude.watchGlobs("/home")).toEqual(["/override/**/*.jsonl"]);
    expect(claude.fidelity.requiredPermissions).toEqual(["Read OVERRIDDEN scope"]);
    // Decision A: the parser stays code — the overlaid connector still parses.
    expect(typeof claude.parse).toBe("function");
    expect(claude.fidelity.captureMethod).toBe("tail-jsonl"); // untouched field survives
  });

  it("a catalog data-only entry compiles via the custom-connector factory", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [
        {
          id: "catalog-syslog",
          def: {
            id: "catalog-syslog",
            watchGlobs: ["/var/log/app.jsonl"],
            format: "jsonl",
            eventType: "message.user",
          },
        },
      ],
    };
    const { connectors, dropped } = loadRegistry("/fake/home", {
      customPath: tempCustomPath(),
      catalog,
    });
    expect(connectors.map((c) => c.id)).toEqual([...BUILTIN_IDS, "catalog-syslog"]);
    expect(dropped).toEqual([]);
    const syslog = connectors.find((c) => c.id === "catalog-syslog")!;
    expect(syslog.watchGlobs("/home")).toEqual(["/var/log/app.jsonl"]);
    expect(syslog.fidelity.status).toBe("experimental");
  });

  it("a catalog enabled:false drops a built-in (catalog-level disable)", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [{ id: "gemini-cli", enabled: false }],
    };
    const { connectors, dropped } = loadRegistry("/fake/home", {
      customPath: tempCustomPath(),
      catalog,
    });
    expect(connectors.map((c) => c.id)).not.toContain("gemini-cli");
    expect(dropped).toContainEqual({ id: "gemini-cli", reason: "disabled by connector catalog" });
  });

  it("a null / non-object entry in connectors[] is dropped, never crashes (D4 tolerance)", () => {
    // saveCustomConnectors can't emit these — write the raw JSON a hand-edited config might contain.
    const path = tempCustomPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: "m10-custom-v1",
        connectors: [null, 42, "oops", def("custom-ok")],
      }),
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
