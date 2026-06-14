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
