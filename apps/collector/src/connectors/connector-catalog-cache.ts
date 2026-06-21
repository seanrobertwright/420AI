import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  verifyCatalogSignature,
  CONNECTOR_CATALOG_PUBLIC_KEY,
  type ConnectorCatalogPayload,
} from "@420ai/shared";
import { COLLECTOR_HOME } from "../identity.js";

/**
 * M12 12.7c signed connector-catalog cache + pull (PRD §10.4).
 *
 * `~/.420ai/connector-catalog.json` holds the LAST signed catalog the collector pulled
 * from `GET /v1/connector-catalog/active`, so a later OFFLINE start still overlays the
 * approved catalog instead of regressing to the bundled baseline. It sits ALONGSIDE the
 * registry (it is consumed by `loadRegistry`'s overlay), never inside the capture core.
 *
 * Library file (CLAUDE.md): it mirrors `connector-config.ts` — tolerant reads (absent/
 * corrupt ⇒ `undefined`, never a throw), a `path` testability seam, a `mode:0o600`
 * write, an injectable `fetch`. It NEVER logs or exits.
 *
 * DEFENSE-IN-DEPTH: even though the server only serves APPROVED catalogs over an authed
 * channel, the collector RE-VERIFIES the ed25519 signature (against the bundled key) both
 * when caching a freshly-pulled catalog AND when loading the cache file — a tampered local
 * cache file is ignored, and capture falls back to the bundled baseline. Offline-first: a
 * failed pull is non-fatal (use the cache, then the baseline) — capture must never block.
 */

/** The on-disk + on-the-wire signed shape (the active endpoint returns exactly this). */
export interface SignedConnectorCatalog {
  version: string;
  payload: ConnectorCatalogPayload;
  signature: string;
}

/** Where the pulled signed catalog is cached (testability seam: the optional `path`). */
export const CONNECTOR_CATALOG_CACHE_PATH = join(COLLECTOR_HOME, "connector-catalog.json");

/** Narrow an unknown JSON value to a SignedConnectorCatalog (shape-only, pre-verify). */
function isSignedCatalog(v: unknown): v is SignedConnectorCatalog {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === "string" &&
    typeof o.signature === "string" &&
    typeof o.payload === "object" &&
    o.payload !== null &&
    Array.isArray((o.payload as { connectors?: unknown }).connectors)
  );
}

/**
 * Load the cached signed catalog, returning `undefined` when the file is absent, corrupt,
 * mis-shaped, OR FAILS signature verification (a tampered cache is ignored). Never throws.
 * `publicKeyPem` is injectable for tests; production uses the bundled connector-catalog key.
 */
export function loadCachedConnectorCatalog(
  path = CONNECTOR_CATALOG_CACHE_PATH,
  publicKeyPem: string = CONNECTOR_CATALOG_PUBLIC_KEY,
): SignedConnectorCatalog | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isSignedCatalog(parsed)) return undefined;
    if (
      !verifyCatalogSignature(
        { version: parsed.version, payload: parsed.payload },
        parsed.signature,
        publicKeyPem,
      )
    ) {
      return undefined; // tampered/unsigned cache → ignored (baseline used)
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Persist the signed catalog (mkdir + owner-only write, like `saveConnectorConfig`). */
export function saveCachedConnectorCatalog(
  catalog: SignedConnectorCatalog,
  path = CONNECTOR_CATALOG_CACHE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600 });
}

/** Trim trailing slashes from a base URL (mirrors ingest-client.trimUrl). */
function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Best-effort pull of the active signed connector catalog (machine-authed). Returns the
 * signed catalog on a verified 200, or `undefined` on 204 (none active), any non-2xx, a
 * network error, a mis-shaped body, or a FAILED signature verify. NEVER throws — the
 * caller (entrypoint) treats `undefined` as "use the cache, then the baseline". `fetch`
 * and `publicKeyPem` are injectable for tests.
 *
 * A `timeoutMs` (default 5000) bounds the request via `AbortSignal.timeout`: `runWatch`
 * AWAITS this before capture starts, so a HUNG connection (a silent firewall drop, a
 * server that accepts but never replies) must not block startup indefinitely — the abort
 * surfaces as a caught error → `undefined` → baseline, preserving the offline-first
 * guarantee even when the failure is a hang rather than a refusal.
 */
export async function fetchActiveConnectorCatalog(opts: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  publicKeyPem?: string;
  timeoutMs?: number;
}): Promise<SignedConnectorCatalog | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const publicKeyPem = opts.publicKeyPem ?? CONNECTOR_CATALOG_PUBLIC_KEY;
  let res: Response;
  try {
    res = await doFetch(`${trimUrl(opts.baseUrl)}/v1/connector-catalog/active`, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch {
    return undefined; // offline / network error / timeout — non-fatal
  }
  if (res.status === 204 || !res.ok) return undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  if (!isSignedCatalog(body)) return undefined;
  if (
    !verifyCatalogSignature(
      { version: body.version, payload: body.payload },
      body.signature,
      publicKeyPem,
    )
  ) {
    return undefined; // server served something unverifiable → ignore (defense-in-depth)
  }
  return body;
}
