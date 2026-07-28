import { and, asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { memberships, users } from "../schema.js";
import { normalizeEmail } from "./users.js";

/**
 * M15 15.5 — organization MEMBER management (D-M15-5). Silent library (CLAUDE.md): throws typed
 * errors, never logs.
 *
 * `DbClient`, not `Db`, and here that is load-bearing rather than conventional. The last-owner
 * guard (D-15.5-12) reads the owner COUNT and then mutates, so the two must share ONE transaction
 * — otherwise two concurrent demotions each see two owners and both succeed, leaving an org with
 * nobody who can administer it. Every caller reaches these from inside `withOrg`, which IS a
 * transaction; taking a `Tx` is what makes that true by type rather than by convention.
 *
 * THE PREDICATE IS THE ONLY BOUNDARY HERE. `memberships` and `users` carry NO RLS at all
 * (D-15.3-4 — they are the identity tables org resolution itself reads), so unlike every other
 * repository in this package there is no backstop behind a forgotten `eq(memberships.orgId, …)`.
 * This is the one file in the slice where a missing org predicate is a genuine cross-tenant read,
 * which is why `orgId` is the SECOND parameter of every function (CLAUDE.md 15.2 rule) and why
 * `members.int.test.ts` asserts the cross-tenant negative directly.
 */

/** Thrown when a membership mutation is refused. */
export class MemberError extends Error {
  constructor(
    message: string,
    readonly reason: "last_owner" | "not_a_member",
  ) {
    super(message);
    this.name = "MemberError";
  }
}

export interface MemberRow {
  userId: string;
  email: string;
  role: string;
  joinedAt: Date;
}

/**
 * The columns a `MemberRow` is made of. EXPLICIT rather than `select()`, per the 15.1 lesson —
 * and with an extra reason here: a bare `select()` over `users ⨝ memberships` would put
 * `password_hash` on the wire. Keep this list == `MemberRow`.
 */
const memberRowColumns = {
  userId: users.id,
  email: users.email,
  role: memberships.role,
  joinedAt: memberships.createdAt,
};

/**
 * Every member of one org, oldest membership first. The `(created_at, id)` ordering mirrors
 * `findPrincipalByEmail` / `findOrgIdByUserId`, so "the first membership" means the same row
 * everywhere.
 */
export async function listMembers(db: DbClient, orgId: string): Promise<MemberRow[]> {
  return db
    .select(memberRowColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

/**
 * Resolve a member of THIS org by email, or `undefined`.
 *
 * THE D-M15-8 REPLACEMENT. `POST /v1/pairing-codes` used to upsert a `users` row from a
 * caller-supplied `body.email`, which is an account PRE-SEEDING primitive: any admin could mint a
 * row for `victim@corp.com`, and 15.7's SSO link-by-email would then adopt it. The route now calls
 * this and 404s on `undefined` — it can REFERENCE an existing colleague and nothing else.
 *
 * Case-insensitive via `normalizeEmail` (D-15.5-3), matching every write path in `users.ts`.
 */
export async function findMemberByEmail(
  db: DbClient,
  orgId: string,
  email: string,
): Promise<MemberRow | undefined> {
  const [row] = await db
    .select(memberRowColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(users.email, normalizeEmail(email))))
    .limit(1);
  return row;
}

/**
 * Resolve a member of THIS org by user id, or `undefined`. The sibling of the above, and it exists
 * for the same reason: `POST /v1/pairing-codes` also accepts `body.userId`, so without an org
 * check there the pre-seeding primitive would survive one parameter to the left.
 */
export async function findMemberByUserId(
  db: DbClient,
  orgId: string,
  userId: string,
): Promise<MemberRow | undefined> {
  const [row] = await db
    .select(memberRowColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return row;
}

/** How many `owner` memberships the org has. Read INSIDE the caller's transaction — see header. */
async function countOwners(tx: DbClient, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")));
  return row?.n ?? 0;
}

/**
 * Change a member's role. Throws `MemberError("…", "not_a_member")` when they are not in the org
 * and `MemberError("…", "last_owner")` when this would demote the org's FINAL owner (D-15.5-12).
 *
 * The guard lives HERE and not in the route so it holds for any future caller — including the
 * 15.10 team UI and any script. The route-layer escalation guard (D-15.5-11, "never assign above
 * your own rung") is a different question and stays at the route, because only the route knows
 * who is asking.
 */
export async function setMemberRole(
  tx: DbClient,
  orgId: string,
  userId: string,
  role: string,
): Promise<MemberRow> {
  const existing = await findMemberByUserId(tx, orgId, userId);
  if (!existing) throw new MemberError("no such member in this organization", "not_a_member");

  if (existing.role === "owner" && role !== "owner" && (await countOwners(tx, orgId)) === 1) {
    throw new MemberError("cannot demote the organization's last owner", "last_owner");
  }

  await tx
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

  return { ...existing, role };
}

/**
 * Remove a member from the org. Returns false when they were not a member (so a caller 404s
 * without leaking whether the id exists in another tenant); throws `MemberError("last_owner")`
 * when this would remove the org's final owner (D-15.5-12).
 *
 * Only the MEMBERSHIP is removed — the `users` row survives, because an identity may belong to
 * other orgs (15.10) and because deleting it would cascade into every row that references it.
 */
export async function removeMember(tx: DbClient, orgId: string, userId: string): Promise<boolean> {
  const existing = await findMemberByUserId(tx, orgId, userId);
  if (!existing) return false;

  if (existing.role === "owner" && (await countOwners(tx, orgId)) === 1) {
    throw new MemberError("cannot remove the organization's last owner", "last_owner");
  }

  const removed = await tx
    .delete(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .returning({ id: memberships.id });
  return removed.length > 0;
}
