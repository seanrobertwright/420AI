import { gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { ingestAuthFailures } from "../schema.js";

/**
 * M12 12.6 ingest auth-failure audit repository (PRD §20). A GLOBAL, append-only
 * log of invalid/revoked-token ingest attempts (the token never resolved to a
 * machine/user, so there is no user scope) — the source for the windowed
 * `ingest.auth_failure` alert via `deriveAuthFailureAlerts`.
 *
 * Mirrors `countPendingCatalogs` (global count) + `recordHeartbeat`'s prune. Silent
 * library (CLAUDE.md): throws, never logs. `now` is injectable for deterministic tests.
 */

/** Prune bound: failures older than this are dropped on every append (mirror HEARTBEAT_RETENTION_MS). */
const AUTH_FAILURE_RETENTION_MS = 7 * 24 * 60 * 60_000; // 7 days

/**
 * Append one ingest auth-failure + prune beyond retention. Best-effort caller in the
 * auth preHandler (a `.catch(() => {})` so it never alters the 401 contract).
 */
export async function recordIngestAuthFailure(
  db: DbClient,
  input?: { remoteIp?: string; now?: Date },
): Promise<void> {
  const now = input?.now ?? new Date();
  await db.insert(ingestAuthFailures).values({ ts: now, remoteIp: input?.remoteIp ?? null });
  await db
    .delete(ingestAuthFailures)
    .where(lt(ingestAuthFailures.ts, new Date(now.getTime() - AUTH_FAILURE_RETENTION_MS)));
}

/**
 * Count failures at/after `since` (the route passes `now - AUTH_FAILURE_ALERT.windowMs`).
 * `count(*)::int` → JS number (CLAUDE.md: a bare count is bigint → string without the cast).
 */
export async function countRecentAuthFailures(db: DbClient, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ingestAuthFailures)
    .where(gte(ingestAuthFailures.ts, since));
  return row?.n ?? 0;
}
