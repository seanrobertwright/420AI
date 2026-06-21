import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, createPublicKey } from "node:crypto";
import {
  canonicalizeCatalog,
  verifyCatalogSignature,
  CATALOG_PUBLIC_KEY,
  type CatalogContent,
} from "./catalog-signing.js";
import type { ModelPricing } from "./pricing.js";

function rate(over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    input: 1e-6,
    output: 2e-6,
    cache_read: 0,
    cache_write: 0,
    sourceUrl: "x",
    asOf: "2026-06-13",
    ...over,
  };
}

const content: CatalogContent = {
  version: "m10-catalog-v2",
  payload: { "claude-opus-4-8": rate({ input: 5e-6, output: 25e-6 }) },
};

/** Sign canonicalized content with a private key → base64 detached ed25519 (mirrors the offline signer). */
function signWith(privatePem: string, c: CatalogContent): string {
  return cryptoSign(null, Buffer.from(canonicalizeCatalog(c), "utf8"), privatePem).toString(
    "base64",
  );
}

describe("canonicalizeCatalog", () => {
  it("is stable across key-insertion order at every level", () => {
    const a: CatalogContent = {
      version: "v1",
      payload: { b: rate({ input: 1, output: 2 }), a: rate({ output: 4, input: 3 }) },
    };
    // Same values, keys inserted in a different order (top-level + nested).
    const b: CatalogContent = {
      payload: { a: rate({ input: 3, output: 4 }), b: rate({ output: 2, input: 1 }) },
      version: "v1",
    };
    expect(canonicalizeCatalog(a)).toBe(canonicalizeCatalog(b));
  });

  it("changes when a nested rate changes", () => {
    const a = canonicalizeCatalog(content);
    const b = canonicalizeCatalog({
      ...content,
      payload: { "claude-opus-4-8": rate({ input: 5e-6, output: 99e-6 }) },
    });
    expect(a).not.toBe(b);
  });
});

describe("verifyCatalogSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("a signature made by the matching private key verifies (even for a re-ordered received object)", () => {
    const sig = signWith(privPem, content);
    // Receive the same content with keys in a different order — canonicalization makes it verify.
    const received: CatalogContent = {
      payload: { "claude-opus-4-8": rate({ output: 25e-6, input: 5e-6 }) },
      version: "m10-catalog-v2",
    };
    expect(verifyCatalogSignature(received, sig, pubPem)).toBe(true);
  });

  it("a tampered nested rate → false", () => {
    const sig = signWith(privPem, content);
    const tampered: CatalogContent = {
      ...content,
      payload: { "claude-opus-4-8": rate({ input: 5e-6, output: 999e-6 }) },
    };
    expect(verifyCatalogSignature(tampered, sig, pubPem)).toBe(false);
  });

  it("a wrong (other) key → false", () => {
    const sig = signWith(privPem, content);
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(verifyCatalogSignature(content, sig, other)).toBe(false);
  });

  it("a malformed signature → false (no throw)", () => {
    expect(verifyCatalogSignature(content, "not-base64-!!!", pubPem)).toBe(false);
  });

  it("a malformed public key → false (no throw)", () => {
    expect(verifyCatalogSignature(content, signWith(privPem, content), "not a pem")).toBe(false);
  });
});

describe("CATALOG_PUBLIC_KEY", () => {
  it("is a valid bundled ed25519 public key (parses without the private key)", () => {
    expect(CATALOG_PUBLIC_KEY.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(() => createPublicKey(CATALOG_PUBLIC_KEY)).not.toThrow();
  });
});
