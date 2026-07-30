import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";

/**
 * User lookups for the single-user admin surface (M2/M5). The pairing flow
 * upserts a user by email; the M5 admin endpoints resolve that same user to
 * scope projects/workspaces. Silent library — throws, never logs.
 */

/**
 * M15 15.5 (D-15.5-3) — THE email boundary. `users_email_unique` is a plain btree on `email`
 * (verified against the live schema), so without this `Foo@corp.com` and `foo@corp.com` are two
 * accounts. That is half of the takeover chain D-M15-8 closes: pre-seeding gets you a row,
 * case-variance gets you a SECOND row the victim cannot see. 15.7 links identity by email.
 *
 * Every function in this file, plus `findPrincipalByEmail`, plus every 15.5 route, normalizes
 * here. Migration 0017 lowercases the existing rows.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Resolve a user id by email, or undefined if none exists yet. */
export async function findUserIdByEmail(db: DbClient, email: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row?.id;
}

/**
 * Find-or-create a user by email and return its id (idempotent). M15 15.1: also
 * ensures the user's personal organization exists, so the invariant "every user has
 * at least one org" holds by construction for new users exactly as the 0014 backfill
 * made it hold for history. `ensurePersonalOrg` is itself idempotent.
 */
export async function ensureUserByEmail(db: DbClient, email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .insert(users)
    .values({ email: normalized })
    .onConflictDoUpdate({ target: users.email, set: { email: normalized } })
    .returning({ id: users.id });
  const id = row!.id;
  await ensurePersonalOrg(db, id, normalized);
  return id;
}

/**
 * Resolve the admin credential (id + email + scrypt hash) by email, or undefined
 * if no such user exists. `passwordHash` is NULL for pairing-only users (M12 12.3);
 * the login route treats a null hash the same as a missing user (generic 401).
 *
 * M15 15.6 — pass `{ lock: true }` (inside a transaction) to take a `FOR SHARE` lock on the user
 * row. THE LOGIN PATH MUST DO THIS, and the reason is a race the 15.6 review measured rather than
 * theorised:
 *
 *   A login reads the hash, awaits (~100 ms of scrypt), then inserts a `sessions` row. A
 *   concurrent password RESET updates the hash and runs `revokeAllSessions` — a blind UPDATE, which
 *   cannot see a row a concurrent transaction has not inserted yet. Interleaved so the login's
 *   insert lands after the revoke, A SESSION MINTED FROM THE OLD PASSWORD SURVIVES THE RESET, for
 *   its full 7 days. That is exactly the account-takeover-recovery story D-15.6-6 exists to close,
 *   and it was reproducible at the HTTP layer with a small stagger (without one, the two handlers'
 *   blocking scrypt happens to serialise them the safe way, which is why no existing test saw it).
 *
 * THE MECHANISM IS THE LOCK, not the transaction (CLAUDE.md 15.5). `FOR SHARE` conflicts with the
 * `UPDATE users` that both credential-change paths run, so the two orderings are:
 *   - login first → it holds the lock through its insert; the reset's UPDATE blocks, and its
 *     `revokeAllSessions` therefore runs AFTER the new row exists and revokes it.
 *   - reset first → the login's locking read blocks, then re-evaluates under EvalPlanQual and sees
 *     the NEW hash, so the old password fails and no session is minted at all.
 * Both are correct; neither needs SERIALIZABLE or a retry loop.
 */
export async function findAdminCredential(
  db: DbClient,
  email: string,
  options?: { lock?: boolean },
): Promise<{ id: string; email: string; passwordHash: string | null } | undefined> {
  const query = db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  const [row] = await (options?.lock ? query.for("share") : query);
  return row;
}

/**
 * M15 15.8 — the ID-KEYED sibling of `findAdminCredential`, with the same `{ lock: true }`
 * `FOR SHARE` behaviour and the same return shape.
 *
 * WHY A SEPARATE FUNCTION RATHER THAN A REUSE. An MFA challenge carries a USER ID, deliberately: it
 * is the only identifier that cannot change between the two steps of a two-step login, whereas an
 * email can be reassigned. Going `id → email → findAdminCredential` on the way back would
 * re-introduce a lookup by a MUTABLE key at the exact moment the code is trying to prove nothing
 * mutated. Same reason `findUserEmailById` exists for the 15.7 SSO path.
 *
 * THE LOCK IS LOAD-BEARING HERE FOR THE SAME RACE `findAdminCredential` documents above, one step
 * further along, and it is the second half of a mechanism that would otherwise have a hole
 * (D-15.8-4). 15.6 held the lock across the login's scrypt so a concurrent password reset could not
 * have its `revokeAllSessions` run past a session about to be inserted. Splitting login into
 * "authenticate now, mint later" puts an UNBOUNDED gap in the middle — it spans a human reading a
 * code off their phone — and no lock reaches across that. So `POST /v1/auth/mfa/verify` re-reads the
 * credential HERE, under the lock, and compares the challenge's `cv` fingerprint against a freshly
 * recomputed one. Both orderings are then correct:
 *   - reset first  → the hash changed, the recomputed `cv` differs, and the challenge is refused.
 *   - verify first → `FOR SHARE` blocks the reset's `UPDATE users`, so the reset's
 *                    `revokeAllSessions` runs AFTER the new session row exists and revokes it.
 * Neither needs SERIALIZABLE nor a retry loop. The challenge's 5-minute TTL is a BOUND, not the
 * mechanism.
 */
