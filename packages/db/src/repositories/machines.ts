import { eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { machines } from "../schema.js";

/** Register a machine for a user. Returns its generated id. */
export async function createMachine(
  tx: DbClient,
  input: { userId: string; name: string; os?: string; hostname?: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(machines)
    .values({
      userId: input.userId,
      name: input.name,
      os: input.os,
      hostname: input.hostname,
    })
    .returning({ id: machines.id });
  return { id: row!.id };
}

/** Record that a machine just authenticated (for last-seen / liveness, PRD §20). */
export async function touchLastSeen(db: DbClient, machineId: string): Promise<void> {
  await db
    .update(machines)
    .set({ lastSeenAt: new Date() })
    .where(eq(machines.id, machineId));
}

/**
 * Resolve the owning user for an authenticated machine (M5 discovery is machine-
 * authed but writes user-scoped workspaces/projects). Returns undefined for an
 * unknown machine id.
 */
export async function getMachineUserId(
  db: DbClient,
  machineId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: machines.userId })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  return row?.userId;
}
