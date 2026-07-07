import type { FastifyInstance } from "fastify";
import {
  getReportArtifact,
  listReportArtifacts,
  getProjectName,
  findUserIdByEmail,
  ensureUserByEmail,
  indexReportDoc,
} from "@420ai/db";
import {
  generateProjectCostReport,
  generateSessionAutopsyReport,
} from "../reports/generate-report.js";
import {
  generateContextWasteReport,
  generateFailedToolCallsReport,
  generateProjectEfficiencyReport,
  generateToolModelComparisonReport,
  generateTrendAnomaliesReport,
} from "../reports/generate-report-m13.js";
import {
  generateProjectReportBodySchema,
  generateSessionReportBodySchema,
  listReportsQuerySchema,
} from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

type ProjectReportType =
  | "project.cost_over_time"
  | "project.tool_model_comparison"
  | "project.failed_tool_calls"
  | "project.context_waste"
  | "project.efficiency"
  | "project.trend_anomalies";

interface GenerateProjectReportBody {
  type?: ProjectReportType;
  bucket?: "day" | "week";
}
interface GenerateSessionReportBody {
  type?: "session.autopsy";
}

/**
 * M7 report generation + retrieval endpoints (PRD §15, D6). All admin-gated
 * (mirrors routes/projections.ts) — these are dashboard/reporting ops, not the
 * machine-authed write path. Generation is intentionally NON-idempotent: each POST
 * appends a new versioned artifact (the inverse of the event fingerprint upsert).
 * The route owns the clock (`generatedAt`); the orchestrator/renderer are clock-free.
 * The single-user owner is resolved via ensureUserByEmail/findUserIdByEmail (D2
 * precedence rule — artifacts are user-owned, so resolving the id is required).
 */
export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: GenerateProjectReportBody }>(
    "/v1/projects/:id/reports",
    { schema: { body: generateProjectReportBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      // A well-formed-but-nonexistent project id must 404 here, BEFORE the insert:
      // report_artifacts.project_id FKs to projects.id, so generating against a
      // missing project would raise an FK-violation 500 instead of a clean 404.
      // getProjectName returns undefined only when the project does not exist (an
      // existing-but-empty project still returns its name → D7 all-zero report).
      if (!(await getProjectName(app.db, request.params.id))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const userId = await ensureUserByEmail(app.db, app.adminEmail);
      const bucket = request.body.bucket ?? "day";
      const generatedAt = new Date().toISOString();
      const type = request.body.type ?? "project.cost_over_time";
      const row = await (async () => {
        switch (type) {
          case "project.cost_over_time":
            return generateProjectCostReport(
              app.db,
              userId,
              request.params.id,
              bucket,
              generatedAt,
            );
          case "project.tool_model_comparison":
            return generateToolModelComparisonReport(
              app.db,
              userId,
              request.params.id,
              generatedAt,
            );
          case "project.failed_tool_calls":
            return generateFailedToolCallsReport(
              app.db,
              userId,
              request.params.id,
              bucket,
              generatedAt,
            );
          case "project.context_waste":
            return generateContextWasteReport(app.db, userId, request.params.id, generatedAt);
          case "project.efficiency":
            return generateProjectEfficiencyReport(app.db, userId, request.params.id, generatedAt);
          case "project.trend_anomalies":
            return generateTrendAnomaliesReport(
              app.db,
              userId,
              request.params.id,
              bucket,
              generatedAt,
            );
        }
      })();
      // 13.4: refresh the artifact's search doc best-effort (awaited-with-swallow,
      // the deliverFirings pattern — never fails the response).
      try {
        await indexReportDoc(app.db, row.id);
      } catch (err) {
        request.log.warn({ err }, "report search indexing failed");
      }
      return reply.code(201).send(row);
    },
  );

  app.post<{ Params: { sessionId: string }; Body: GenerateSessionReportBody }>(
    "/v1/sessions/:sessionId/reports",
    { schema: { body: generateSessionReportBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      // sessionId is a connector text id (NOT a uuid) — ungated; unknown → zeroed autopsy.
      const userId = await ensureUserByEmail(app.db, app.adminEmail);
      const generatedAt = new Date().toISOString();
      const row = await generateSessionAutopsyReport(
        app.db,
        userId,
        request.params.sessionId,
        generatedAt,
      );
      // 13.4: refresh the artifact's search doc best-effort (awaited-with-swallow,
      // the deliverFirings pattern — never fails the response).
      try {
        await indexReportDoc(app.db, row.id);
      } catch (err) {
        request.log.warn({ err }, "report search indexing failed");
      }
      return reply.code(201).send(row);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/reports/:id", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "report not found" });
    }
    const row = await getReportArtifact(app.db, request.params.id);
    if (!row) return reply.code(404).send({ error: "report not found" });
    return reply.code(200).send(row);
  });

  app.get<{ Querystring: { type?: string; scopeId?: string; limit?: number; offset?: number } }>(
    "/v1/reports",
    { schema: { querystring: listReportsQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      if (!userId) return reply.code(200).send([]);
      const rows = await listReportArtifacts(app.db, userId, {
        reportType: request.query.type,
        scopeId: request.query.scopeId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return reply.code(200).send(rows);
    },
  );
}
