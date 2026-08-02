import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { memberships, users } from "../schema.js";
import { normalizeEmail } from "./users.js";

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
  /**
   * owner | admin | member | viewer (D-M15-4). RESOLVED here; ENFORCED as of 15.4 by
   * `apps/ingest/src/auth.ts`'s `authorized()` at the route layer, and backstopped by the
   * migration-0016 RESTRICTIVE write policies via `withOrg`'s `role` parameter.
   *
   * Typed `string`, not `Role`: it comes from a TEXT column with no CHECK constraint, so a
   * hand-edited row can hold anything. `hasRole` takes a `string` and fails CLOSED — do not
   * cast this.
   */
  role: string;
}

/**
 * Resolve `{ userId, email, orgId, role }` for an email in ONE query
 * (users ⨝ memberships), or `undefined` when the email has no user OR no membership.
 *
 * The `innerJoin` is deliberate: an ownerless identity must fail CLOSED rather than
 * default into some org. The `ORDER BY created_at, id LIMIT 1` mirrors
 * `findOrgIdByUserId` so a user with two memberships (possible by design — M16
 * needs it) resolves to the SAME org from both functions rather than flapping.
 *
 * Explicit column list, never a bare `select()` — CLAUDE.md's 15.1 lesson. The
 * principal is not sent on the wire today, but the habit is the rule.
 *
 * M15 15.5 (D-15.5-3): the lookup normalizes through `normalizeEmail`, because this is the READ
 * half of the same key the write paths in `users.ts` normalize. A session token's `sub` is
 * whatever string the login body carried, so without this a user who typed `Foo@corp.com` at
 * login would get a valid session that resolves to no principal at all (a blanket 401).
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
    .where(eq(users.email, normalizeEmail(email)))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row;
}

/**
 * M15 15.9 — the same resolution keyed by `users.id` instead of an email, for the credential tier
 * that already knows the user id: an API key's `api_keys.user_id` (D-M15-7).
 *
 * A SEPARATE FUNCTION rather than a `users` join bolted onto `findLiveApiKey`, deliberately.
 * `findLiveApiKey` is the hot pre-context auth read; widening it to carry an email would make every
 * key lookup pay for a join whose only purpose is to feed the query below, which then joins `users`
 * again anyway.
 *
 * THE `ORDER BY` MUST STAY BYTE-IDENTICAL TO `findPrincipalByEmail` ABOVE, and to
 * `findOrgIdByUserId`. A user may hold two memberships by design (M16 needs it — 15.10 deferred it, D-15.10-1); if these
 * resolvers tie-broke differently, the SAME user would land in a different org depending on whether
 * they arrived by session or by API key. That is a tenancy bug with no type-level signal — the only
 * thing keeping the two in agreement is this ordering, so change neither without the other.
 *
 * No `normalizeEmail` here, and its absence is not an omission: the sibling normalizes because a
 * session token's `sub` is whatever string the login body carried. A uuid foreign key has no such
 * ambiguity.
 *
 * Same silent-library contract: `undefined` when the user has no membership (an ownerless identity
 * fails CLOSED via the `innerJoin`), never a throw.
 */
export async function findPrincipalByUserId(
  db: DbClient,
  userId: string,
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
    .where(eq(users.id, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row;
}
