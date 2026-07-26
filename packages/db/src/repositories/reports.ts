import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { reportArtifacts } from "../schema.js";
import { getOrgIdForUser } from "./organizations.js";

/**
 * Report-artifact repository (M7, PRD §15/§23). Durable, VERSIONED report storage:
 * regenerating a report for the same (userId, reportType, scopeId) appends a new
 * row with `version = max(version)+1` — prior artifacts are retained (history).
 * Silent library (CLAUDE.md): throws, never logs. Mirrors `repositories/projects.ts`
 * (typed Row, `insert ... returning`, `eq`/`and`/`desc`) + `repositories/ingest.ts`
 * (the `db.transaction` used to compute-then-insert the version atomically).
 */

export interface ReportArtifactRow {
  id: string;
  userId: string;
  projectId: string | null;
  reportType: string;
  scopeKind: string;
  scopeId: string;
  version: number;
  reportVersion: string;
  catalogVersion: string | null; // pricing catalog the cost metrics were rendered under (PRD §23)
  analysisVersion: string | null; // AI Interpretation Pipeline identity (AI artifacts only; else NULL)
  params: unknown;
  metrics: unknown;
  markdown: string;
  generatedAt: Date;
}

/**
 * The columns a ReportArtifactRow is made of. EXPLICIT rather than `select()`/bare
 * `returning()` so a new table column never silently widens the API — `GET /v1/reports`
 * and `GET /v1/reports/:id` send these rows verbatim with no response schema to strip
 * extras, so a bare select put M15's `org_id` on the wire. Keep == ReportArtifactRow.
 */
const reportArtifactRowColumns = {
  id: reportArtifacts.id,
  userId: reportArtifacts.userId,
  projectId: reportArtifacts.projectId,
  reportType: reportArtifacts.reportType,
  scopeKind: reportArtifacts.scopeKind,
  scopeId: reportArtifacts.scopeId,
  version: reportArtifacts.version,
  reportVersion: reportArtifacts.reportVersion,
  catalogVersion: reportArtifacts.catalogVersion,
  analysisVersion: reportArtifacts.analysisVersion,
  params: reportArtifacts.params,
  metrics: reportArtifacts.metrics,
  markdown: reportArtifacts.markdown,
  generatedAt: reportArtifacts.generatedAt,
};

/**
 * Insert a new artifact, bumping `version` per (userId, reportType, scopeId). The
 * max-version read and the insert run in ONE transaction; the
 * `report_artifacts_scope_version` unique index is the backstop if two generations
 * race (single-user → low contention, but correct). `metrics`/`params` are passed
 * as JS objects — Drizzle serializes them to jsonb. Returns the stored row.
 */
export async function insertReportArtifact(
  db: DbClient,
  a: Omit<ReportArtifactRow, "id" | "version" | "generatedAt">,
): Promise<ReportArtifactRow> {
  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select({ v: sql<number>`coalesce(max(${reportArtifacts.version}), 0)::int` })
      .from(reportArtifacts)
      .where(
        and(
          eq(reportArtifacts.userId, a.userId),
          eq(reportArtifacts.reportType, a.reportType),
          eq(reportArtifacts.scopeId, a.scopeId),
        ),
      );
    const version = (prev?.v ?? 0) + 1;
    // M15 15.1: superseded by the 15.2 request principal.
    const orgId = await getOrgIdForUser(tx, a.userId);
    const [row] = await tx
      .insert(reportArtifacts)
      .values({ ...a, orgId, version })
      .returning(reportArtifactRowColumns);
    return row as ReportArtifactRow;
  });
}

/** Fetch a single artifact by id, or undefined if no row matches. */
export async function getReportArtifact(
  db: DbClient,
  id: string,
): Promise<ReportArtifactRow | undefined> {
  const [row] = await db
    .select(reportArtifactRowColumns)
    .from(reportArtifacts)
    .where(eq(reportArtifacts.id, id))
    .limit(1);
  return row as ReportArtifactRow | undefined;
}

/**
 * List a user's artifacts, newest first (by version within a scope, then
 * generation time). Optionally filtered by `reportType` and/or `scopeId` — the
 * history view for one (type, scope) series. Optionally paged (M13 13.4):
 * `limit`/`offset` apply ONLY when provided — an omitted limit returns the full
 * list (pre-13.4 behavior; the paged dashboard list passes an explicit limit).
 * The `id` tiebreaker keeps offset pages deterministic when two artifacts share
 * a `generatedAt`.
 */
export async function listReportArtifacts(
  db: DbClient,
  userId: string,
  filter?: { reportType?: string; scopeId?: string; limit?: number; offset?: number },
): Promise<ReportArtifactRow[]> {
  const conditions = [eq(reportArtifacts.userId, userId)];
  if (filter?.reportType) conditions.push(eq(reportArtifacts.reportType, filter.reportType));
  if (filter?.scopeId) conditions.push(eq(reportArtifacts.scopeId, filter.scopeId));
  const query = db
    .select(reportArtifactRowColumns)
    .from(reportArtifacts)
    .where(and(...conditions))
    .orderBy(
      desc(reportArtifacts.generatedAt),
      desc(reportArtifacts.version),
      desc(reportArtifacts.id),
    )
    .$dynamic();
  if (filter?.limit !== undefined) query.limit(filter.limit);
  if (filter?.offset !== undefined) query.offset(filter.offset);
  const rows = await query;
  return rows as ReportArtifactRow[];
}
