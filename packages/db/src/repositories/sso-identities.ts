import { and, asc, desc, eq } from "drizzle-orm";
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
 * already bound to somebody else.
 *
 * THE MECHANISM IS THE UNIQUE INDEX, NOT THE READ (CLAUDE.md 15.5 — "name the mechanism: a lock, a
 * unique index, or an isolation level"). An earlier version of this function guarded with a
 * `SELECT` and then upserted, and its comment claimed that "turns the race into a clean 409 at
 * every call site". It did not, and the claim was the worse half: `SELECT` takes no locks, so two
 * concurrent linkers both passed the read, and the loser's unguarded `ON CONFLICT DO UPDATE`
 * updated THE WINNER'S ROW and returned its id — reporting success to a user who was not linked.
 * Measured with two hand-held transactions, not theorised.
 *
 * The fix is `setWhere`: the update fires only when the conflicting row ALREADY belongs to this
 * user (the double-click case, which must stay a no-op success), and otherwise matches nothing, so
 * `returning()` comes back EMPTY and that emptiness is the conflict signal. One statement, no
 * lock, no retry — Postgres resolves the race at the index.
 */
export async function linkSsoIdentity(
  db: DbClient,
  userId: string,
  identity: { provider: string; subject: string; email?: string | null },
): Promise<{ id: string }> {
  const email = identity.email ? normalizeEmail(identity.email) : null;
  const [row] = await db
    .insert(ssoIdentities)
    .values({ userId, provider: identity.provider, subject: identity.subject, email })
    // Re-linking the SAME identity to the SAME user is a no-op success, not an error: a user who
    // double-clicks "Connect Google" must not get a 409 for the state they asked for.
    .onConflictDoUpdate({
      target: [ssoIdentities.provider, ssoIdentities.subject],
      set: { email },
      // The whole guard. Without it the conflicting row is updated no matter who owns it.
      setWhere: eq(ssoIdentities.userId, userId),
    })
    .returning({ id: ssoIdentities.id });
  if (!row) {
    // `setWhere` matched nothing ⇒ the row exists and belongs to somebody else. Note this cannot
    // be confused with "insert affected nothing" — an unconflicted insert always returns its row.
    throw new SsoIdentityError("identity already linked to another account", "identity_taken");
  }
  return row;
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
 * THE LOCK MUST COVER **ALL** OF THE USER'S IDENTITY ROWS, NOT JUST THE OTHERS, AND THAT DETAIL IS
 * THE WHOLE FIX. An earlier version locked only the OTHER providers' rows and claimed the loser
 * "correctly refuses" via EvalPlanQual. For the race it named — two concurrent unlinks of two
 * different providers — that was false, and measurably so: each transaction locked a DISJOINT row
 * (unlinking `google` locks the `github` row and vice versa), so neither blocked on the read, both
 * saw one surviving credential, and the conflict surfaced at the DELETEs as a Postgres DEADLOCK
 * (40P01). The safety invariant survived only because deadlock detection aborted one of them — and
 * nothing maps 40P01, so the user got a 500 instead of the documented 409.
 *
 * Selecting EVERY row for the user, ordered by `id`, makes the lock ordering deterministic: both
 * transactions contend on the same first row, so one blocks on the READ instead of the delete.
 * When it wakes it re-evaluates under EvalPlanQual, sees the winner's row is gone, and refuses with
 * `last_credential` — which is what the comment always claimed. `others` is then computed in JS
 * (hence rows-then-`length`; Postgres cannot apply FOR UPDATE to an aggregate anyway). The `users`
 * row is still taken `FOR SHARE`, which is enough — it is only read, never written, here.
 * No SERIALIZABLE, no retry loop, and no reachable deadlock.
 *
 * Takes a `DbClient` so a caller may pass a `Tx`; the route passes `app.db` and this opens its own.
 */
export async function unlinkSsoIdentity(
  db: DbClient,
  userId: string,
  provider: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // ALL the user's rows, in a deterministic order — see the paragraph above. Narrowing this
    // `where` back to `ne(provider)` reintroduces the deadlock.
    const owned = await tx
      .select({ id: ssoIdentities.id, provider: ssoIdentities.provider })
      .from(ssoIdentities)
      .where(eq(ssoIdentities.userId, userId))
      .orderBy(asc(ssoIdentities.id))
      .for("update");
    const others = owned.filter((r) => r.provider !== provider);
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
