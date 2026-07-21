import type { EventType } from "./events.js";

/**
 * M12 12.7c signed CONNECTOR catalog (PRD §10.4). The connector catalog is DATA,
 * exactly like the M10 3d pricing catalog: a signed `{version, payload}` document an
 * admin approves, that updates connector METADATA + LOCATIONS without an app release.
 *
 * Decision A (resolved — PRD §39): parsers stay CODE. The catalog overlays
 * locations/fidelity/permissions/active onto code-keyed connectors BY ID; an entry
 * with no built-in id is compiled by the SAME custom-connector factory the M10-S2
 * config-only path uses (the sanctioned "connector as data" channel). No plugin/script
 * runtime is introduced.
 *
 * Distribution (decision B): server-canonical (admin-approved, dashboard-reviewable
 * like pricing) + collector-pull (`GET /v1/connector-catalog/active`) + local cache +
 * this bundled BASELINE as the floor. With NO active catalog the registry is
 * byte-identical to today (default-on, mirroring pricing's "no active ⇒ bundled").
 *
 * Pure + dependency-free (`@420ai/shared` leaf invariant). The signing primitive is
 * the SAME generic `catalog-signing.ts` the pricing catalog uses — one trust anchor,
 * two payloads (the bundled key below is the connector-catalog ed25519 anchor; the
 * private half is offline-only in gitignored `.secrets/`, like the pricing key).
 */

/** §10.1.1 liveness vocabulary — mirrored 1:1 from the collector's `ConnectorFidelity`
 * (leaf can't import `apps/collector`; the same mirroring `ConnectorInfo` uses). */
export type ConnectorCatalogLiveness = "streaming" | "near-real-time" | "snapshot" | "batch";

/**
 * The catalog-overridable subset of a connector's `ConnectorFidelity` (connector.ts).
 * Mirrored field-for-field so the collector's real fidelity is structurally
 * assignable. Every field is OPTIONAL on an entry — only the provided fields overlay.
 */
export interface ConnectorFidelityOverlay {
  status?: "stable" | "experimental" | "planned";
  captureMethod?: string;
  liveness?: ConnectorCatalogLiveness;
  tokens?: "exact" | "estimated" | "none";
  cost?: "reported" | "computed" | "none";
  knownGaps?: string[];
  /** §10.3 declared capture scope (12.7b coupling). A change here flows through
   * `captureSurfaceFingerprint` ⇒ the connector flips to `needs-approval` (§10.4). */
  requiredPermissions?: string[];
  testedVersions?: string[];
}

/**
 * A data-only custom-connector declaration carried INSIDE a signed catalog entry —
 * the same shape as a `~/.420ai/custom-connectors.json` def (collector's
 * `CustomConnectorDef`), mirrored here so the leaf can type the signed payload. The
 * collector re-validates it through `validateCustomDef` before compiling (the catalog
 * is signed, but the factory still screens the def — defense-in-depth).
 */
export interface ConnectorCatalogCustomDef {
  id: string;
  displayName?: string;
  watchGlobs: string[];
  format: "jsonl" | "regex";
  pattern?: string;
  tsField?: string;
  sessionIdField?: string;
  projectPathField?: string;
  modelField?: string;
  eventTypeField?: string;
  eventType?: EventType;
  tokenMap?: { input?: string; output?: string; cache_read?: string; cache_write?: string };
}

/**
 * One catalog entry: a metadata/location overlay keyed by connector `id`. For a
 * built-in id, the provided fields overlay onto the code-resident connector (its
 * PARSER stays code). For an unknown id carrying a `def`, the def is compiled via the
 * custom-connector factory. `enabled:false` removes the connector from the registry
 * (a catalog-level disable — a capture-surface REDUCTION, so it needs no approval).
 */
