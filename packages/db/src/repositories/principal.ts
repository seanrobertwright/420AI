import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { memberships, users } from "../schema.js";

/**
 * Request-principal resolution (M15 15.2, PRD §24). The principal is "who is this
 * request", resolved ONCE per request from the caller's credential and then carried
 * into every read as `orgId`. It supersedes the 12.3 boolean admin gate, which
 * authenticated a caller and then threw the identity away.
 *
 * Silent library (CLAUDE.md): returns `undefined` for "no such user / no membership",
 * never throws, never logs. Failing closed is the CALLER's job (a `undefined`
 * principal ⇒ 401).
 */

export interface Principal {
  userId: string;
  email: string;
  orgId: string;
  /** owner | admin | member | viewer (D-M15-4). RESOLVED here, ENFORCED in 15.4 — never gate on it in this slice. */
  role: string;
}

/**
 * Resolve `{ userId, email, orgId, role }` for an email in ONE query
 * (users ⨝ memberships), or `undefined` when the email has no user OR no membership.
 *
 * The `innerJoin` is deliberate: an ownerless identity must fail CLOSED rather than
 * default into some org. The `ORDER BY created_at, id LIMIT 1` mirrors
 * `findOrgIdByUserId` so a user with two memberships (possible by design — 15.10
 * needs it) resolves to the SAME org from both functions rather than flapping.
 *
 * Explicit column list, never a bare `select()` — CLAUDE.md's 15.1 lesson. The
 * principal is not sent on the wire today, but the habit is the rule.
 */
export async function findPrincipalByEmail(
  db: DbClient,
  email: string,
): Promise<Principal | undefined> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      orgId: memberships.orgId,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.email, email))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row;
}
