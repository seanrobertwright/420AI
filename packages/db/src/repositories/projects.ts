import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { projects } from "../schema.js";

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
  const inserted = await db
    .insert(projects)
    .values({ userId, name, gitRemote })
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

/** Create a project unconditionally (the remote-less / explicit-admin path). */
export async function createProject(
  db: DbClient,
  userId: string,
  name: string,
  gitRemote?: string,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(projects)
    .values({ userId, name, gitRemote: gitRemote ?? null })
    .returning({ id: projects.id });
  return { id: row!.id };
}

/** List a user's non-archived projects, newest first. */
export async function listProjects(db: DbClient, userId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), isNull(projects.archivedAt)))
    .orderBy(desc(projects.createdAt));
}

/** Rename a project (the editable mapping, D4). Returns the updated row, if any. */
export async function renameProject(
  db: DbClient,
  projectId: string,
  name: string,
): Promise<ProjectRow | undefined> {
  const [row] = await db
    .update(projects)
    .set({ name })
    .where(eq(projects.id, projectId))
    .returning();
  return row;
}

/** Look up a project's display name (for the discover mapping response). */
export async function getProjectName(db: DbClient, projectId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name;
}

/** Archive a project (soft delete — sets `archived_at`). */
export async function archiveProject(db: DbClient, projectId: string): Promise<void> {
  await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
}
