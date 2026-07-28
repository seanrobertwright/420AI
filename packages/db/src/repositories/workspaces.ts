import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { events, workspaceKeys, workspaces } from "../schema.js";
import { getOrgIdForUser } from "./organizations.js";

/**
 * Workspace + attribution repository (M5, PRD §6/§19). A workspace is a local dev
 * context; `workspace_keys` aliases the raw `events.project_path` (real path for
 * Claude/Codex, projectHash for Gemini) to it. `resolveWorkspaceId` +
 * `projectEventSummary` are the D5 attribution building blocks M6 materializes.
 *
 * Silent library (CLAUDE.md): throws, never logs. M15 15.4: scope EVERY query by `orgId`
 * (the tenant boundary); add `userId` only where a row's identity is genuinely per-user —
 * `resolveWorkspaceId` documents the one case in this file.
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
 * The columns a WorkspaceRow is made of. EXPLICIT rather than `select()`/bare
 * `returning()` so a new table column never silently widens the API — these rows go
 * straight to `reply.send()` and no route declares a response schema. Keep == WorkspaceRow.
 */
const workspaceRowColumns = {
  id: workspaces.id,
  userId: workspaces.userId,
  projectId: workspaces.projectId,
  machineId: workspaces.machineId,
  rootPath: workspaces.rootPath,
  gitRemote: workspaces.gitRemote,
  gitBranch: workspaces.gitBranch,
  createdAt: workspaces.createdAt,
  lastSeenAt: workspaces.lastSeenAt,
};

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
  // M15 15.2: this write is reached ONLY from the MACHINE-authed
  // POST /v1/workspaces/discover, where there is no request principal to take an
  // org from — the caller is a collector bearing a machine token. `getOrgIdForUser`
  // therefore SURVIVES here by design; D-M15-7 (slice 15.9) is where the machine
  // credential tier gets its own org resolution.
  const orgId = await getOrgIdForUser(db, input.userId);
  const [row] = await db
    .insert(workspaces)
    .values({
      orgId,
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
    .returning(workspaceRowColumns);
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
  // M15 15.2: this write is reached ONLY from the MACHINE-authed
  // POST /v1/workspaces/discover, where there is no request principal to take an
  // org from — the caller is a collector bearing a machine token. `getOrgIdForUser`
  // therefore SURVIVES here by design; D-M15-7 (slice 15.9) is where the machine
  // credential tier gets its own org resolution.
  const orgId = await getOrgIdForUser(db, input.userId);
  await db
    .insert(workspaceKeys)
    .values({
      orgId,
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

/**
 * Repoint a workspace at a different project (the editable mapping, D4).
 *
 * M15 15.4 — `orgId` SECOND, REPLACING the `userId` predicate. This is a WRITE that was scoped
 * by `userId` alone, so RLS was the only thing stopping a cross-tenant remap. It is org-scoped
 * rather than (org,user)-scoped to stay consistent with `listWorkspaces`: a member who can SEE a
 * colleague's workspace in the list must be able to act on it, or the UI offers a row that 404s.
 */
export async function remapWorkspace(
  db: DbClient,
  orgId: string,
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceRow | undefined> {
  const [row] = await db
    .update(workspaces)
    .set({ projectId })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)))
    .returning(workspaceRowColumns);
  return row;
}

/** List an ORG's workspaces (M15 15.4 — org-scoped, `orgId` second; see `listProjects`). */
export async function listWorkspaces(db: DbClient, orgId: string): Promise<WorkspaceRow[]> {
  return db.select(workspaceRowColumns).from(workspaces).where(eq(workspaces.orgId, orgId));
}

/**
 * Resolve a raw connector `project_key` to its workspace + project (the D5
 * resolver). Returns `undefined` for an unknown key — events stay unattributed,
 * never throws (attribution is best-effort).
 *
 * M15 15.4 — `orgId` SECOND, and this one KEEPS its `userId` predicate where the visibility
 * reads dropped theirs. It is not a UI read: it is the ingest/discover attribution resolver, and
 * `workspace_keys`' unique index is `(user_id, project_key)`. Two users in one org can therefore
 * legitimately hold the SAME `project_key` for different roots, and an org-wide lookup would
 * return an arbitrary one of them — silently mis-attributing events. `project_key` is also a
 * CONNECTOR-SUPPLIED string (the 15.2 lesson), so both sides of the join are org-scoped too.
 */
export async function resolveWorkspaceId(
  db: DbClient,
  orgId: string,
  userId: string,
  projectKey: string,
): Promise<{ workspaceId: string; projectId: string | null } | undefined> {
  const [row] = await db
    .select({ workspaceId: workspaceKeys.workspaceId, projectId: workspaces.projectId })
    .from(workspaceKeys)
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaceKeys.orgId, orgId),
        eq(workspaces.orgId, orgId),
        eq(workspaceKeys.userId, userId),
        eq(workspaceKeys.projectKey, projectKey),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Per-project event summary (proves the D5 join end-to-end). Joins
 * `events.project_path = workspace_keys.project_key` for keys whose workspace is
 * mapped to `projectId`, then counts events + finds the latest activity. M6
 * materializes this at scale; M5 just proves the wiring is correct. Read-only.
 *
 * M15 15.2: takes `orgId` for the same reason the M6 rollups do — the join key is
 * `project_path`, a connector-supplied string two tenants can share.
 */
export async function projectEventSummary(
  db: DbClient,
  orgId: string,
  projectId: string,
): Promise<{ eventCount: number; lastActivity: string | null }> {
  const [row] = await db
    .select({
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      // events.ts is mode:"string" — max(ts) comes back as an ISO string, not a Date.
      lastActivity: sql<string | null>`max(${events.ts})`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        eq(workspaceKeys.orgId, orgId),
        eq(events.orgId, orgId),
      ),
    );
  return { eventCount: row?.eventCount ?? 0, lastActivity: row?.lastActivity ?? null };
}
