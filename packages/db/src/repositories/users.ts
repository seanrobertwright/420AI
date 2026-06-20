import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { users } from "../schema.js";

/**
 * User lookups for the single-user admin surface (M2/M5). The pairing flow
 * upserts a user by email; the M5 admin endpoints resolve that same user to
 * scope projects/workspaces. Silent library — throws, never logs.
 */

/** Resolve a user id by email, or undefined if none exists yet. */
export async function findUserIdByEmail(
  db: DbClient,
  email: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.id;
}

/** Find-or-create a user by email and return its id (idempotent). */
export async function ensureUserByEmail(db: DbClient, email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email })
    .onConflictDoUpdate({ target: users.email, set: { email } })
    .returning({ id: users.id });
  return row!.id;
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
  return row!.id;
}
