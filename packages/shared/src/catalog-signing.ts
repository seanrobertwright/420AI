import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import type { ModelPricing } from "./pricing.js";

/**
 * M10 3d signed pricing-catalog trust primitive (PRD §10.4/§18/§20/§23).
 *
 * A catalog update is delivered as a detached **ed25519** signature over a
 * RECURSIVE canonical serialization of `{version, payload}`. The server verifies
 * it (against a BUNDLED public key) before storing the update `pending`, and an
 * admin must approve it before it ever re-prices an ingest. The matching private
 * key is generated once, kept OFFLINE (gitignored `.secrets/`), and used only by
 * the offline `scripts/sign-catalog.ts` — it NEVER enters the repo or the runtime.
 *
 * Pure + dependency-free (`@420ai/shared` invariant): `node:crypto` only, exactly
 * like fingerprint.ts. The signer and the verifier import the SAME
 * `canonicalizeCatalog` (D5) so the signed/verified bytes can never drift.
 */

/**
 * The signed-catalog wire shape: the self-declared `version`, the `payload`, and a
 * base64 detached ed25519 `signature` over `canonicalizeCatalog({version, payload})`.
 *
 * GENERIC over the payload (M12 12.7c): the default `P = Record<string, ModelPricing>`
 * keeps every existing pricing call site (`SignedCatalog` with no type arg) byte- and
 * type-identical, while the connector catalog reuses the SAME signer with
 * `SignedCatalog<ConnectorCatalogPayload>`. `canon` is already payload-agnostic, so
 * the signed bytes are a pure function of the value — one trust primitive, two payloads.
 */
export interface SignedCatalog<P = Record<string, ModelPricing>> {
  version: string;
  payload: P;
  signature: string;
}

/** The signed content (everything the signature covers — i.e. SignedCatalog minus `signature`). */
export interface CatalogContent<P = Record<string, ModelPricing>> {
  version: string;
  payload: P;
}

/**
 * Recursive, key-sorted canonical serialization (D5). Sorting keys at EVERY level
 * makes the byte stream a pure function of the VALUE, not its key-insertion order —
 * so a signature made by the offline signer verifies for a differently-ordered
 * received object (spike-proven). A shallow top-level sort would break on the nested
 * `payload` model→rates map. BOTH signer and verifier call this one function.
 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

/** Canonicalize the signed content into the exact bytes the signature covers. */
export function canonicalizeCatalog<P>(content: CatalogContent<P>): string {
  return canon(content);
}

/**
 * The BUNDLED ed25519 public key (the §10.4 trust anchor). Verification defaults to
 * this in production; integration tests inject an ephemeral key via
 * `buildApp({ catalogPublicKey })`. The matching private key is offline-only.
 */
export const CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK98ppeFaQDaKPHNbcNWr6iKLB134hRAURa+Osz4QGcA=
-----END PUBLIC KEY-----
`;

/**
 * Verify a detached ed25519 signature over `canonicalizeCatalog(content)`. Returns
 * `false` (never throws) on a tampered payload, a wrong key, or a malformed key/
 * signature — so a bad upload is a clean 400, never a 500. Ed25519 REQUIRES the
 * digest algorithm be `null` in `crypto.verify` (passing a hash name throws).
 */
export function verifyCatalogSignature<P>(
  content: CatalogContent<P>,
  signatureB64: string,
  publicKeyPem: string = CATALOG_PUBLIC_KEY,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalizeCatalog(content), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false; // malformed key/sig → not verified, never throw
  }
}
