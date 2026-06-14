import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { events, workspaceKeys, workspaces } from "../schema.js";

/**
 * Workspace + attribution repository (M5, PRD §6/§19). A workspace is a local dev
 * context; `workspace_keys` aliases the raw `events.project_path` (real path for
 * Claude/Codex, projectHash for Gemini) to it. `resolveWorkspaceId` +
 * `projectEventSummary` are the D5 attribution building blocks M6 materializes.
 *
 * Silent library (CLAUDE.md): throws, never logs. Scope EVERY query by userId.
 */

export interface WorkspaceRow {
  id: string;
  userId: string;
  projectId: string | null;
  machineId: string | null;
  rootPath: string;
  gitRemote: string | null;
  gitBranch: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * Upsert a workspace on `(user_id, root_path)`. On re-discovery, refreshes the
 * git metadata + last-seen but PRESERVES `project_id` (so a user's remap survives
 * — `project_id` is only changed via `remapWorkspace`). Returns the full row so
 * the caller can see whether a project is already mapped.
 */
export async function upsertWorkspace(
  db: DbClient,
  input: {
    userId: string;
    machineId?: string;
    rootPath: string;
    gitRemote?: string;
    gitBranch?: string;
    projectId?: string;
  },
): Promise<WorkspaceRow> {
  const [row] = await db
    .insert(workspaces)
    .values({
      userId: input.userId,
      machineId: input.machineId ?? null,
      rootPath: input.rootPath,
      gitRemote: input.gitRemote ?? null,
      gitBranch: input.gitBranch ?? null,
      projectId: input.projectId ?? null,
    })
    .onConflictDoUpdate({
      target: [workspaces.userId, workspaces.rootPath],
      set: {
        machineId: input.machineId ?? null,
        gitRemote: input.gitRemote ?? null,
        gitBranch: input.gitBranch ?? null,
        lastSeenAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/**
 * Record a connector's `project_key` alias for a workspace. Idempotent: upsert on
 * `(user_id, project_key)` — re-discovery is a no-op. The key is matched
 * byte-for-byte against `events.project_path` at attribution time (D2).
 */
export async function addWorkspaceKey(
  db: DbClient,
  input: { userId: string; workspaceId: string; sourceConnector: string; projectKey: string },
): Promise<void> {
  await db
    .insert(workspaceKeys)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      sourceConnector: input.sourceConnector,
      projectKey: input.projectKey,
    })
    .onConflictDoUpdate({
      target: [workspaceKeys.userId, workspaceKeys.projectKey],
      // Re-point the alias to the latest workspace if the same key reappears
      // under a different root (rare); keeps the join resolvable.
      set: { workspaceId: input.workspaceId, sourceConnector: input.sourceConnector },
    });
}

/** Repoint a workspace at a different project (the editable mapping, D4). */
export async function remapWorkspace(
  db: DbClient,
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceRow | undefined> {
  const [row] = await db
    .update(workspaces)
    .set({ projectId })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return row;
}

/** List a user's workspaces. */
export async function listWorkspaces(db: DbClient, userId: string): Promise<WorkspaceRow[]> {
  return db.select().from(workspaces).where(eq(workspaces.userId, userId));
}

/**
 * Resolve a raw connector `project_key` to its workspace + project (the D5
 * resolver). Returns `undefined` for an unknown key — events stay unattributed,
 * never throws (attribution is best-effort).
 */
export async function resolveWorkspaceId(
  db: DbClient,
  userId: string,
  projectKey: string,
): Promise<{ workspaceId: string; projectId: string | null } | undefined> {
  const [row] = await db
    .select({ workspaceId: workspaceKeys.workspaceId, projectId: workspaces.projectId })
    .from(workspaceKeys)
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(and(eq(workspaceKeys.userId, userId), eq(workspaceKeys.projectKey, projectKey)))
    .limit(1);
  return row;
}

/**
 * Per-project event summary (proves the D5 join end-to-end). Joins
 * `events.project_path = workspace_keys.project_key` for keys whose workspace is
 * mapped to `projectId`, then counts events + finds the latest activity. M6
 * materializes this at scale; M5 just proves the wiring is correct. Read-only.
 */
export async function projectEventSummary(
  db: DbClient,
  projectId: string,
): Promise<{ eventCount: number; lastActivity: string | null }> {
  const [row] = await db
    .select({
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      lastActivity: sql<string | null>`max(${events.ts})`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId));
  return { eventCount: row?.eventCount ?? 0, lastActivity: row?.lastActivity ?? null };
}
