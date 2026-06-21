import { and, eq, lt } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { machineHeartbeats, machines } from "../schema.js";

/**
 * How long an appended heartbeat sample is retained (M10 3c). `recordHeartbeat`
 * prunes this machine's samples older than this on every append, bounding the
 * time-series growth (~1 row / 30 s cadence). A DB-layer prune bound, not a wire
 * constant — kept local rather than in @420ai/shared.
 */
const HEARTBEAT_RETENTION_MS = 24 * 60 * 60_000; // 24 hours

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
 * Persist a collector heartbeat (M9, PRD §20) — the latest sync-backlog sample +
 * collector version, plus the purpose-built `lastHeartbeatAt` liveness stamp that
 * (unlike `lastSeenAt`) distinguishes idle-but-alive from offline (D5). The machine
 * row keeps only the CURRENT sample (M9 read path unchanged), AND — M10 3c (D6) —
 * appends the sample to the `machine_heartbeats` time-series (the trend source for
 * "backlog growing") then prunes that machine's samples beyond HEARTBEAT_RETENTION_MS.
 * `now` is injectable for deterministic tests; defaults to wall-clock and is computed
 * ONCE so the update stamp, the appended sample's ts, and the prune bound all agree.
 */
export async function recordHeartbeat(
  db: DbClient,
  machineId: string,
  hb: {
    queuePending: number;
    queueInflight: number;
    collectorVersion: string;
    consecutiveSyncFailures?: number; // M12 12.6 archive.unreachable signal (optional → null)
    now?: Date;
  },
): Promise<void> {
  const now = hb.now ?? new Date();
  await db
    .update(machines)
    .set({
      lastHeartbeatAt: now,
      queuePending: hb.queuePending,
      queueInflight: hb.queueInflight,
      collectorVersion: hb.collectorVersion,
      consecutiveSyncFailures: hb.consecutiveSyncFailures ?? null,
    })
    .where(eq(machines.id, machineId));
  // M10 3c: append the time-series sample (trend source) + prune beyond retention.
  await db.insert(machineHeartbeats).values({
    machineId,
    ts: now,
    queuePending: hb.queuePending,
    queueInflight: hb.queueInflight,
  });
  await db
    .delete(machineHeartbeats)
    .where(
      and(
        eq(machineHeartbeats.machineId, machineId),
        lt(machineHeartbeats.ts, new Date(now.getTime() - HEARTBEAT_RETENTION_MS)),
      ),
    );
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
