import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { ingestTokens } from "../schema.js";
import { generateToken, hashToken } from "../tokens.js";

/**
 * Issue a fresh ingest token for a machine. The plaintext is returned ONCE and
 * never stored — only its hash is persisted.
 */
export async function issueIngestToken(
  tx: DbClient,
  machineId: string,
): Promise<{ token: string }> {
  const token = generateToken();
  await tx.insert(ingestTokens).values({ machineId, tokenHash: hashToken(token) });
  return { token };
}

/**
 * Resolve a presented bearer token to its machine id by hash lookup. Returns
 * null for unknown or revoked tokens (the auth plugin maps that to 401).
 */
export async function findMachineIdByToken(db: DbClient, token: string): Promise<string | null> {
  const [row] = await db
    .select({ machineId: ingestTokens.machineId })
    .from(ingestTokens)
    .where(and(eq(ingestTokens.tokenHash, hashToken(token)), isNull(ingestTokens.revokedAt)))
    .limit(1);
  return row?.machineId ?? null;
}
