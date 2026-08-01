import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  createDb,
  ingestBatch,
  reencryptAll,
  decryptField,
  findTotpCredential,
  upsertUnconfirmedTotp,
} from "../index.js";
import { users, machines, rawSourceRecords, totpCredentials } from "../schema.js";
import type { IngestBatch } from "@420ai/shared";
import { ensurePersonalOrg } from "./organizations.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const K1 = randomBytes(32).toString("base64"); // "legacy" key
const K2 = randomBytes(32).toString("base64"); // "v2" key (rotation target)
const RAW1 = JSON.stringify({ model: "claude-opus", text: "rotate-me-secret" });
/** M15 15.8 — 160 bits, the size `generateTotpSecret` produces (RFC 4226 §4 R6). Fixed for the assert. */
const TOTP_SECRET = Buffer.from("12345678901234567890", "ascii");

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
  let orgId: string;
  let machineId: string;
  // M15 15.8 — needed to seed the fourth encrypted column trio (`totp_credentials.secret_*`).
  let userId: string;
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
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "rot@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
    orgId = await ensurePersonalOrg(dbh.db, u!.id, "rot@example.com");
    const [m] = await dbh.db
      .insert(machines)
      .values({ orgId, userId: u!.id, name: "rot-machine" })
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
    // M15 15.8 — the FOURTH encrypted trio. Seeded through the repository rather than by hand so the
    // row is encrypted exactly the way production writes it (D-15.8-6). Without this pass in
    // `reencryptAll`, retiring the legacy key would break MFA for every enrolled user at once.
    await upsertUnconfirmedTotp(dbh.db, userId, TOTP_SECRET);

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
    expect(counts.totpCredentials).toBe(1);

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

    // 3b) The TOTP secret is likewise v2-prefixed AND still decrypts to the SAME 20 bytes. The
    // round-trip is the assertion that matters: a rotation that re-encrypted the base64 wrapper
    // rather than the plaintext would also be v2-prefixed, and every code would silently be wrong.
    const [totpRow] = await dbh.db
      .select({ ct: totpCredentials.secretCiphertext })
      .from(totpCredentials);
    expect(totpRow!.ct.startsWith("v2.")).toBe(true);
    const cred = await findTotpCredential(dbh.db, userId);
    expect(cred!.secret.equals(TOTP_SECRET)).toBe(true);

    // 4) Re-running rotation is a no-op (everything is already under v2).
    const second = await reencryptAll(dbh.db);
    expect(second).toEqual({
      rawSourceRecords: 0,
      events: 0,
      gitCommits: 0,
      totpCredentials: 0,
    });
  });

  it("refuses to rotate in legacy single-key mode (no silent no-op)", async () => {
    delete process.env.ARCHIVE_ENCRYPTION_KEYS;
    delete process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID;
    process.env.ARCHIVE_ENCRYPTION_KEY = K1;
    await expect(reencryptAll(dbh.db)).rejects.toThrow(/keyring mode/);
  });
});
