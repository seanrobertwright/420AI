import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  insertPendingCatalog,
  getActiveCatalog,
  listCatalogs,
  approveCatalog,
  rejectCatalog,
  countPendingCatalogs,
  ingestBatch,
} from "../index.js";
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

const PAYLOAD_V2: Record<string, ModelPricing> = {
  "claude-opus-4-8": rate({ input: 10e-6, output: 50e-6 }),
};

/** A cost-bearing batch (cost.estimated event with cost+tokens+model — the re-priceable shape). */
function costBatch(): IngestBatch {
  return {
    records: [],
    events: [
      {
        fingerprint: "rp-cost",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        catalogVersion: "m10-catalog-v1",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "cost.estimated",
        sessionId: "rp-s1",
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
      {
        // A usage.reported event carries tokens but NO cost → re-pricing never adds one.
        fingerprint: "rp-usage",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r2",
        eventIndex: 1,
        eventType: "usage.reported",
        sessionId: "rp-s1",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:01:00.000Z",
        tokens: {
          input: 500,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          tool: 0,
          total: 500,
        },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("pricing-catalogs repository (integration) — M10 3d", () => {
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
  });

  it("insert pending → not active yet, pending count 1", async () => {
    const row = await insertPendingCatalog(dbh.db, {
      version: "m10-catalog-v2",
      payload: PAYLOAD_V2,
      signature: "sig",
    });
    expect(row.status).toBe("pending");
    expect(row.uploadedAt).toBe(new Date(row.uploadedAt).toISOString()); // ISO-normalized
    expect(row.approvedAt).toBeNull();
    expect(await getActiveCatalog(dbh.db)).toBeUndefined();
    expect(await countPendingCatalogs(dbh.db)).toBe(1);
  });

  it("approve → active, getActiveCatalog returns it, pending count 0", async () => {
    const pending = await insertPendingCatalog(dbh.db, {
      version: "m10-catalog-v2",
      payload: PAYLOAD_V2,
      signature: "sig",
    });
    const approved = await approveCatalog(dbh.db, pending.id, "admin", new Date());
    expect(approved?.status).toBe("active");
    expect(approved?.approvedBy).toBe("admin");
    expect(approved?.approvedAt).not.toBeNull();
    const active = await getActiveCatalog(dbh.db);
    expect(active?.version).toBe("m10-catalog-v2");
    expect(active?.rates["claude-opus-4-8"]?.input).toBe(10e-6);
    expect(await countPendingCatalogs(dbh.db)).toBe(0);
  });

  it("approving a 2nd catalog supersedes the 1st atomically — only ONE active (partial unique held)", async () => {
    const first = await insertPendingCatalog(dbh.db, {
      version: "v-a",
      payload: PAYLOAD_V2,
      signature: "s1",
    });
    await approveCatalog(dbh.db, first.id, "admin", new Date());
    const second = await insertPendingCatalog(dbh.db, {
      version: "v-b",
      payload: { "claude-opus-4-8": rate({ input: 99e-6 }) },
      signature: "s2",
    });
    const promoted = await approveCatalog(dbh.db, second.id, "admin", new Date());
    expect(promoted?.status).toBe("active");

    const rows = await listCatalogs(dbh.db);
    const active = rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.version).toBe("v-b");
    expect(rows.find((r) => r.version === "v-a")!.status).toBe("superseded");
    expect((await getActiveCatalog(dbh.db))?.version).toBe("v-b");
  });

  it("approve is guarded: unknown id, already-active, or rejected id → undefined", async () => {
    expect(
      await approveCatalog(dbh.db, "00000000-0000-4000-8000-000000000000", "admin", new Date()),
    ).toBeUndefined();
    const p = await insertPendingCatalog(dbh.db, {
      version: "v1",
      payload: PAYLOAD_V2,
      signature: "s",
    });
    await approveCatalog(dbh.db, p.id, "admin", new Date());
    // re-approving an already-active row → undefined (not pending)
    expect(await approveCatalog(dbh.db, p.id, "admin", new Date())).toBeUndefined();
  });

  it("reject a pending → rejected; rejecting a non-pending → undefined", async () => {
    const p = await insertPendingCatalog(dbh.db, {
      version: "v1",
      payload: PAYLOAD_V2,
      signature: "s",
    });
    const rejected = await rejectCatalog(dbh.db, p.id, new Date());
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.approvedBy).toBeNull(); // a rejection is distinguishable from an approval
    expect(await rejectCatalog(dbh.db, p.id, new Date())).toBeUndefined();
    expect(await countPendingCatalogs(dbh.db)).toBe(0);
  });

  it("re-uploading the same version is idempotent (same row, no duplicate)", async () => {
    const a = await insertPendingCatalog(dbh.db, {
      version: "dup",
      payload: PAYLOAD_V2,
      signature: "s",
    });
    const b = await insertPendingCatalog(dbh.db, {
      version: "dup",
      payload: PAYLOAD_V2,
      signature: "s",
    });
    expect(b.id).toBe(a.id);
    expect(await listCatalogs(dbh.db)).toHaveLength(1);
  });

  it("ingestBatch re-prices a cost-bearing event under the active catalog (going forward)", async () => {
    // Re-price: 1000 input tokens × 10e-6 (the v2 rate) = 0.01 (NOT the wire 0.005).
    await ingestBatch(dbh.db, machineId, costBatch(), {
      version: "m10-catalog-v2",
      rates: PAYLOAD_V2,
    });
    const rows = (
      await dbh.db.execute(
        sql`SELECT fingerprint, (cost->>'usd')::float AS usd, catalog_version FROM events ORDER BY fingerprint`,
      )
    ).rows as { fingerprint: string; usd: number | null; catalog_version: string | null }[];
    const cost = rows.find((r) => r.fingerprint === "rp-cost")!;
    expect(cost.usd).toBeCloseTo(0.01, 10);
    expect(cost.catalog_version).toBe("m10-catalog-v2");
    // usage.reported has no cost → re-pricing never ADDS one (shape-preserving, D2).
    const usage = rows.find((r) => r.fingerprint === "rp-usage")!;
    expect(usage.usd).toBeNull();
  });

  it("ingestBatch with NO repricing stores the wire cost verbatim (byte-identical to today)", async () => {
    await ingestBatch(dbh.db, machineId, costBatch());
    const [{ usd, catalog_version }] = (
      await dbh.db.execute(
        sql`SELECT (cost->>'usd')::float AS usd, catalog_version FROM events WHERE fingerprint = 'rp-cost'`,
      )
    ).rows as { usd: number; catalog_version: string | null }[];
    expect(usd).toBe(0.005); // the wire cost, unchanged
    expect(catalog_version).toBe("m10-catalog-v1"); // the wire-stamped version, unchanged
  });
});