export async function findCredentialById(
  db: DbClient,
  userId: string,
  options?: { lock?: boolean },
): Promise<{ id: string; email: string; passwordHash: string | null } | undefined> {
  const query = db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [row] = await (options?.lock ? query.for("share") : query);
  return row;
}

/**
 * Find-or-create a user by email AND set its password hash, returning the id
 * (idempotent). The env-seed (server.ts) calls this on every boot so rotating
 * ADMIN_PASSWORD + restart re-seeds the hash. Mirrors ensureUserByEmail.
 *
 * M15 15.1: also ensures the personal org. Because this runs on EVERY boot,
 * `ensurePersonalOrg`'s return-existing-first behavior is what stops a restart from
 * minting a second org.
 */
export async function setUserPassword(
  db: DbClient,
  email: string,
  passwordHash: string,
): Promise<string> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .insert(users)
    .values({ email: normalized, passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash } })
    .returning({ id: users.id });
  const id = row!.id;
  await ensurePersonalOrg(db, id, normalized);
  return id;
}

/**
 * Create a user WITH a password hash and return its id — and deliberately WITHOUT a personal
 * organization. This is the ONLY users-insert path that skips `ensurePersonalOrg`, and skipping
 * it is the entire point (D-15.5-9 / GOTCHA-1):
 *
 *   `findPrincipalByEmail` resolves the FIRST membership by (created_at, id). If an invited user
 *   were given a personal `owner` membership first, every subsequent request would resolve to
 *   THAT org — the invite would be a silent no-op, and every role assertion about them would
 *   secretly be testing an owner. That is not hypothetical; it is what the first run of
 *   `rbac.int.test.ts` actually did (see its comment at :135-142).
 *
 * The invite-accept path therefore calls this and then inserts EXACTLY ONE membership, in the
 * inviting org. Self-signup (D-15.5-6) is the opposite case and calls `ensurePersonalOrg`
 * explicitly, because a signup legitimately owns a brand-new org.
 *
 * Throws on a duplicate email (the unique index) — callers check first and return 409.
 */
export async function createUserWithPassword(
  db: DbClient,
  email: string,
  passwordHash: string,
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: normalizeEmail(email), passwordHash })
    .returning({ id: users.id });
  return row!.id;
}

/**
 * M15 15.7 — resolve a user's email by id, or undefined if the row is gone.
 *
 * The inverse of `findUserIdByEmail`, and it exists for exactly one caller: an SSO login resolved
 * through `(provider, subject)` knows only a `userId`, and `mintSession` signs the EMAIL as the
 * token's `sub`. Re-deriving it from the provider's assertion instead would be the takeover bug in
 * a different costume — the whole point of branch 1 is that the provider's email is not consulted.
 */
export async function findUserEmailById(db: DbClient, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email;
}

/**
 * M15 15.7 — create a user who has NO password, for an SSO-only account, returning its id. Like
 * its password-bearing sibling above it deliberately does NOT call `ensurePersonalOrg`, and for
 * exactly the same reason (D-15.5-9 / GOTCHA-1): the SSO invite-acceptance path inserts its one
 * membership through `acceptInvite`, and a personal `owner` membership created first would shadow
 * it forever, because `findPrincipalByEmail` resolves the FIRST membership by (created_at, id).
 * The SSO *signup* path is the other case and calls `ensurePersonalOrg` explicitly, exactly as
 * `POST /v1/auth/signup` does.
 *
 * `password_hash` stays NULL, which is not a gap but the whole point: `findAdminCredential`'s
 * callers already treat a null hash as "cannot log in with a password" (the generic 401 in
 * `POST /v1/auth/login`), so an SSO-only account is password-unopenable by construction rather than
 * by a check somebody has to remember to write. Such a user may still ADOPT a password later
 * through the ordinary reset flow, which requires control of the mailbox — that is a feature, and
 * it is also the recovery path named in the 0019 down-migration note.
 *
 * Throws on a duplicate email (the unique index) — callers check first and return 409.
 */
export async function createUserWithoutPassword(db: DbClient, email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: normalizeEmail(email) })
    .returning({ id: users.id });
  return row!.id;
}

/** Set (or replace) an existing user's password hash. Returns false if no such user. */
export async function updatePasswordHash(
  db: DbClient,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return rows.length > 0;
}
