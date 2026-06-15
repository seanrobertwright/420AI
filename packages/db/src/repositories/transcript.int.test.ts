import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, ingestBatch, sessionTranscript } from "../index.js";
import { users, machines } from "../schema.js";
import type { IngestBatch } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;

// A known secret embedded in the user prompt. sessionTranscript returns PLAINTEXT —
// redaction is the @420ai/shared engine's job (the orchestrator), NOT this read — so
// the secret MUST still be present in the decrypted entry here.
const SECRET = "sk-ant-api03-TESTKEY0123456789ABCDEF";
const USER_TEXT = JSON.stringify({ role: "user", text: `please use ${SECRET}` });
const ASSISTANT_TEXT = JSON.stringify({ role: "assistant", text: "here is a plan" });
const ATTACHMENT_TEXT = "ATTACHMENT-SHOULD-NOT-APPEAR";

function makeBatch(): IngestBatch {
  return {
    records: [
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: USER_TEXT },
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r2", payload: ASSISTANT_TEXT },
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r3", payload: ATTACHMENT_TEXT },
    ],
    events: [
      {
        fingerprint: "t-user",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "s1",
        ts: "2026-06-14T00:00:00.000Z",
      },
      {
        fingerprint: "t-asst-1",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r2",
        eventIndex: 1,
        eventType: "message.assistant",
        sessionId: "s1",
        ts: "2026-06-14T00:01:00.000Z",
      },
      {
        // Second message event on the SAME raw record (r2) — must dedupe to one entry.
        fingerprint: "t-asst-2",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r2",
        eventIndex: 2,
        eventType: "message.assistant",
        sessionId: "s1",
        ts: "2026-06-14T00:02:00.000Z",
      },
      {
        // Non-message event → excluded by the WHERE on event_type.
        fingerprint: "t-ctx",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r3",
        eventIndex: 3,
        eventType: "context.loaded",
        sessionId: "s1",
        ts: "2026-06-14T00:03:00.000Z",
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("sessionTranscript (integration)", () => {
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

  it("decrypts, orders, dedupes, and excludes non-message lines", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const { entries, truncated } = await sessionTranscript(dbh.db, "s1");

    // Exactly the two message entries (r2 deduped), ordered by ts.
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    // Decrypted text equals the ingested plaintext — secret still present (NOT redacted here).
    expect(entries[0]!.text).toBe(USER_TEXT);
    expect(entries[0]!.text).toContain(SECRET);
    expect(entries[1]!.text).toBe(ASSISTANT_TEXT);
    // The attachment/context line is excluded entirely.
    expect(JSON.stringify(entries)).not.toContain(ATTACHMENT_TEXT);
    expect(truncated).toBe(false);
  });

  it("per-record truncation sets the entry + result truncated flags", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const { entries, truncated } = await sessionTranscript(dbh.db, "s1", {
      maxRecords: 200,
      maxCharsPerRecord: 5,
      maxTotalChars: 48000,
    });
    expect(entries[0]!.text.length).toBe(5);
    expect(entries[0]!.truncated).toBe(true);
    expect(truncated).toBe(true);
  });

  it("global char cap truncates the result", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const { entries, totalChars, truncated } = await sessionTranscript(dbh.db, "s1", {
      maxRecords: 200,
      maxCharsPerRecord: 4000,
      maxTotalChars: 10,
    });
    expect(totalChars).toBeLessThanOrEqual(10);
    expect(truncated).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("returns an empty transcript for an unknown session", async () => {
    await ingestBatch(dbh.db, machineId, makeBatch());
    const { entries, truncated } = await sessionTranscript(dbh.db, "no-such-session");
    expect(entries).toEqual([]);
    expect(truncated).toBe(false);
  });
});
