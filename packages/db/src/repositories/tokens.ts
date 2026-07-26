import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { ingestTokens } from "../schema.js";
import { generateToken, hashToken } from "../tokens.js";
import { getMachineOrgId } from "./machines.js";

/**
 * Issue a fresh ingest token for a machine. The plaintext is returned ONCE and
 * never stored — only its hash is persisted. M15 15.1: the org is derived from
 * `machines.org_id` (the authority for machine-keyed writes).
 */
export async function issueIngestToken(
  tx: DbClient,
  machineId: string,
): Promise<{ token: string }> {
  const orgId = await getMachineOrgId(tx, machineId);
  if (!orgId) throw new Error(`unknown machine ${machineId}`);
  const token = generateToken();
  await tx.insert(ingestTokens).values({ orgId, machineId, tokenHash: hashToken(token) });
  return { token };
}

/**
 * Resolve a presented bearer token to its machine id by hash lookup. Returns
 * null for unknown or revoked tokens (the auth plugin maps that to 401).
 *
 * M15 15.1 AUTH BOUNDARY — deliberately org-AGNOSTIC and its signature is unchanged.
 * This read happens BEFORE any org context exists; it is what establishes the context.
 * NOTE FOR 15.3: when RLS is enabled, `ingest_tokens` needs a policy that permits this
 * pre-context lookup (or must be excluded) — do not scope this query by org.
 */
export async function findMachineIdByToken(db: DbClient, token: string): Promise<string | null> {
  const [row] = await db
    .select({ machineId: ingestTokens.machineId })
    .from(ingestTokens)
    .where(and(eq(ingestTokens.tokenHash, hashToken(token)), isNull(ingestTokens.revokedAt)))
    .limit(1);
  return row?.machineId ?? null;
}
