import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, ingestBatch, decryptField } from "../index.js";
import { users, machines, rawSourceRecords, events } from "../schema.js";
import type { IngestBatch } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;

// A representative batch: one raw record carries a known plaintext marker so the
// encryption-at-rest assertion is unambiguous; one event has a payload, one does not.
const SECRET = "super-secret-message-body claude-opus";
const RAW1_PAYLOAD = JSON.stringify({ model: "claude-opus", text: SECRET });

function makeBatch(): IngestBatch {
  return {
    records: [
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: RAW1_PAYLOAD },
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r2", payload: "plain line two" },
    ],
    events: [
      {
        fingerprint: "fp-usage",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 1,
        eventType: "usage.reported",
        sessionId: "s1",
        ts: "2026-06-13T00:00:00.000Z",
        tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0, reasoning: 0, tool: 0, total: 30 },
        cost: { usd: 0.5, confidence: "estimated-model-known", model: "claude-opus" },
      },
      {
        fingerprint: "fp-tool",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 3,
        eventType: "tool.call.started",
        sessionId: "s1",
        ts: "2026-06-13T00:00:01.000Z",
        payload: { name: "Read" },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("ingestBatch (integration)", () => {
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
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db.insert(users).values({ email: "test@example.com" }).returning({ id: users.id });
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId: u!.id, name: "test-machine" })
      .returning({ id: machines.id });
    machineId = m!.id;
  });

  it("inserts raw records + upserts events on first ingest", async () => {
    const res = await ingestBatch(dbh.db, machineId, makeBatch());
    expect(res).toEqual({ recordsInserted: 2, eventsUpserted: 2 });
  });

  it("is idempotent: re-running the same batch inserts 0 new raw, stable event count (PRD §23)", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const second = await ingestBatch(dbh.db, machineId, makeBatch());
    expect(second.recordsInserted).toBe(0);

    const [{ n }] = (
      await dbh.db.execute(sql`SELECT count(*)::int AS n FROM events`)
    ).rows as { n: number }[];
    expect(n).toBe(2);
  });

  it("encrypts raw payloads at rest and round-trips via decryptField (PRD §18.1)", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const [row] = await dbh.db
      .select()
      .from(rawSourceRecords)
      .where(eq(rawSourceRecords.sourceRecordId, "r1"));

    // ciphertext must NOT contain the plaintext marker
    expect(row!.payloadCiphertext).not.toContain(SECRET);
    expect(row!.payloadCiphertext).not.toContain("claude-opus");
    // and it decrypts back to the exact original line
    expect(
      decryptField({ ciphertext: row!.payloadCiphertext, iv: row!.payloadIv, tag: row!.payloadTag }),
    ).toBe(RAW1_PAYLOAD);
  });

  it("stores token counts + cost as plaintext queryable JSON", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const [{ total, usd }] = (
      await dbh.db.execute(
        sql`SELECT (tokens->>'total')::int AS total, (cost->>'usd')::float AS usd FROM events WHERE fingerprint = 'fp-usage'`,
      )
    ).rows as { total: number; usd: number }[];
    expect(total).toBe(30);
    expect(usd).toBe(0.5);
  });

  it("encrypts event tool payloads and leaves NULLs for payloadless events", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const [withPayload] = await dbh.db.select().from(events).where(eq(events.fingerprint, "fp-tool"));
    const [noPayload] = await dbh.db.select().from(events).where(eq(events.fingerprint, "fp-usage"));

    expect(withPayload!.payloadCiphertext).not.toBeNull();
    expect(
      JSON.parse(
        decryptField({
          ciphertext: withPayload!.payloadCiphertext!,
          iv: withPayload!.payloadIv!,
          tag: withPayload!.payloadTag!,
        }),
      ),
    ).toEqual({ name: "Read" });

    expect(noPayload!.payloadCiphertext).toBeNull();
    expect(noPayload!.payloadIv).toBeNull();
    expect(noPayload!.payloadTag).toBeNull();
  });

  it("treats an empty batch as a no-op 200-equivalent", async () => {
    const res = await ingestBatch(dbh.db, machineId, { records: [], events: [] });
    expect(res).toEqual({ recordsInserted: 0, eventsUpserted: 0 });
  });
});