export interface ConnectorCatalogEntry {
  /** Connector id this entry overlays/creates (e.g. "claude-code", "custom-mytool"). */
  id: string;
  /** Human label carried for audit/review (signed metadata; the registry keys by id). */
  displayName?: string;
  /** Override the watch locations (absolute globs). A WIDENING flips the §10.4
   * capture-surface fingerprint → `needs-approval` until the user approves (12.7b). */
  watchGlobs?: string[];
  /** Overlay onto the connector's fidelity — only the provided fields override. */
  fidelity?: ConnectorFidelityOverlay;
  /** Override how the watcher reads the source (tail vs snapshot; poll/push are engine-driven). */
  captureMode?: "tail" | "snapshot" | "poll" | "push";
  /** false ⇒ drop the connector from the registry (catalog-level disable). Default true. */
  enabled?: boolean;
  /** A data-only custom connector (no built-in parser) compiled via the factory. */
  def?: ConnectorCatalogCustomDef;
}

/** The signed connector-catalog payload — the array of per-connector overlays/defs. */
export interface ConnectorCatalogPayload {
  connectors: ConnectorCatalogEntry[];
}

/**
 * The BUNDLED ed25519 public key for connector-catalog signature verify (the §10.4
 * trust anchor, sibling of `CATALOG_PUBLIC_KEY`). Verification defaults to this in
 * production; integration tests inject an ephemeral key via
 * `buildApp({ connectorCatalogPublicKey })`. The matching private key is offline-only
 * (gitignored `.secrets/connector-catalog-private-key.pem`).
 */
