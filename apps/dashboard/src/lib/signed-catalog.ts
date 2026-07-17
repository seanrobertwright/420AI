/**
 * Client-side pre-parse of a signed catalog document (M14 14.2). The upload form accepts the
 * JSON bundle `scripts/sign-catalog.ts` writes (`{version, payload, signature}`) via paste or
 * file pick; this validates the SHAPE before POSTing so obvious garbage gets an instant local
 * error. It deliberately does NOT verify the ed25519 signature — ingest is the integrity gate
 * (`POST /v1/catalog` → 400 on a bad signature) and the public key stays server-side.
 *
 * Pure + dependency-free so it is unit-testable (mirrors `snippet.ts`).
 */

/** The offline-signed upload bundle (matches ingest's `catalogUploadBodySchema`). */
export interface SignedCatalogDoc {
  version: string;
  payload: Record<string, unknown>;
  signature: string;
}

export type ParseSignedCatalogResult =
  | { ok: true; doc: SignedCatalogDoc }
  | { ok: false; error: string };

/** True for a plain object (the schema's `type:"object"` — arrays and null excluded). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse pasted/file text into a `SignedCatalogDoc`, or a human-readable error. Mirrors the
 * required fields of ingest's `catalogUploadBodySchema` (version/signature non-empty strings,
 * payload a plain object); extra keys are left for the server schema to reject.
 */
export function parseSignedCatalogText(text: string): ParseSignedCatalogResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Paste or select a signed catalog document." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "Expected a JSON object." };

  const { version, payload, signature } = parsed;
  if (typeof version !== "string" || version === "") {
    return { ok: false, error: "Missing or empty “version”." };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: "Missing “payload” (must be a JSON object)." };
  }
  if (typeof signature !== "string" || signature === "") {
    return { ok: false, error: "Missing or empty “signature”." };
  }
  return { ok: true, doc: { version, payload, signature } };
}
