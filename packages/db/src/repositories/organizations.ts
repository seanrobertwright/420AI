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
 * SCOPE NOTE (updated by 15.2). `ensurePersonalOrg` is PERMANENT — it is how the
 * "every user has at least one org" invariant holds by construction, and both `users`
 * insert paths plus every boot-time seed call it.
 *
 * `getOrgIdForUser` was expected to disappear entirely in 15.2, when the request
 * principal (`resolvePrincipal` → `principal.orgId`) took over. It did not, and the two
 * places it legitimately SURVIVES are worth naming, because both are cases where
 * "just use the principal's org" would be actively wrong:
 *
 *   1. MACHINE-authed writes. `POST /v1/workspaces/discover` is authenticated by a
 *      collector's machine token, so there is no request principal at all
 *      (`upsertWorkspace`, `addWorkspaceKey`, `findOrCreateProjectByRemote`,
 *      `createProject` on that path). D-M15-7 / slice 15.9 gives the machine credential
 *      tier its own org resolution.
 *   2. Rows written FOR ANOTHER USER. `createPairingCode` mints a code for a target user
 *      that `POST /v1/pairing-codes` may name via `body.email` (D-M15-8 / 15.5 closes
 *      that primitive). The code's org must be the TARGET's, never the caller's —
 *      otherwise `user_id` and `org_id` disagree and the row is cross-org.
 *
 * The rule that generalizes both: a row's `org_id` must match the org of whoever the row
 * BELONGS to, which is the principal only when the principal is also the owner.
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
