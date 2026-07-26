import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { memberships, organizations } from "../schema.js";

/**
 * Organization / membership repository (M15 15.1, PRD §24). The organization is the
 * tenancy boundary (D-M15-1): every tenant-owned row carries `org_id`, and a user
 * reaches an org only through a `memberships` row.
 *
 * Silent library (CLAUDE.md): throws plain/typed errors, never logs, never exits.
 * Every function takes `DbClient` (not `Db`) so it composes inside a caller's
 * transaction — `pair.ts` and the users upserts both call these mid-transaction.
 *
 * SCOPE NOTE: `getOrgIdForUser` is a knowingly TEMPORARY seam. It answers "the org of
 * a user who has exactly one membership", which is true today and made true by
 * construction for every new user (`ensurePersonalOrg` runs on both `users` insert
 * paths). Slice 15.2 introduces the request principal and replaces every call site
 * with `principal.orgId`; each is marked with a grep-able comment.
 */

/**
 * Resolve a user's organization, or `undefined` when they have no membership yet.
 *
 * DETERMINISTIC BY DESIGN: `ORDER BY created_at, id LIMIT 1`. Nothing constrains
 * "≤1 membership per user" (15.10 needs multi-org users, so such a constraint would
 * only have to be dropped again), and two concurrent first-ever `ensurePersonalOrg`
 * calls for the same user could therefore create two personal orgs. The ordering
 * means that even in that accepted race the answer is stable rather than flapping
 * between the duplicates. Both call sites are admin-gated and low-frequency.
 */
export async function findOrgIdByUserId(db: DbClient, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row?.orgId;
}

/**
 * Resolve a user's organization, throwing when they have none. THE resolver every
 * user-keyed write path calls: a clear error beats inserting a null and surfacing an
 * opaque `not-null constraint` violation from Postgres.
 */
export async function getOrgIdForUser(db: DbClient, userId: string): Promise<string> {
  const orgId = await findOrgIdByUserId(db, userId);
  if (!orgId) throw new Error(`user ${userId} has no organization`);
  return orgId;
}

/**
 * Find-or-create the user's personal organization, returning its id (IDEMPOTENT).
 * Returns the existing membership's org when there is one; otherwise inserts an
 * `organizations` row (`is_personal: true`) plus an `owner` membership (D-M15-4/D-M15-11).
 *
 * Idempotency is load-bearing, not a nicety: `setUserPassword` runs on EVERY ingest
 * server boot when `ADMIN_PASSWORD` is set (`apps/ingest/src/server.ts`), so a
 * create-unconditionally version would mint a fresh org on every restart.
 */
export async function ensurePersonalOrg(
  db: DbClient,
  userId: string,
  name: string,
): Promise<string> {
  const existing = await findOrgIdByUserId(db, userId);
  if (existing) return existing;

  const [org] = await db
    .insert(organizations)
    .values({ name, isPersonal: true })
    .returning({ id: organizations.id });
  const orgId = org!.id;
  await db.insert(memberships).values({ orgId, userId, role: "owner" });
  return orgId;
}
