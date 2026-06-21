import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createDb, ingestBatch, reencryptAll, decryptField } from "../index.js";
import { users, machines, rawSourceRecords } from "../schema.js";
import type { IngestBatch } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;
const K1 = randomBytes(32).toString("base64"); // "legacy" key
const K2 = randomBytes(32).toString("base64"); // "v2" key (rotation target)
const RAW1 = JSON.stringify({ model: "claude-opus", text: "rotate-me-secret" });

function makeBatch(): IngestBatch {
  return {
    records: [
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: RAW1 },
      {
        sourceConnector: "claude-code",
        sessionId: "s1",
        sourceRecordId: "r2",
        payload: "plain line two",
      },
    ],
    events: [
      {
        fingerprint: "fp-tool",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 1,
        eventType: "tool.call.started",
        sessionId: "s1",
        ts: "2026-06-13T00:00:00.000Z",
        payload: { name: "Read" },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("key rotation (reencryptAll, integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let machineId: string;
  // Save/restore the crypto env around each case so it can't leak into other suites.
  let saved: { keys?: string; active?: string; single?: string };

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    saved = {
      keys: process.env.ARCHIVE_ENCRYPTION_KEYS,
      active: process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID,
      single: process.env.ARCHIVE_ENCRYPTION_KEY,
    };
    await dbh.db.execute(
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "rot@example.com" })
      .returning({ id: users.id });
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId: u!.id, name: "rot-machine" })
      .returning({ id: machines.id });
    machineId = m!.id;
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("ARCHIVE_ENCRYPTION_KEYS", saved.keys);
    restore("ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID", saved.active);
    restore("ARCHIVE_ENCRYPTION_KEY", saved.single);
  });

  it("re-encrypts legacy-written rows under the new active key (v2)", async () => {
    // 1) Ingest under a keyring whose ACTIVE id is "legacy" → un-prefixed ciphertext (K1).
    delete process.env.ARCHIVE_ENCRYPTION_KEY; // keyring takes priority, but be unambiguous
    process.env.ARCHIVE_ENCRYPTION_KEYS = JSON.stringify({ legacy: K1, v2: K2 });
    process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID = "legacy";
    await ingestBatch(dbh.db, machineId, makeBatch());

    const before = await dbh.db
      .select({ ct: rawSourceRecords.payloadCiphertext })
      .from(rawSourceRecords);
    expect(before).toHaveLength(2);
    for (const r of before) expect(r.ct.includes(".")).toBe(false); // un-prefixed (legacy active)

    // 2) Flip the active key to v2 and rotate.
    process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID = "v2";
    const counts = await reencryptAll(dbh.db);
    expect(counts.rawSourceRecords).toBe(2);
    expect(counts.events).toBe(1); // only the event that carries a payload
    expect(counts.gitCommits).toBe(0);

    // 3) Raw rows are now v2-prefixed AND still decrypt to the original plaintext.
    const after = await dbh.db
      .select({
        ct: rawSourceRecords.payloadCiphertext,
        iv: rawSourceRecords.payloadIv,
        tag: rawSourceRecords.payloadTag,
        rid: rawSourceRecords.sourceRecordId,
      })
      .from(rawSourceRecords);
    for (const r of after) expect(r.ct.startsWith("v2.")).toBe(true);
    const r1 = after.find((r) => r.rid === "r1")!;
    expect(decryptField({ ciphertext: r1.ct, iv: r1.iv, tag: r1.tag })).toBe(RAW1);

    // 4) Re-running rotation is a no-op (everything is already under v2).
    const second = await reencryptAll(dbh.db);
    expect(second).toEqual({ rawSourceRecords: 0, events: 0, gitCommits: 0 });
  });

  it("refuses to rotate in legacy single-key mode (no silent no-op)", async () => {
    delete process.env.ARCHIVE_ENCRYPTION_KEYS;
    delete process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID;
    process.env.ARCHIVE_ENCRYPTION_KEY = K1;
    await expect(reencryptAll(dbh.db)).rejects.toThrow(/keyring mode/);
  });
});
