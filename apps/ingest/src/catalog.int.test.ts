import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import { canonicalizeCatalog, type CatalogContent, type ModelPricing } from "@420ai/shared";
import type { IngestBatch } from "@420ai/shared";
import { buildApp } from "./app.js";
import { AnalysisProviderError, type AnalysisProvider, type AnalysisRequest } from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in catalog tests", "unavailable");
  },
};

// Ephemeral signing keypair (D4): the test signs with the private half and injects the
// public half into buildApp — the bundled CATALOG_PUBLIC_KEY's private key is NOT in CI.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const EPHEMERAL_PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const EPHEMERAL_PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function rate(over: Partial<ModelPricing> = {}): ModelPricing {
  return { input: 1e-6, output: 2e-6, cache_read: 0, cache_write: 0, sourceUrl: "x", asOf: "2026-06-20", ...over };
}

const CONTENT: CatalogContent = {
  version: "m10-catalog-v2",
  payload: { "claude-opus-4-8": rate({ input: 10e-6, output: 50e-6 }) },
};

function sign(content: CatalogContent): string {
  return cryptoSign(null, Buffer.from(canonicalizeCatalog(content), "utf8"), EPHEMERAL_PRIV).toString("base64");
}

/** A cost-bearing batch (cost.estimated event with cost+tokens+model). */
function costBatch(): IngestBatch {
  return {
    records: [],
    events: [
      {
        fingerprint: "cat-cost",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        catalogVersion: "m10-catalog-v1",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "cost.estimated",
        sessionId: "cat-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:00:00.000Z",
        tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, tool: 0, total: 1000 },
        cost: { usd: 0.005, confidence: "estimated-model-known", model: "claude-opus-4-8" },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("catalog API (HTTP e2e via inject) — M10 3d", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
      catalogPublicKey: EPHEMERAL_PUB,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE pricing_catalogs, alert_firings, machine_heartbeats, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  // --- harness ---

  async function createCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json().code as string;
  }

  async function pair(code: string): Promise<{ token: string; machineId: string }> {
    const res = await app.inject({ method: "POST", url: "/v1/pair", payload: { code, machine: { name: "test-machine" } } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  function adminPost(url: string, payload?: unknown) {
    // A bodyless POST must NOT set content-type:application/json — Fastify's JSON parser
    // 400s on an empty body. The approve/reject routes take no body (mirrors the ack route).
    if (payload === undefined) {
      return app.inject({ method: "POST", url, headers: { authorization: `Bearer ${ADMIN}` } });
    }
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: payload as object,
    });
  }

  function adminGet(url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ADMIN}` } });
  }

  it("rejects an upload with a tampered signature (400) and a missing admin bearer (401)", async () => {
    const good = sign(CONTENT);
    // no admin bearer
    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/catalog",
      headers: { "content-type": "application/json" },
      payload: { ...CONTENT, signature: good },
    });
    expect(noAuth.statusCode).toBe(401);

    // tampered payload, original signature → verify fails → 400
    const tampered = await adminPost("/v1/catalog", {
      version: CONTENT.version,
      payload: { "claude-opus-4-8": rate({ input: 999e-6 }) },
      signature: good,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error).toBe("signature verification failed");
  });

  it("uploads pending → lists → approves → re-prices ingest → §20 alert fires while pending and clears on approval", async () => {
    const { token } = await pair(await createCode()); // also creates the DEFAULT_EMAIL user (for monitor)

    // (1) upload a validly-signed catalog → 200 pending
    const up = await adminPost("/v1/catalog", { ...CONTENT, signature: sign(CONTENT) });
    expect(up.statusCode).toBe(200);
    const id = up.json().id as string;
    expect(up.json().status).toBe("pending");

    // (2) it lists
    const list = await adminGet("/v1/catalog");
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).some((r) => r.id === id)).toBe(true);

    // (3) the §20 alert fires WHILE the catalog is pending
    const monPending = await adminGet("/v1/monitor");
    expect(monPending.statusCode).toBe(200);
    const firingsPending = monPending.json().alertFirings as { code: string; status: string }[];
    const catFiring = firingsPending.find((f) => f.code === "catalog.update_requires_approval");
    expect(catFiring).toBeDefined();
    expect(catFiring!.status).toBe("open");

    // (4) approve → active
    const approve = await adminPost(`/v1/catalog/${id}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("active");

    // (5) after approval, an ingest re-prices the cost-bearing event under the active catalog
    const ing = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: costBatch(),
    });
    expect(ing.statusCode).toBe(200);
    const [{ usd, catalog_version }] = (
      await dbh.db.execute(
        sql`SELECT (cost->>'usd')::float AS usd, catalog_version FROM events WHERE fingerprint = 'cat-cost'`,
      )
    ).rows as { usd: number; catalog_version: string }[];
    expect(usd).toBeCloseTo(0.01, 10); // 1000 × 10e-6 (the approved v2 rate), NOT the wire 0.005
    expect(catalog_version).toBe("m10-catalog-v2");

    // (6) with the pending queue empty, the §20 firing resolves
    const monResolved = await adminGet("/v1/monitor");
    const firingsResolved = monResolved.json().alertFirings as { code: string; status: string }[];
    const cat = firingsResolved.find((f) => f.code === "catalog.update_requires_approval");
    // resolved firings linger briefly as confirmation — assert it is no longer OPEN.
    expect(cat?.status ?? "resolved").toBe("resolved");
  });

  it("approve/reject guard the id: malformed → 404, unknown uuid → 404", async () => {
    expect((await adminPost("/v1/catalog/not-a-uuid/approve")).statusCode).toBe(404);
    expect((await adminPost("/v1/catalog/00000000-0000-4000-8000-000000000000/approve")).statusCode).toBe(404);
    expect((await adminPost("/v1/catalog/not-a-uuid/reject")).statusCode).toBe(404);
  });

  it("rejects a pending catalog", async () => {
    const up = await adminPost("/v1/catalog", { ...CONTENT, signature: sign(CONTENT) });
    const id = up.json().id as string;
    const rej = await adminPost(`/v1/catalog/${id}/reject`);
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe("rejected");
  });
});
