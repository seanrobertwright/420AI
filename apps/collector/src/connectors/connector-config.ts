import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { COLLECTOR_HOME } from "../identity.js";
import type { Connector } from "./connector.js";

/**
 * Per-connector enable/disable persistence (M11 Slice 2).
 *
 * `~/.420ai/connectors.json` records which connectors the user turned OFF. It sits
 * ALONGSIDE the connector registry (`connector.ts`) and the M3/M4 capture core, never
 * inside them: enablement is applied by FILTERING the `connectors[]` array passed into
 * `runCaptureEngine` (it already accepts a `connectors` option), so the registry, the
 * watcher, and the engine are untouched.
 *
 * Library file: it mirrors `identity.ts` — tolerant reads (absent/corrupt ⇒ a safe
 * default, never a throw), a `path` testability seam, and a `mode:0o600` write. It
 * never logs or exits.
 *
 * DEFAULT-ON is load-bearing: a missing file, an unknown id, or a registry connector
 * absent from the config all resolve to ENABLED — so a fresh install and any future
 * new connector keep capturing, matching today's all-enabled `connectors[]`.
 */

/** Stamps the config shape (D11-style sibling of CONTROL_PROTOCOL_VERSION). */
export const CONNECTOR_CONFIG_VERSION = "m11-connectors-v1" as const;

/** Where per-connector enablement is persisted (testability seam: the optional `path`). */
export const CONNECTOR_CONFIG_PATH = join(COLLECTOR_HOME, "connectors.json");

export interface ConnectorConfig {
  /** CONNECTOR_CONFIG_VERSION stamp. */
  version: string;
  /** Keyed by `Connector.id`; a missing id ⇒ enabled (default-on). */
  connectors: Record<string, { enabled: boolean }>;
}

/** The safe default — no overrides, so every connector is enabled. */
function defaultConfig(): ConnectorConfig {
  return { version: CONNECTOR_CONFIG_VERSION, connectors: {} };
}

/**
 * Load the connector config, returning the safe default when the file is absent or
 * corrupt (tolerant, mirroring `loadCredentials`). Never throws.
 */
export function loadConnectorConfig(path = CONNECTOR_CONFIG_PATH): ConnectorConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConnectorConfig>;
    return {
      version: parsed.version ?? CONNECTOR_CONFIG_VERSION,
      connectors: parsed.connectors ?? {},
    };
  } catch {
    return defaultConfig();
  }
}

/** Persist the connector config (mkdir + owner-only write, like `saveCredentials`). */
export function saveConnectorConfig(cfg: ConnectorConfig, path = CONNECTOR_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Filter a connector registry by the persisted config. A connector is kept UNLESS it
 * is explicitly disabled (`cfg.connectors[id].enabled === false`) — so unknown/absent
 * ids stay enabled (default-on).
 */
export function filterConnectors(registry: Connector[], cfg: ConnectorConfig): Connector[] {
  return registry.filter((c) => cfg.connectors[c.id]?.enabled !== false);
}
