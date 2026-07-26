import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../index.js";
import { memberships, organizations, users } from "../schema.js";
import { ensurePersonalOrg, findOrgIdByUserId, getOrgIdForUser } from "./organizations.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/**
 * M15 15.1 — the organizations repository. The load-bearing property here is
 * IDEMPOTENCY: `setUserPassword` calls `ensurePersonalOrg` on EVERY ingest-server boot,
 * so a create-unconditionally implementation would mint a fresh org per restart.
 */
describe.skipIf(!TEST_URL)("organizations repository (integration)", () => {
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
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "org-test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
  });

  it("ensurePersonalOrg creates a personal org + an owner membership", async () => {
    const orgId = await ensurePersonalOrg(dbh.db, userId, "org-test@example.com");
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

    const [org] = await dbh.db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.name).toBe("org-test@example.com");
    expect(org!.isPersonal).toBe(true);

    const rows = await dbh.db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("owner");
    expect(rows[0]!.orgId).toBe(orgId);
  });

  it("is IDEMPOTENT: a second call returns the same org and creates no second row", async () => {
    const first = await ensurePersonalOrg(dbh.db, userId, "org-test@example.com");
    const second = await ensurePersonalOrg(dbh.db, userId, "org-test@example.com");
    const third = await ensurePersonalOrg(dbh.db, userId, "renamed@example.com");
    expect(second).toBe(first);
    // Even a DIFFERENT name returns the existing org — it never renames or re-creates.
    expect(third).toBe(first);

    expect(await dbh.db.select().from(organizations)).toHaveLength(1);
    expect(await dbh.db.select().from(memberships)).toHaveLength(1);
  });

  it("findOrgIdByUserId returns undefined for a user with no membership (never throws)", async () => {
    expect(await findOrgIdByUserId(dbh.db, userId)).toBeUndefined();
  });

  it("getOrgIdForUser throws a clear message for a user with no org", async () => {
    await expect(getOrgIdForUser(dbh.db, userId)).rejects.toThrow(
      `user ${userId} has no organization`,
    );
  });

  it("findOrgIdByUserId is DETERMINISTIC when a user holds two memberships", async () => {
    // The accepted race (two concurrent first-ever calls) is documented, not prevented —
    // what IS guaranteed is that the answer never flaps. Simulate it directly.
    const older = await ensurePersonalOrg(dbh.db, userId, "org-test@example.com");
    const [dup] = await dbh.db
      .insert(organizations)
      .values({ name: "duplicate", isPersonal: true })
      .returning({ id: organizations.id });
    await dbh.db.insert(memberships).values({
      orgId: dup!.id,
      userId,
      role: "owner",
      createdAt: new Date(Date.now() + 60_000), // strictly newer
    });

    // ORDER BY created_at, id → the OLDER org wins, on every call.
    expect(await findOrgIdByUserId(dbh.db, userId)).toBe(older);
    expect(await findOrgIdByUserId(dbh.db, userId)).toBe(older);
    expect(await getOrgIdForUser(dbh.db, userId)).toBe(older);
  });

  it("composes inside a caller's transaction (takes DbClient, not Db)", async () => {
    const orgId = await dbh.db.transaction(async (tx) =>
      ensurePersonalOrg(tx, userId, "org-test@example.com"),
    );
    expect(await findOrgIdByUserId(dbh.db, userId)).toBe(orgId);
  });
});
