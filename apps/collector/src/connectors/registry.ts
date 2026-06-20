import { connectors as defaultConnectors, type Connector } from "./connector.js";
import {
  loadCustomConnectors,
  makeCustomConnector,
  validateCustomDef,
} from "./custom-connector.js";

/**
 * The single merge point (D5): the built-in registry plus every VALID, non-colliding
 * custom connector compiled from `~/.420ai/custom-connectors.json`. Used by
 * `runWatch`, `runDiscover`, and `runServe` so `filterConnectors`,
 * `connectors.list`/`connectors.set`, the watcher, and sync all work for free —
 * the M3/M4 capture core is untouched.
 *
 * Library file (CLAUDE.md process boundaries): it NEVER logs. It RETURNS the merged
 * registry AND the dropped-def reasons so the entrypoint (cli/serve) can surface
 * them. Default-on safety: an invalid or id-colliding def is DROPPED with a reason,
 * never fatal — the built-ins keep capturing.
 */
export interface RegistryResult {
  connectors: Connector[];
  /** Custom defs that were skipped, with a human-readable reason (entrypoint surfaces these). */
  dropped: { id: string; reason: string }[];
}

/**
 * Build the merged connector registry. `home` is accepted for call-site symmetry
 * with the rest of the capture core but is not consulted here — custom connectors
 * return absolute `watchGlobs` (they ignore `home`), and built-ins resolve `home`
 * later, at watch time. `opts.customPath` is the testability seam for the config file.
 */
export function loadRegistry(home: string, opts?: { customPath?: string }): RegistryResult {
  void home;
  const connectors: Connector[] = [...defaultConnectors];
  const dropped: { id: string; reason: string }[] = [];
  const seenIds = new Set(defaultConnectors.map((c) => c.id));

  for (const raw of loadCustomConnectors(opts?.customPath)) {
    const result = validateCustomDef(raw);
    if ("error" in result) {
      // `raw` may be ANY parseable JSON value here (incl. null / a number / a string
      // for a malformed `connectors[]` entry) — extract the id defensively so building
      // the drop reason can never throw and take down capture of the built-ins (D4).
      const id =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? (raw as { id: string }).id
          : "(unknown)";
      dropped.push({ id, reason: result.error });
      continue;
    }
    const def = result.ok;
    if (seenIds.has(def.id)) {
      dropped.push({ id: def.id, reason: `id collides with an existing connector (first wins)` });
      continue;
    }
    seenIds.add(def.id);
    connectors.push(makeCustomConnector(def));
  }

  return { connectors, dropped };
}
