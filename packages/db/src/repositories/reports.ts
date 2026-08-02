import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, DbClient } from "../client.js";
import { withOrg } from "../org-context.js";
import { reportArtifacts } from "../schema.js";

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
 * Attempts before a version conflict surfaces to the caller. 12 absorbs ≥16-way
 * concurrent generation (measured during 15.2 planning); 6 did not — 6 of 16 still
 * failed. Chosen from measurement, not taste.
 */
const MAX_VERSION_ATTEMPTS = 12;

/**
 * True for the `report_artifacts_scope_version` unique violation — i.e. "another
 * generation claimed this version first", the ONLY error worth retrying here.
 * Drizzle WRAPS the driver error, so the pg `code`/`constraint` fields live on
 * `.cause` (same shape asserted in tenancy.int.test.ts).
 */
export function isVersionConflict(e: unknown): boolean {
  const c = (e as { cause?: { code?: string; constraint?: string } })?.cause;
  return c?.code === "23505" && c?.constraint === "report_artifacts_scope_version";
}

/**
 * Insert a new artifact, bumping `version` per (userId, reportType, scopeId). The
 * max-version read and the insert run in ONE transaction; the
 * `report_artifacts_scope_version` unique index is the backstop if two generations
 * race. `metrics`/`params` are passed as JS objects — Drizzle serializes them to
 * jsonb. Returns the stored row.
 *
 * M15 15.2 — RETRY, not a bigger transaction. Under READ COMMITTED the `max(version)+1`
 * read inside a transaction does not see a concurrent uncommitted insert, so N racing
 * generations all compute the same version and N-1 hit the unique index (measured: at
 * N=8, 2 succeeded and 6 returned 500). The retry MUST wrap the WHOLE transaction —
 * a failed statement aborts the surrounding one, so retrying inside it errors with
 * `current transaction is aborted`. Hence `Db`, not `DbClient`: re-opening a
 * transaction is something a `Tx` cannot do. (Verified: both callers pass a `Db`.)
 *
 * `orgId` now comes in on `a` from the request principal instead of a
 * `getOrgIdForUser` lookup inside the transaction — one less query per generation,
 * and it retires one of 15.1's temporary seams.
 *
 * M15 15.3 (D-15.3-6) — this function calls `withOrg` INTERNALLY, once per retry attempt, and
 * its ROUTE deliberately does not wrap it. The paragraph above is exactly why: `withOrg` opens
 * the transaction, so each attempt gets a fresh transaction AND a fresh `set_config`. Move the
 * retry inside `withOrg` and attempt 2 dies on `current transaction is aborted`; wrap the route
 * instead and this receives a `Tx` where it needs a `Db` (a compile error — and forcing past it
 * reintroduces the same abort). The `Db` parameter is load-bearing. Do not "fix" it.
 *
 * M15 15.4 — `role` is threaded from the caller (ultimately `principal.role` at the generating
 * route, which gates at `member`). It is NOT hardcoded and NOT `SERVICE_ROLE`: report generation
 * is a user action on the user's behalf, so the 0016 restrictive INSERT policy is a genuine
 * backstop here. It sits before `a` rather than inside it because `a` is spread into
 * `.values()` — a `role` field there would try to insert a column that does not exist.
 */
export async function insertReportArtifact(
  db: Db,
  role: string,
  a: Omit<ReportArtifactRow, "id" | "version" | "generatedAt"> & { orgId: string },
): Promise<ReportArtifactRow> {
  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt++) {
    try {
      return await withOrg(db, a.orgId, role, async (tx) => {
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
        const [row] = await tx
          .insert(reportArtifacts)
          .values({ ...a, version })
          .returning(reportArtifactRowColumns);
        return row as ReportArtifactRow;
      });
    } catch (e) {
      if (!isVersionConflict(e) || attempt === MAX_VERSION_ATTEMPTS) throw e;
      // Lost the race — another generation took this version. Re-read and retry.
    }
  }
  /* c8 ignore next -- unreachable: the loop either returns or throws on the last attempt */
  throw new Error("unreachable");
}

/**
 * Fetch a single artifact by id WITHIN an org, or undefined if no row matches.
 *
 * M15 15.2: an unknown id and another org's id are deliberately indistinguishable —
 * both yield `undefined`, which the route turns into 404. Never 403: that would leak
 * the existence of another tenant's report.
 */
export async function getReportArtifact(
  db: DbClient,
  orgId: string,
  id: string,
): Promise<ReportArtifactRow | undefined> {
  const [row] = await db
    .select(reportArtifactRowColumns)
    .from(reportArtifacts)
    .where(and(eq(reportArtifacts.id, id), eq(reportArtifacts.orgId, orgId)))
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
  orgId: string,
  userId: string,
  filter?: { reportType?: string; scopeId?: string; limit?: number; offset?: number },
): Promise<ReportArtifactRow[]> {
  // M15 15.2: org AND user — defense in depth. The route passes both from ONE principal,
  // so they cannot disagree; the org predicate is what survives if user-scoping is ever
  // widened (e.g. M16's shared-org views).
  const conditions = [eq(reportArtifacts.orgId, orgId), eq(reportArtifacts.userId, userId)];
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
