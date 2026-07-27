import { and, asc, eq } from "drizzle-orm";
import { hasRole, type Role } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { projectGrants } from "../schema.js";

/**
 * M15 15.4 — per-project capability grants (D-M15-4, D-15.4-2). Silent library (CLAUDE.md):
 * throws typed errors, never logs, never reads the clock (`created_at` defaults in the DB).
 *
 * GRANTS ELEVATE, NEVER RESTRICT. Org membership already confers visibility of every project
 * in the org; a grant raises ONE user's capability on ONE project. That direction is why no
 * read path in this repo gains a grants JOIN and no RLS policy becomes a correlated subquery —
 * the shape D-M15-2 rejected on performance grounds. A solo install holds zero grant rows and
 * therefore behaves byte-identically to pre-15.4 (D-M15-10).
 *
 * `DbClient`, not `Db`: every caller reaches these from inside an existing `withOrg`
 * transaction. `project_grants` carries a STRICT org policy, so an UNWRAPPED call reads zero
 * rows and silently reports "no grant" — which degrades to the org role, i.e. safe but
 * invisible. That is exactly the failure mode the 15.3 review caught on `alert_firings`, so it
 * is stated here rather than discovered later.
 */

export interface ProjectGrantRow {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

/**
 * The columns a `ProjectGrantRow` is made of. EXPLICIT rather than `select()`/`returning()`,
 * per the 15.1 lesson: no ingest route declares a Fastify `response` schema, so nothing strips
 * extra properties and a bare select puts every future column (starting with `org_id`) on the
 * wire. Keep this list == `ProjectGrantRow`.
 */
const projectGrantRowColumns = {
  id: projectGrants.id,
  projectId: projectGrants.projectId,
  userId: projectGrants.userId,
  role: projectGrants.role,
  createdAt: projectGrants.createdAt,
};

/** Every grant on one project within an org, oldest first. */
export async function listProjectGrants(
  db: DbClient,
  orgId: string,
  projectId: string,
): Promise<ProjectGrantRow[]> {
  return db
    .select(projectGrantRowColumns)
    .from(projectGrants)
    .where(and(eq(projectGrants.orgId, orgId), eq(projectGrants.projectId, projectId)))
    .orderBy(asc(projectGrants.createdAt), asc(projectGrants.id));
}

/**
 * Grant (or re-grant) a role on one project to one user. Idempotent: the unique index is
 * `(project_id, user_id)`, so a second call for the same pair UPDATES the role rather than
 * inserting a duplicate.
 *
 * `orgId` is deliberately absent from the conflict `set:` block, mirroring the ingest upsert
 * and `reconcileAlertFirings` (D-M15-2): an existing row keeps the org it was created under, so
 * a converging cross-org write can never flip a row's owner.
 */
export async function grantProjectRole(
  db: DbClient,
  orgId: string,
  projectId: string,
  userId: string,
  role: string,
): Promise<ProjectGrantRow> {
  const [row] = await db
    .insert(projectGrants)
    .values({ orgId, projectId, userId, role })
    .onConflictDoUpdate({
      target: [projectGrants.projectId, projectGrants.userId],
      set: { role },
    })
    .returning(projectGrantRowColumns);
  return row!;
}

/** Remove a user's grant on a project. Returns true when a row was actually removed. */
export async function revokeProjectGrant(
  db: DbClient,
  orgId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const removed = await db
    .delete(projectGrants)
    .where(
      and(
        eq(projectGrants.orgId, orgId),
        eq(projectGrants.projectId, projectId),
        eq(projectGrants.userId, userId),
      ),
    )
    .returning({ id: projectGrants.id });
  return removed.length > 0;
}

/**
 * The effective capability a user has on ONE project: the HIGHER of their org membership role
 * and any project grant (D-15.4-2 — grants ELEVATE, never restrict). No grant row ⇒ the org
 * role, unchanged, which is why a solo install behaves exactly as it did before 15.4.
 *
 * A grant BELOW the org role is a no-op, not a demotion. That is the whole asymmetry: this
 * table can only ever add capability, so no query anywhere has to consult it in order to be
 * SAFE — only in order to be generous.
 */
export async function effectiveProjectRole(
  db: DbClient,
  orgId: string,
  projectId: string,
  userId: string,
  orgRole: string,
): Promise<string> {
  const [row] = await db
    .select({ role: projectGrants.role })
    .from(projectGrants)
    .where(
      and(
        eq(projectGrants.orgId, orgId),
        eq(projectGrants.projectId, projectId),
        eq(projectGrants.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return orgRole;
  // `hasRole(grant, orgRole)` asks "is the grant at least the org role?". An unknown orgRole
  // string makes `hasRole` fail closed, so a corrupt membership row degrades to itself rather
  // than being silently elevated by any grant.
  return hasRole(row.role, orgRole as Role) ? row.role : orgRole;
}
