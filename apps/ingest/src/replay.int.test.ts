import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createDb,
  ingestBatch,
  insertPendingCatalog,
  approveCatalog,
  users,
  machines,
} from "@420ai/db";
import type { IngestBatch, ModelPricing } from "@420ai/shared";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// Deterministic stub provider (buildApp requires one; the replay route never calls it).
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("provider is down", "unavailable");
  },
};

function rate(over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    input: 1e-6,
    output: 2e-6,
    cache_read: 0,
    cache_write: 0,
    sourceUrl: "x",
    asOf: "2026-06-20",
    ...over,
  };
}

// The active catalog re-prices opus at 10e-6/input → 1000 input = 0.01 (≠ the wire 0.005).
const CATALOG_PAYLOAD: Record<string, ModelPricing> = { "claude-opus-4-8": rate({ input: 10e-6 }) };

/** A single cost-bearing event (cost+tokens+model) stored verbatim at the wire cost. */
function costBatch(): IngestBatch {
  return {
    records: [],
    events: [
      {
        fingerprint: "rp-route",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        catalogVersion: "m10-catalog-v1",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "cost.estimated",
        sessionId: "rp-route-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:00:00.000Z",
        tokens: {
          input: 1000,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          tool: 0,
          total: 1000,
        },
        cost: { usd: 0.005, confidence: "estimated-model-known", model: "claude-opus-4-8" },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("POST /v1/replay/reprice (integration) — M12 12.5a", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let machineId: string;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
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
      sql`TRUNCATE pricing_catalogs, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId: u!.id, name: "test-machine" })
      .returning({ id: machines.id });
    machineId = m!.id;
  });

  it("requires admin authorization → 401 without a bearer", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/replay/reprice" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 409 when no catalog is active", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/reprice",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no active catalog to re-price under");
  });

  it("re-prices the archive under the active catalog → 200 + cost actually changed", async () => {
    // Seed an active catalog whose rate differs from the wire cost.
    const pending = await insertPendingCatalog(dbh.db, {
      version: "v-new",
      payload: CATALOG_PAYLOAD,
      signature: "sig",
    });
    await approveCatalog(dbh.db, pending.id, "admin", new Date());
    // Ingest a cost-bearing event verbatim (no repricing → wire cost 0.005 stored).
    await ingestBatch(dbh.db, machineId, costBatch());

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/reprice",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repriced: 1, catalogVersion: "v-new" });

    // The event's cost is now the catalog rate (0.01), stamped with the active version.
    const [row] = (
      await dbh.db.execute(
        sql`SELECT (cost->>'usd')::float AS usd, catalog_version FROM events WHERE fingerprint = 'rp-route'`,
      )
    ).rows as unknown as { usd: number; catalog_version: string }[];
    expect(row!.usd).toBeCloseTo(0.01, 10);
    expect(row!.catalog_version).toBe("v-new");
  });
});
