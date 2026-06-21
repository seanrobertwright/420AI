import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createPairingCode, redeemPairingCode, PairingError } from "../index.js";
import { users, pairingCodes } from "../schema.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)("pairing repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let userId: string;

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
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
  });

  it("redeems a valid code once and returns its userId", async () => {
    const { code } = await createPairingCode(dbh.db, userId);
    const result = await redeemPairingCode(dbh.db, code);
    expect(result.userId).toBe(userId);
  });

  it("rejects a second redeem as consumed (single-use)", async () => {
    const { code } = await createPairingCode(dbh.db, userId);
    await redeemPairingCode(dbh.db, code);
    await expect(redeemPairingCode(dbh.db, code)).rejects.toBeInstanceOf(PairingError);
    await expect(redeemPairingCode(dbh.db, code)).rejects.toMatchObject({ reason: "consumed" });
  });

  it("rejects an unknown code", async () => {
    await expect(redeemPairingCode(dbh.db, "no-such-code")).rejects.toMatchObject({
      reason: "unknown",
    });
  });

  it("rejects an expired code", async () => {
    const code = "expired-code";
    await dbh.db.insert(pairingCodes).values({
      code,
      userId,
      expiresAt: new Date(Date.now() - 60_000), // 1 min in the past
    });
    await expect(redeemPairingCode(dbh.db, code)).rejects.toMatchObject({ reason: "expired" });
  });
});
