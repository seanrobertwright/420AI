import { asc, eq } from "drizzle-orm";
import type { DbClient, Tx } from "../client.js";
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
 * "≤1 membership per user" (multi-org users are committed for M16, so such a constraint
 * would only have to be dropped again — 15.10 deferred them, D-15.10-1), and two concurrent first-ever `ensurePersonalOrg`
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
 * Every organization in the deployment, oldest first.
 *
 * Exists for exactly one caller shape (M15 15.3, D-15.3-5): the three DEPLOYMENT-WIDE
 * maintenance ops — `/v1/replay/reprice`, `/v1/replay/reparse`, `/v1/search/reindex` — which
 * must touch all orgs. Under RLS they cannot do that in one unscoped pass, and giving the
 * ingest server a privileged bypass connection would put a cross-org seam in the server
 * forever. Instead they LOOP: `listOrganizations` then one `withOrg` pass per org, summing the
 * counts. The server can never see across orgs, full stop.
 *
 * `organizations` carries no RLS (D-15.3-4), so this read works from the app role.
 *
 * Explicit column list, never a bare `select()` — 15.1's lesson: rows that can reach
 * `reply.send()` must not carry unannounced columns.
 */
export async function listOrganizations(db: DbClient): Promise<{ id: string }[]> {
  return db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id));
}

/**
 * An organization's display name, or `undefined` when no such org exists.
 *
 * M15 15.5: exists for the invite PREVIEW (`GET /v1/auth/invites/:token`), which must tell an
 * invitee which org they are about to join BEFORE they have any identity — so this read, like the
 * invite lookup beside it, runs with no org context. `organizations` carries no RLS (D-15.3-4), so
 * that works. The name is the only field the preview exposes; nothing else about the org leaks to
 * a holder of an invite token.
 */
export async function getOrgName(db: DbClient, orgId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.name;
}

/**
 * M15 15.10 — the org row behind `GET /v1/org` and the Settings `<OrgCard/>`.
 *
 * EXPLICIT COLUMN LIST rather than `select()`, per the 15.1 rule: no ingest route declares a
 * Fastify `response` schema, so nothing strips extra properties from a row and a bare `select()`
 * would put every future `organizations` column on the wire the day one is added.
 *
 * No `orgId` predicate is "missing" here — `orgId` IS the key, and it comes from `principal.orgId`,
 * never from a request body or path parameter.
 */
export interface OrgRow {
  id: string;
  name: string;
  isPersonal: boolean;
}

/** Keep this list == `OrgRow`. */
const orgRowColumns = {
  id: organizations.id,
  name: organizations.name,
  isPersonal: organizations.isPersonal,
};

export async function getOrg(db: DbClient, orgId: string): Promise<OrgRow | undefined> {
  const [row] = await db
    .select(orgRowColumns)
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row;
}

/**
 * The same read, taking a ROW LOCK. For a read-then-write decision only.
 *
 * THE MECHANISM IS THE `FOR UPDATE` LOCK ON THE `organizations` ROW, and naming it here rather than
 * saying "it's in a transaction" is the whole point — CLAUDE.md's 15.5 lesson is that a shared
 * transaction buys ATOMICITY, not ISOLATION, and that the comment claiming otherwise WAS the defect.
 * A plain `SELECT` takes no locks, so under READ COMMITTED two concurrent renames both read the same
 * `before.name`, the second `UPDATE` blocks on the row lock and then commits over the first, and the
 * audit row records a `{from}` that was never the value this update actually replaced — a false
 * entry in the one table the application can never correct.
 *
 * With the lock, the loser blocks until the winner commits and then re-reads the current row
 * (Postgres re-evaluates after the lock releases), so its `{from}` describes the state it really
 * replaced.
 *
 * `Tx`, not `DbClient`: a `FOR UPDATE` outside a transaction releases immediately and buys nothing,
 * so the type makes the requirement true by construction rather than by convention — the same reason
 * `repositories/members.ts` takes a `Tx` for the last-owner guard. `getOrg` above stays unlocked and
 * is what every plain read (`GET /v1/org`) should use; taking a lock there would serialise readers
 * for no benefit.
 */
export async function getOrgForUpdate(tx: Tx, orgId: string): Promise<OrgRow | undefined> {
  const [row] = await tx
    .select(orgRowColumns)
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for("update");
  return row;
}

/**
 * Rename an organization. `owner`-gated at the route (M15 15.10) — renaming is the most org-level
 * act available and there is no undo surface; `admin` is the rung that manages PEOPLE.
 *
 * IT EXISTS BECAUSE `ensurePersonalOrg` SEEDS THE NAME FROM AN EMAIL ADDRESS (see below — `name` is
 * the caller-supplied email). An "Organization" card that shows a colleague `sean@example.com` with
 * no way to change it is a visibly unfinished surface at exactly the moment a second person arrives.
 *
 * `is_personal` IS DELIBERATELY UNTOUCHED. An org auto-created for one user that has since grown a
 * second member is still flagged personal, and that is fine: the flag records PROVENANCE (which row
 * the 15.1 backfill seeded), not current shape. The dashboard branches on `memberCount`, never on
 * this flag — do not "correct" it here.
 *
 * There is deliberately NO parameter for a target org: a rename endpoint that accepts one is a
 * cross-tenant write waiting to happen. The caller's `principal.orgId` is the only source.
 */
export async function renameOrg(
  db: DbClient,
  orgId: string,
  name: string,
): Promise<OrgRow | undefined> {
  const [row] = await db
    .update(organizations)
    .set({ name })
    .where(eq(organizations.id, orgId))
    .returning(orgRowColumns);
  return row;
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
