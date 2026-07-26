import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { pairingCodes } from "../schema.js";
import { getOrgIdForUser } from "./organizations.js";

/** Thrown when a pairing code is unknown, already consumed, or expired. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown" | "consumed" | "expired",
  ) {
    super(message);
    this.name = "PairingError";
  }
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Create a short-lived, single-use pairing code for a user (PRD §19). M15 15.1: the
 * code carries the issuing user's org so the machine it pairs lands in the right
 * tenant — the machine's org comes from the CODE, never from the pair request body.
 */
export async function createPairingCode(
  db: DbClient,
  userId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ code: string; expiresAt: Date }> {
  // M15 15.2: the org is deliberately resolved from `userId`, NOT taken from the
  // request principal. A pairing code is minted FOR A TARGET USER, and POST
  // /v1/pairing-codes accepts a `body.email` that may name someone other than the
  // caller (D-15.2-5 keeps that primitive until 15.5). Stamping the CALLER's org on a
  // code whose `user_id` belongs to another org would write a cross-org row.
  const orgId = await getOrgIdForUser(db, userId);
  const code = randomBytes(8).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(pairingCodes).values({ code, orgId, userId, expiresAt });
  return { code, expiresAt };
}

/**
 * Redeem a pairing code: validate + mark consumed atomically. Single-use.
 * Pass the transaction handle so this composes with createMachine/issueIngestToken.
 *
 * M15 15.1: returns the code's `orgId` alongside its `userId` so `pair.ts` can pass it
 * straight into `createMachine`. AUTH BOUNDARY (like `findMachineIdByToken`): the code
 * IS the credential and is read before any org context exists — NOTE FOR 15.3 that an
 * RLS policy on `pairing_codes` must permit this pre-context lookup.
 */
export async function redeemPairingCode(
  tx: DbClient,
  code: string,
): Promise<{ userId: string; orgId: string }> {
  const [row] = await tx.select().from(pairingCodes).where(eq(pairingCodes.code, code)).limit(1);

  if (!row) throw new PairingError("unknown pairing code", "unknown");
  if (row.consumedAt) throw new PairingError("pairing code already used", "consumed");
  if (row.expiresAt.getTime() < Date.now()) {
    throw new PairingError("pairing code expired", "expired");
  }

  await tx.update(pairingCodes).set({ consumedAt: new Date() }).where(eq(pairingCodes.code, code));

  return { userId: row.userId, orgId: row.orgId };
}
