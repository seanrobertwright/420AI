import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";

/**
 * User lookups for the single-user admin surface (M2/M5). The pairing flow
 * upserts a user by email; the M5 admin endpoints resolve that same user to
 * scope projects/workspaces. Silent library — throws, never logs.
 */

/** Resolve a user id by email, or undefined if none exists yet. */
export async function findUserIdByEmail(db: DbClient, email: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
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
  const [row] = await db
    .insert(users)
    .values({ email })
    .onConflictDoUpdate({ target: users.email, set: { email } })
    .returning({ id: users.id });
  const id = row!.id;
  await ensurePersonalOrg(db, id, email);
  return id;
}

/**
 * Resolve the admin credential (id + email + scrypt hash) by email, or undefined
 * if no such user exists. `passwordHash` is NULL for pairing-only users (M12 12.3);
 * the login route treats a null hash the same as a missing user (generic 401).
 */
export async function findAdminCredential(
  db: DbClient,
  email: string,
): Promise<{ id: string; email: string; passwordHash: string | null } | undefined> {
  const [row] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
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
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash } })
    .returning({ id: users.id });
  const id = row!.id;
  await ensurePersonalOrg(db, id, email);
  return id;
}
