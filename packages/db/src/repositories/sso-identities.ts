import { and, desc, eq, ne } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { ssoIdentities, users } from "../schema.js";
import { normalizeEmail } from "./users.js";

/**
 * M15 15.7 — linked external identities (D-M15-5). Silent library (CLAUDE.md): returns
 * `undefined`/`boolean` for the ordinary outcomes and throws exactly one typed error, never logs.
 *
 * `sso_identities` is an IDENTITY table with no `org_id` and no RLS policy (D-15.7-3), exactly as
 * `sessions` is, so no function below takes an `orgId`. Where scoping is needed it is `userId`, and
 * it is always the SECOND parameter for the same reason `orgId` is elsewhere: a transposed argument
 * between two adjacent `string` params must be visible in review.
 */

/**
 * The ONE exceptional condition in this repository. Everything else is a `undefined`/boolean that
 * a route turns into a status code; this is different because the caller must be able to say WHY
 * an unlink was refused, and "you would lock yourself out" is not something a boolean conveys.
 * Mirrors `MemberError`/`InviteError`; `app.ts` maps it to 409 with its `reason`.
 */
export class SsoIdentityError extends Error {
  constructor(
    message: string,
    readonly reason: "last_credential" | "identity_taken",
  ) {
    super(message);
    this.name = "SsoIdentityError";
  }
}

/**
 * Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). NOTE the deliberate
 * omission of `subject`: it is the provider's stable identifier and never belongs on the wire.
 */
const ssoIdentityRowColumns = {
  id: ssoIdentities.id,
  provider: ssoIdentities.provider,
  email: ssoIdentities.email,
  createdAt: ssoIdentities.createdAt,
};

export interface SsoIdentityRow {
  id: string;
  provider: string;
  email: string | null;
  createdAt: Date;
}

/**
 * Resolve a provider identity to its owner, or `undefined` when it is not linked.
 * THE hot path of an SSO login — one index probe on `(provider, subject)`.
 *
 * IT DOES NOT TAKE AN EMAIL, and that is the anti-takeover rule expressed as a SIGNATURE rather
 * than as a comment (D-15.7-1). A function that cannot see the email cannot be "improved" into
 * falling back to it.
 */
export async function findUserIdBySsoIdentity(
  db: DbClient,
  provider: string,
  subject: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: ssoIdentities.userId })
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.provider, provider), eq(ssoIdentities.subject, subject)))
    .limit(1);
  return row?.userId;
}

/**
 * Link a provider identity to a user. Throws `identity_taken` when that (provider, subject) is
 * already bound to somebody else — which the unique index would raise anyway, but as an opaque
 * 500. Catching it here turns the race into a clean 409 at every call site.
 */
export async function linkSsoIdentity(
  db: DbClient,
  userId: string,
  identity: { provider: string; subject: string; email?: string | null },
): Promise<{ id: string }> {
  const email = identity.email ? normalizeEmail(identity.email) : null;
  const existing = await findUserIdBySsoIdentity(db, identity.provider, identity.subject);
  if (existing && existing !== userId) {
    throw new SsoIdentityError("identity already linked to another account", "identity_taken");
  }
  const [row] = await db
    .insert(ssoIdentities)
    .values({ userId, provider: identity.provider, subject: identity.subject, email })
    // Re-linking the SAME identity to the SAME user is a no-op success, not an error: a user who
    // double-clicks "Connect Google" must not get a 409 for the state they asked for.
    .onConflictDoUpdate({
      target: [ssoIdentities.provider, ssoIdentities.subject],
      set: { email },
    })
    .returning({ id: ssoIdentities.id });
  return row!;
}

/** A user's linked identities, newest first. Explicit columns; rows reach the wire. */
export async function listSsoIdentities(db: DbClient, userId: string): Promise<SsoIdentityRow[]> {
  return db
    .select(ssoIdentityRowColumns)
    .from(ssoIdentities)
    .where(eq(ssoIdentities.userId, userId))
    .orderBy(desc(ssoIdentities.createdAt));
}

/**
 * Unlink `provider` from `userId`. Returns false when nothing was linked.
 *
 * THE GUARD IS LOCKED, AND THE MECHANISM IS THE LOCK — NOT THE TRANSACTION (CLAUDE.md 15.5, the
 * lesson 15.5's last-owner guard had to learn twice). Removing a user's last credential locks the
 * account out permanently, so this must refuse when the user has no password AND no other link.
 * That is a read-then-write decision, and `SELECT count(*)` takes NO LOCKS: under READ COMMITTED
 * two concurrent unlinks of two DIFFERENT providers each see "one other credential exists" and
 * both proceed, leaving zero. Sharing a transaction does not help — atomicity is not isolation.
 *
 * So the OTHER identity rows are selected `FOR UPDATE` (hence rows-then-`length`; Postgres cannot
 * apply FOR UPDATE to an aggregate), and the `users` row `FOR SHARE`. A blocked transaction
 * re-evaluates its predicate after the lock releases (EvalPlanQual), so the row the winner deleted
 * drops out of the loser's result set and the loser correctly refuses. No SERIALIZABLE, no retry.
 *
 * Takes a `DbClient` so a caller may pass a `Tx`; the route passes `app.db` and this opens its own.
 */
export async function unlinkSsoIdentity(
  db: DbClient,
  userId: string,
  provider: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const others = await tx
      .select({ id: ssoIdentities.id })
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.userId, userId), ne(ssoIdentities.provider, provider)))
      .for("update");
    const [cred] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .for("share")
      .limit(1);
    const hasOtherCredential = others.length > 0 || Boolean(cred?.passwordHash);
    if (!hasOtherCredential) {
      throw new SsoIdentityError(
        "cannot unlink the only credential on this account — set a password first",
        "last_credential",
      );
    }
    const removed = await tx
      .delete(ssoIdentities)
      .where(and(eq(ssoIdentities.userId, userId), eq(ssoIdentities.provider, provider)))
      .returning({ id: ssoIdentities.id });
    return removed.length > 0;
  });
}
