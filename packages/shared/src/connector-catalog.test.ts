import { describe, it, expect } from "vitest";
import { createPublicKey } from "node:crypto";
import {
  mergeConnectorCatalog,
  CONNECTOR_CATALOG_PUBLIC_KEY,
  CONNECTOR_CATALOG_BASELINE,
  type ConnectorLike,
  type ConnectorCatalogPayload,
  type ConnectorCatalogCustomDef,
} from "./connector-catalog.js";

/** A built-in-like connector stub (structurally a `Connector`, plus a marker `parse`). */
function builtin(id: string, globs: string[], extra: Record<string, unknown> = {}): ConnectorLike {
  return {
    id,
    captureMode: "tail",
    fidelity: {
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "computed",
      knownGaps: [],
      requiredPermissions: [`Read ${id} logs`],
    },
    watchGlobs: () => globs,
    ...extra,
  };
}

/** The collector injects a real factory; the test compiles a def into a minimal connector. */
function fakeCompile(def: ConnectorCatalogCustomDef): ConnectorLike | { error: string } {
  if (!def.id) return { error: "missing id" };
  return {
    id: def.id,
    captureMode: "tail",
    fidelity: {
      status: "experimental",
      captureMethod: `custom-tail-${def.format}`,
      liveness: "streaming",
      tokens: "none",
      cost: "none",
      knownGaps: [],
      requiredPermissions: def.watchGlobs.map((g) => `Read user-configured file/log: ${g}`),
    },
    watchGlobs: () => def.watchGlobs,
  };
}

const REGISTRY = [
  builtin("claude-code", ["/home/.claude/projects/*/*.jsonl"]),
  builtin("codex-cli", ["/home/.codex/sessions/*/*/*/rollout-*.jsonl"]),
];

describe("mergeConnectorCatalog", () => {
  it("no catalog ⇒ the registry is returned unchanged (baseline == today)", () => {
    const { connectors, dropped } = mergeConnectorCatalog(REGISTRY, undefined, fakeCompile);
    expect(connectors).toEqual(REGISTRY);
    expect(connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli"]);
    expect(dropped).toEqual([]);
  });

  it("overlays watchGlobs + fidelity onto a built-in by id, preserving other fields", () => {
    const marker = () => "PARSED";
    const reg = [builtin("claude-code", ["/old/*.jsonl"], { parse: marker })];
    const catalog: ConnectorCatalogPayload = {
      connectors: [
        {
          id: "claude-code",
          watchGlobs: ["/new/**/*.jsonl"],
          fidelity: { requiredPermissions: ["Read NEW scope"], status: "experimental" },
        },
      ],
    };
    const { connectors } = mergeConnectorCatalog(reg, catalog, fakeCompile);
    const c = connectors[0]!;
    expect(c.watchGlobs("/home")).toEqual(["/new/**/*.jsonl"]); // location overlaid
    expect(c.fidelity.requiredPermissions).toEqual(["Read NEW scope"]); // permission overlaid
    expect(c.fidelity.status).toBe("experimental");
    expect(c.fidelity.captureMethod).toBe("tail-jsonl"); // untouched field survives the shallow merge
    expect((c as { parse?: unknown }).parse).toBe(marker); // decision A: parser preserved (spread)
  });

  it("a partial fidelity overlay never clobbers an unspecified base field with undefined", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [{ id: "codex-cli", fidelity: { cost: "reported" } }],
    };
    const { connectors } = mergeConnectorCatalog(REGISTRY, catalog, fakeCompile);
    const codex = connectors.find((c) => c.id === "codex-cli")!;
    expect(codex.fidelity.cost).toBe("reported");
    expect(codex.fidelity.tokens).toBe("exact"); // base field preserved
    expect(codex.fidelity.requiredPermissions).toEqual(["Read codex-cli logs"]);
  });

  it("a data-only entry with no built-in id compiles via the injected factory", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [
        {
          id: "custom-tool",
          def: { id: "custom-tool", watchGlobs: ["/var/log/tool.jsonl"], format: "jsonl" },
        },
      ],
    };
    const { connectors, dropped } = mergeConnectorCatalog(REGISTRY, catalog, fakeCompile);
    expect(connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli", "custom-tool"]);
    expect(dropped).toEqual([]);
    const custom = connectors.find((c) => c.id === "custom-tool")!;
    expect(custom.fidelity.requiredPermissions).toEqual([
      "Read user-configured file/log: /var/log/tool.jsonl",
    ]);
  });

  it("an unknown id with no def is dropped with a reason; the built-ins survive", () => {
    const catalog: ConnectorCatalogPayload = { connectors: [{ id: "ghost" }] };
    const { connectors, dropped } = mergeConnectorCatalog(REGISTRY, catalog, fakeCompile);
    expect(connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: "ghost" });
    expect(dropped[0]?.reason).toMatch(/no built-in connector and no custom def/);
  });

  it("enabled:false drops a built-in (catalog-level disable)", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [{ id: "codex-cli", enabled: false }],
    };
    const { connectors, dropped } = mergeConnectorCatalog(REGISTRY, catalog, fakeCompile);
    expect(connectors.map((c) => c.id)).toEqual(["claude-code"]);
    expect(dropped).toMatchObject([{ id: "codex-cli", reason: "disabled by connector catalog" }]);
  });

  it("a data-only entry that fails to compile is dropped with the factory's reason", () => {
    const catalog: ConnectorCatalogPayload = {
      connectors: [{ id: "bad", def: { id: "", watchGlobs: ["/x"], format: "jsonl" } }],
    };
    const { connectors, dropped } = mergeConnectorCatalog(REGISTRY, catalog, fakeCompile);
    expect(connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli"]);
    expect(dropped).toMatchObject([{ id: "bad", reason: "missing id" }]);
  });
});

describe("CONNECTOR_CATALOG_PUBLIC_KEY", () => {
  it("is a valid bundled ed25519 public key (parses without the private key)", () => {
    expect(CONNECTOR_CATALOG_PUBLIC_KEY.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(() => createPublicKey(CONNECTOR_CATALOG_PUBLIC_KEY)).not.toThrow();
  });
});

describe("CONNECTOR_CATALOG_BASELINE", () => {
  it("covers exactly the three built-in connector ids", () => {
    expect(CONNECTOR_CATALOG_BASELINE.connectors.map((e) => e.id)).toEqual([
      "claude-code",
      "codex-cli",
      "gemini-cli",
    ]);
  });

  it("omits watchGlobs (home-resolved in code) and carries each connector's permissions", () => {
    for (const e of CONNECTOR_CATALOG_BASELINE.connectors) {
      expect(e.watchGlobs).toBeUndefined();
      expect(e.fidelity?.requiredPermissions?.length).toBeGreaterThan(0);
    }
  });
});
