import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_CONFIG_VERSION,
  loadConnectorConfig,
  saveConnectorConfig,
  filterConnectors,
  type ConnectorConfig,
} from "./connector-config.js";
import type { Connector } from "./connector.js";

/**
 * Pure config module — exercised with a temp-path seam (never the real ~/.420ai).
 * The load-bearing property is DEFAULT-ON: absent file, unknown id, and a registry
 * connector absent from the config all stay enabled, so a fresh install and any
 * future new connector keep capturing.
 */

/** A minimal fake — `filterConnectors` only reads `id`, so the rest is irrelevant. */
function fakeConnector(id: string): Connector {
  return { id } as Connector;
}

const REGISTRY = [
  fakeConnector("claude-code"),
  fakeConnector("codex-cli"),
  fakeConnector("gemini-cli"),
];

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "conncfg-")), "connectors.json");
}

describe("connector-config", () => {
  it("absent file ⇒ default config; filterConnectors keeps the FULL registry (default-on)", () => {
    const cfg = loadConnectorConfig(tempConfigPath());
    expect(cfg).toEqual({ version: CONNECTOR_CONFIG_VERSION, connectors: {} });
    expect(filterConnectors(REGISTRY, cfg).map((c) => c.id)).toEqual([
      "claude-code",
      "codex-cli",
      "gemini-cli",
    ]);
  });

  it("save → load round-trips", () => {
    const path = tempConfigPath();
    const cfg: ConnectorConfig = {
      version: CONNECTOR_CONFIG_VERSION,
      connectors: { "codex-cli": { enabled: false }, "claude-code": { enabled: true } },
    };
    saveConnectorConfig(cfg, path);
    expect(loadConnectorConfig(path)).toEqual(cfg);
  });

  it("a disabled id is filtered out; everything else stays (default-on)", () => {
    const cfg: ConnectorConfig = {
      version: CONNECTOR_CONFIG_VERSION,
      connectors: { "codex-cli": { enabled: false } },
    };
    expect(filterConnectors(REGISTRY, cfg).map((c) => c.id)).toEqual(["claude-code", "gemini-cli"]);
  });

  it("an unknown id in config does NOT drop a real connector; an absent id stays enabled", () => {
    const cfg: ConnectorConfig = {
      version: CONNECTOR_CONFIG_VERSION,
      // "ghost-cli" isn't in the registry (no crash); "gemini-cli" is absent from config (stays on).
      connectors: { "ghost-cli": { enabled: false }, "claude-code": { enabled: true } },
    };
    expect(filterConnectors(REGISTRY, cfg).map((c) => c.id)).toEqual([
      "claude-code",
      "codex-cli",
      "gemini-cli",
    ]);
  });

  it("corrupt file ⇒ safe default (never throws)", () => {
    const path = tempConfigPath();
    writeFileSync(path, "{ this is not valid json");
    expect(loadConnectorConfig(path)).toEqual({
      version: CONNECTOR_CONFIG_VERSION,
      connectors: {},
    });
  });
});
