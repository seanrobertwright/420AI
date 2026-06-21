import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, ingestBatch, repriceAll } from "../index.js";
import { users, machines } from "../schema.js";
import type { ModelPricing } from "@420ai/shared";
import type { IngestBatch } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;

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

/** The active catalog re-pricing targets: 1000 input × 10e-6 = 0.01. */
const ACTIVE = { version: "v-new", rates: { "claude-opus-4-8": rate({ input: 10e-6 }) } };

const TOKENS = {
  input: 1000,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  tool: 0,
  total: 1000,
};
const WIRE_COST = {
  usd: 0.005,
  confidence: "estimated-model-known" as const,
  model: "claude-opus-4-8",
};

/**
 * Four seeded events (the planning spike, productionized). Seeded via ingestBatch with NO
 * repricing arg, so each lands verbatim:
 *  - a: NULL catalog_version, cost-bearing  → repriced (the IS DISTINCT FROM / NULL trap)
 *  - b: old version, cost-bearing           → repriced
 *  - c: already at the active version       → skipped (idempotent + loop-advance)
 *  - d: usage.reported (tokens, NO cost)    → never gains a cost (shape-preserving)
 */
function seedBatch(): IngestBatch {
  return {
    records: [],
    events: [
      {
        // a — OMIT catalogVersion → stored NULL (pre-replay-metadata capture).
        fingerprint: "rp-a",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "ra",
        eventIndex: 0,
        eventType: "cost.estimated",
        sessionId: "rp-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:00:00.000Z",
        tokens: TOKENS,
        cost: WIRE_COST,
      },
      {
        // b — an old catalog version, cost-bearing.
        fingerprint: "rp-b",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        catalogVersion: "m10-catalog-v1",
        rawRecordId: "rb",
        eventIndex: 1,
        eventType: "cost.estimated",
        sessionId: "rp-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:01:00.000Z",
        tokens: TOKENS,
        cost: WIRE_COST,
      },
      {
        // c — already stamped at the active version → must be left untouched.
        fingerprint: "rp-c",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        catalogVersion: "v-new",
        rawRecordId: "rc",
        eventIndex: 2,
        eventType: "cost.estimated",
        sessionId: "rp-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:02:00.000Z",
        tokens: TOKENS,
        cost: WIRE_COST,
      },
      {
        // d — usage.reported carries tokens but NO cost → re-pricing never adds one.
        fingerprint: "rp-d",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "rd",
        eventIndex: 3,
        eventType: "usage.reported",
        sessionId: "rp-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:03:00.000Z",
        tokens: TOKENS,
      },
    ],
  };
}

interface CostRow {
  fingerprint: string;
  usd: number | null;
  catalog_version: string | null;
}

async function readCosts(db: ReturnType<typeof createDb>["db"]): Promise<Record<string, CostRow>> {
  const rows = (
    await db.execute(
      sql`SELECT fingerprint, (cost->>'usd')::float AS usd, catalog_version FROM events ORDER BY fingerprint`,
    )
  ).rows as unknown as CostRow[];
  return Object.fromEntries(rows.map((r) => [r.fingerprint, r]));
}

describe.skipIf(!TEST_URL)("repriceAll repository (integration) — M12 12.5a", () => {
  let dbh: ReturnType<typeof createDb>;
  let machineId: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
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
    // Seed verbatim (no repricing arg → wire cost/catalogVersion stored as-is).
    await ingestBatch(dbh.db, machineId, seedBatch());
  });

  it("reprices NULL- and old-version cost-bearing rows; skips active; never adds a cost", async () => {
    const result = await repriceAll(dbh.db, ACTIVE);
    expect(result).toEqual({ repriced: 2, catalogVersion: "v-new" });

    const costs = await readCosts(dbh.db);
    // a (NULL catalog_version) and b (old version) recompute to 1000 × 10e-6 = 0.01.
    expect(costs["rp-a"]!.usd).toBeCloseTo(0.01, 10);
    expect(costs["rp-a"]!.catalog_version).toBe("v-new");
    expect(costs["rp-b"]!.usd).toBeCloseTo(0.01, 10);
    expect(costs["rp-b"]!.catalog_version).toBe("v-new");
    // c was already at v-new → untouched (still the wire cost 0.005).
    expect(costs["rp-c"]!.usd).toBeCloseTo(0.005, 10);
    expect(costs["rp-c"]!.catalog_version).toBe("v-new");
    // d (usage.reported) never gains a cost — re-pricing is shape-preserving.
    expect(costs["rp-d"]!.usd).toBeNull();
    expect(costs["rp-d"]!.catalog_version).toBeNull();
  });

  it("is idempotent — a second run under the same catalog reprices 0 rows", async () => {
    await repriceAll(dbh.db, ACTIVE);
    const second = await repriceAll(dbh.db, ACTIVE);
    expect(second).toEqual({ repriced: 0, catalogVersion: "v-new" });
  });
});
