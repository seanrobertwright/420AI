import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { projects } from "../schema.js";
import { getOrgIdForUser } from "./organizations.js";

/**
 * Project repository (M5, PRD §6). A project is a software effort; cross-machine
 * identity is by `git_remote`. Repositories are SILENT (CLAUDE.md): they throw
 * typed errors, never log. Mirrors the `repositories/ingest.ts` upsert style.
 */

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  gitRemote: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

/**
 * The columns a ProjectRow is made of. EXPLICIT rather than `select()` so that adding a
 * column to the table never silently widens the API — the ingest routes send these rows
 * straight to `reply.send()` with no Fastify response schema to strip extras, so a bare
 * `select()` put M15's `org_id` on the wire. Keep this list == ProjectRow.
 */
const projectRowColumns = {
  id: projects.id,
  userId: projects.userId,
  name: projects.name,
  gitRemote: projects.gitRemote,
  createdAt: projects.createdAt,
  archivedAt: projects.archivedAt,
};

/**
 * Find-or-create a project by its git remote (the unify-by-remote default, D4).
 * The SAME remote across machines maps to ONE project. Returns `created: false`
 * when the project already existed — so re-discovery is idempotent and a user's
 * earlier rename is NOT clobbered (we never overwrite `name` on conflict).
 *
 * Only call this when `gitRemote` is non-null; remote-less workspaces have no
 * natural key (Postgres NULLs are distinct in the unique index) → use
 * `createProject` for those.
 */
export async function findOrCreateProjectByRemote(
  db: DbClient,
  userId: string,
  gitRemote: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  // M15 15.2: this write is reached ONLY from the MACHINE-authed
  // POST /v1/workspaces/discover, where there is no request principal to take an
  // org from — the caller is a collector bearing a machine token. `getOrgIdForUser`
  // therefore SURVIVES here by design; D-M15-7 (slice 15.9) is where the machine
  // credential tier gets its own org resolution.
  const orgId = await getOrgIdForUser(db, userId);
  const inserted = await db
    .insert(projects)
    .values({ orgId, userId, name, gitRemote })
    .onConflictDoNothing({ target: [projects.userId, projects.gitRemote] })
    .returning({ id: projects.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.gitRemote, gitRemote)))
    .limit(1);
  return { id: existing!.id, created: false };
}

/**
 * Create a project unconditionally (the remote-less / explicit-admin path).
 *
 * M15 15.4 — `orgId` is now an explicit SECOND parameter rather than a `getOrgIdForUser`
 * lookup inside the function. The only caller is the machine-authed
 * POST /v1/workspaces/discover, which resolves the org ONCE at the route and passes it here —
 * one query instead of one per project, and it retires another 15.1 seam.
 *
 * `getOrgIdForUser` is NOT deleted: `findOrCreateProjectByRemote`, `upsertWorkspace` and
 * `addWorkspaceKey` still need it, and `createPairingCode` must keep it (D-15.2-5 — it writes
 * a row for a TARGET user who may not be the caller).
 */
export async function createProject(
  db: DbClient,
  orgId: string,
  userId: string,
  name: string,
  gitRemote?: string,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(projects)
    .values({ orgId, userId, name, gitRemote: gitRemote ?? null })
    .returning({ id: projects.id });
  return { id: row!.id };
}

/**
 * List an ORG's non-archived projects, newest first. Optionally paged (M13
 * 13.4): `limit`/`offset` apply ONLY when provided — an omitted limit returns
 * the FULL list, because several consumers depend on completeness (the project
 * detail page's existence authority, the workspace-remap picker, the
 * collector's mapping flows). The paged dashboard list passes an explicit
 * limit. `createdAt` then `id` orders deterministically so offset pages never
 * duplicate/drop a row.
 *
 * M15 15.4 — `orgId` SECOND, and it REPLACES the `userId` predicate rather than joining it.
 * D-15.4-2 is explicit: every org member sees every project in the org. Keeping `user_id` would
 * have left RLS as the sole tenant boundary (the inverse of D-M15-3) AND hidden a colleague's
 * projects from a legitimate member.
 */
export async function listProjects(
  db: DbClient,
  orgId: string,
  page?: { limit?: number; offset?: number },
): Promise<ProjectRow[]> {
  const query = db
    .select(projectRowColumns)
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.archivedAt)))
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .$dynamic();
  if (page?.limit !== undefined) query.limit(page.limit);
  if (page?.offset !== undefined) query.offset(page.offset);
  return query;
}

/** Rename a project (the editable mapping, D4). Returns the updated row, if any. */
export async function renameProject(
  db: DbClient,
  orgId: string,
  projectId: string,
  name: string,
): Promise<ProjectRow | undefined> {
  const [row] = await db
    .update(projects)
    .set({ name })
    // M15 15.2: org-scoped — without it another tenant could RENAME this project.
    // A miss returns undefined, which the route already turns into 404.
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .returning(projectRowColumns);
  return row;
}

/**
 * Look up a project's display name (for the discover mapping response).
 *
 * M15 15.2: org-scoped. This doubles as the EXISTENCE CHECK on the report-generation
 * write path, so an unscoped version let one tenant generate a report against another
 * tenant's project id — and the other tenant's project NAME was rendered into the
 * resulting Markdown. Unknown id and other-org id are now both `undefined` → 404.
 */
export async function getProjectName(
  db: DbClient,
  orgId: string,
  projectId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  return row?.name;
}

/** Archive a project (soft delete — sets `archived_at`). */
export async function archiveProject(
  db: DbClient,
  orgId: string,
  projectId: string,
): Promise<void> {
  // M15 15.2: org-scoped — archiving is a WRITE; another tenant must not reach it.
  await db
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
}
