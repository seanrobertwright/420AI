import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { pairingCodes } from "../schema.js";

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

/** Create a short-lived, single-use pairing code for a user (PRD §19). */
export async function createPairingCode(
  db: DbClient,
  userId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(8).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(pairingCodes).values({ code, userId, expiresAt });
  return { code, expiresAt };
}

/**
 * Redeem a pairing code: validate + mark consumed atomically. Single-use.
 * Pass the transaction handle so this composes with createMachine/issueIngestToken.
 */
export async function redeemPairingCode(tx: DbClient, code: string): Promise<{ userId: string }> {
  const [row] = await tx.select().from(pairingCodes).where(eq(pairingCodes.code, code)).limit(1);

  if (!row) throw new PairingError("unknown pairing code", "unknown");
  if (row.consumedAt) throw new PairingError("pairing code already used", "consumed");
  if (row.expiresAt.getTime() < Date.now()) {
    throw new PairingError("pairing code expired", "expired");
  }

  await tx.update(pairingCodes).set({ consumedAt: new Date() }).where(eq(pairingCodes.code, code));

  return { userId: row.userId };
}