export const CONNECTOR_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5HyWfO21tnpo+BYB8MNdtAisXmlsEkD6uAN0hPKaszM=
-----END PUBLIC KEY-----
`;

/** Stamps the connector-catalog wire shape (sibling of PRICING_CATALOG_VERSION). */
export const CONNECTOR_CATALOG_VERSION = "m12-connector-catalog-v1" as const;

/**
 * The bundled BASELINE — the three built-in connectors' static fidelity metadata as
 * DATA (the §10.4 floor). It is NOT auto-applied: with no active catalog the registry
 * is byte-identical to today (the built-in connector OBJECTS are the source of truth,
 * and applying an overlay that restated their home-relative `watchGlobs` would change
 * the resolved scope). The baseline exists as the offline signer's starting template
 * and the documented "metadata as data" snapshot; a test pins its ids to the built-ins.
 *
 * `watchGlobs` are intentionally OMITTED (they are home-resolved in code); an operator
 * who wants to move a watch location adds `watchGlobs` to a NEW signed entry.
 */
export const CONNECTOR_CATALOG_BASELINE: ConnectorCatalogPayload = {
  connectors: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      enabled: true,
      fidelity: {
        status: "stable",
        captureMethod: "tail-jsonl",
        liveness: "streaming",
        tokens: "exact",
        cost: "computed",
        requiredPermissions: [
          "Read Claude Code session transcripts under ~/.claude/projects/*/*.jsonl",
        ],
      },
    },
    {
      id: "codex-cli",
      displayName: "OpenAI Codex CLI",
      enabled: true,
      fidelity: {
        status: "stable",
        captureMethod: "tail-jsonl",
        liveness: "streaming",
        tokens: "exact",
        cost: "computed",
        requiredPermissions: [
          "Read OpenAI Codex CLI rollout logs under ~/.codex/sessions/*/*/*/rollout-*.jsonl",
        ],
      },
    },
    {
      id: "gemini-cli",
      displayName: "Gemini CLI",
      enabled: true,
      fidelity: {
        status: "stable",
        captureMethod: "watch-diff-json",
        liveness: "near-real-time",
        tokens: "exact",
        cost: "computed",
        requiredPermissions: [
          "Read Gemini CLI session files under ~/.gemini/tmp/*/chats/session-*.json",
          "Read ~/.gemini/tmp/*/.project_root sidecars for project attribution (discovery)",
        ],
      },
    },
  ],
};

/**
 * The minimal connector shape `mergeConnectorCatalog` operates on — the leaf-side
 * structural mirror of the collector's `Connector` (which is assignable to it). The
 * merge spreads `...base` onto each overlay so a real connector's `parse`/
 * `discoverRoots` (and any other field) are PRESERVED untouched — only
 * metadata/locations/fidelity are overlaid (decision A: parsers stay code).
 */
export interface ConnectorLike {
  id: string;
  captureMode?: "tail" | "snapshot" | "poll" | "push";
  fidelity: {
    status: "stable" | "experimental" | "planned";
    captureMethod: string;
    liveness: ConnectorCatalogLiveness;
    tokens: "exact" | "estimated" | "none";
    cost: "reported" | "computed" | "none";
    knownGaps: string[];
    requiredPermissions: string[];
    testedVersions?: string[];
  };
  watchGlobs(home: string): string[];
}

/** The merge outcome: the overlaid registry + the dropped entries with reasons
 * (folded into the collector's existing `RegistryResult.dropped`). */
export interface ConnectorCatalogMergeResult<C> {
  connectors: C[];
  dropped: { id: string; reason: string }[];
}

/**
 * Overlay an approved connector catalog onto an already-assembled registry.
 *
 * Decision A: parsers stay code — for a matching id, only locations/fidelity/
 * permissions/captureMode/active are overlaid (the base connector's `parse` etc. are
 * preserved via spread). An entry whose id has no base connector AND carries a `def`
 * is compiled via the injected `compileCustom` (the custom-connector factory, which
 * lives in the collector — the leaf cannot import it). An unknown id with no `def` is
 * dropped with a reason. `enabled:false` drops a matching connector (catalog disable).
 *
 * NO catalog (`undefined`) ⇒ the registry is returned UNCHANGED (baseline == today —
 * the regression guarantee). Pure: no fs, no crypto, no logging.
 */
export function mergeConnectorCatalog<C extends ConnectorLike>(
  registry: C[],
  catalog: ConnectorCatalogPayload | undefined,
  compileCustom: (def: ConnectorCatalogCustomDef) => C | { error: string },
): ConnectorCatalogMergeResult<C> {
  if (!catalog) return { connectors: [...registry], dropped: [] };

  const byId = new Map(catalog.connectors.map((e) => [e.id, e]));
  const dropped: { id: string; reason: string }[] = [];
  const connectors: C[] = [];

  // (1) Overlay onto the existing registry IN ORDER (built-ins + local customs). A
  //     matching entry overlays metadata/locations; `enabled:false` drops it.
  for (const base of registry) {
    const entry = byId.get(base.id);
    if (!entry) {
      connectors.push(base);
      continue;
    }
    if (entry.enabled === false) {
      dropped.push({ id: base.id, reason: "disabled by connector catalog" });
      continue;
    }
    connectors.push(applyOverlay(base, entry));
  }

  // (2) Append data-only entries whose id is NOT already in the registry. Decision A:
  //     these are the signed "connector as data" connectors (no built-in parser).
  const seen = new Set(registry.map((c) => c.id));
  for (const entry of catalog.connectors) {
    if (seen.has(entry.id)) continue; // already overlaid above (built-in/local)
    if (entry.enabled === false) continue; // a disabled, non-existent connector is a no-op
    if (!entry.def) {
      dropped.push({
        id: entry.id,
        reason: "catalog entry has no built-in connector and no custom def",
      });
      continue;
    }
    const compiled = compileCustom(entry.def);
    if ("error" in compiled) {
      dropped.push({ id: entry.id, reason: compiled.error });
      continue;
    }
    seen.add(entry.id);
    connectors.push(applyOverlay(compiled, entry));
  }

  return { connectors, dropped };
}

/**
 * Apply one entry's overlay onto a connector, PRESERVING every other field (parse,
 * discoverRoots, …) via spread. Only locations/fidelity/captureMode are mutated —
 * `watchGlobs` is replaced with a closure returning the catalog globs when provided,
 * and `fidelity` is a shallow merge (provided fields win).
 */
function applyOverlay<C extends ConnectorLike>(base: C, entry: ConnectorCatalogEntry): C {
  const fidelity = entry.fidelity
    ? { ...base.fidelity, ...stripUndefined(entry.fidelity) }
    : base.fidelity;
  return {
    ...base,
    captureMode: entry.captureMode ?? base.captureMode,
    fidelity,
    watchGlobs: entry.watchGlobs ? () => [...entry.watchGlobs!] : base.watchGlobs,
  };
}

/** Drop keys whose value is `undefined` so a partial overlay never clobbers a base
 * field with `undefined` (an absent overlay field must leave the base value intact). */
function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
