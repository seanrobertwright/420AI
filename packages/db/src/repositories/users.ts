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
 */
export async function findAdminCredential(
  db: DbClient,
  email: string,
): Promise<{ id: string; email: string; passwordHash: string | null } | undefined> {
  const [row] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
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
