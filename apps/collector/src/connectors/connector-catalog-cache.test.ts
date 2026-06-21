import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { canonicalizeCatalog, type ConnectorCatalogPayload } from "@420ai/shared";
import {
  loadCachedConnectorCatalog,
  saveCachedConnectorCatalog,
  fetchActiveConnectorCatalog,
  type SignedConnectorCatalog,
} from "./connector-catalog-cache.js";

// Ephemeral signing key (the bundled private key is offline-only). The cache/fetch
// verify against the public half, injected via the `publicKeyPem` seam.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const PAYLOAD: ConnectorCatalogPayload = {
  connectors: [{ id: "claude-code", watchGlobs: ["/new/*.jsonl"] }],
};

function signed(version = "v1", payload = PAYLOAD): SignedConnectorCatalog {
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalizeCatalog({ version, payload }), "utf8"),
    PRIV,
  ).toString("base64");
  return { version, payload, signature };
}

function tempCachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "catalog-cache-")), "connector-catalog.json");
}

describe("connector-catalog cache load/save", () => {
  it("absent file ⇒ undefined", () => {
    expect(loadCachedConnectorCatalog(tempCachePath(), PUB)).toBeUndefined();
  });

  it("round-trips a verified signed catalog (0o600 write)", () => {
    const path = tempCachePath();
    const cat = signed();
    saveCachedConnectorCatalog(cat, path);
    expect(existsSync(path)).toBe(true);
    const loaded = loadCachedConnectorCatalog(path, PUB);
    expect(loaded).toEqual(cat);
  });

  it("a corrupt (non-JSON) cache ⇒ undefined, never throws", () => {
    const path = tempCachePath();
    writeFileSync(path, "{not json");
    expect(loadCachedConnectorCatalog(path, PUB)).toBeUndefined();
  });

  it("a tampered payload (signature no longer matches) ⇒ undefined (ignored)", () => {
    const path = tempCachePath();
    const cat = signed();
    // Tamper the payload AFTER signing — the stored signature no longer verifies.
    const tampered = {
      ...cat,
      payload: { connectors: [{ id: "claude-code", watchGlobs: ["/evil/**"] }] },
    };
    writeFileSync(path, JSON.stringify(tampered));
    expect(loadCachedConnectorCatalog(path, PUB)).toBeUndefined();
  });

  it("a wrong (other) signing key ⇒ undefined", () => {
    const path = tempCachePath();
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    saveCachedConnectorCatalog(signed(), path);
    expect(loadCachedConnectorCatalog(path, other)).toBeUndefined();
  });
});

describe("fetchActiveConnectorCatalog", () => {
  const baseUrl = "http://localhost:8420";
  const token = "machine-token";

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("a verified 200 ⇒ the signed catalog", async () => {
    const cat = signed();
    const fakeFetch = (async () => jsonResponse(cat)) as unknown as typeof fetch;
    const got = await fetchActiveConnectorCatalog({
      baseUrl,
      token,
      fetch: fakeFetch,
      publicKeyPem: PUB,
    });
    expect(got).toEqual(cat);
  });

  it("a 204 (no active catalog) ⇒ undefined", async () => {
    const fakeFetch = (async () => jsonResponse(null, 204)) as unknown as typeof fetch;
    expect(
      await fetchActiveConnectorCatalog({ baseUrl, token, fetch: fakeFetch, publicKeyPem: PUB }),
    ).toBeUndefined();
  });

  it("a network error ⇒ undefined (offline, non-fatal)", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await fetchActiveConnectorCatalog({ baseUrl, token, fetch: fakeFetch, publicKeyPem: PUB }),
    ).toBeUndefined();
  });

  it("a 200 whose signature does NOT verify ⇒ undefined (defense-in-depth)", async () => {
    const bad = { ...signed(), signature: "AAAAnot-a-valid-signature" };
    const fakeFetch = (async () => jsonResponse(bad)) as unknown as typeof fetch;
    expect(
      await fetchActiveConnectorCatalog({ baseUrl, token, fetch: fakeFetch, publicKeyPem: PUB }),
    ).toBeUndefined();
  });

  it("a 401/500 ⇒ undefined", async () => {
    const f401 = (async () =>
      jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    expect(
      await fetchActiveConnectorCatalog({ baseUrl, token, fetch: f401, publicKeyPem: PUB }),
    ).toBeUndefined();
  });

  it("a HUNG request is aborted after timeoutMs ⇒ undefined (offline-first, not blocked)", async () => {
    // The fetch never resolves on its own — it only settles when the injected timeout
    // AbortSignal fires, proving the startup pull can't hang capture indefinitely.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const got = await fetchActiveConnectorCatalog({
      baseUrl,
      token,
      fetch: hangingFetch,
      publicKeyPem: PUB,
      timeoutMs: 50,
    });
    expect(got).toBeUndefined();
  });
});
