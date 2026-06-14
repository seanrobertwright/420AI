import type { FastifyInstance } from "fastify";
import {
  ensureUserByEmail,
  getProjectName,
  sessionDetail,
  usageTotals,
} from "@420ai/db";
import {
  generateSessionInterpretation,
  generateProjectInterpretation,
} from "../analysis/generate-interpretation.js";
import {
  generateSessionInterpretationBodySchema,
  generateProjectInterpretationBodySchema,
} from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

const DEFAULT_EMAIL = "seanrobertwright@gmail.com";

interface GenerateSessionInterpretationBody {
  type?: "session.ai_interpretation";
}
interface GenerateProjectInterpretationBody {
  type?: "project.ai_interpretation";
}

/**
 * M8 AI interpretation generation endpoints (PRD §16.2). Admin-gated (mirrors
 * `routes/reports.ts`) — dashboard/reporting ops, not the machine-authed write path.
 * The route OWNS the clock (`generatedAt`) and the empty/existence guards; the
 * orchestrator stays a pure compose-and-store (Task 9 split). A thrown
 * `AnalysisProviderError` bubbles to `setErrorHandler` → 502/503 (D10) — do NOT
 * catch it into a 500.
 *
 * PRECEDENCE RULE (D8): M7's session autopsy returns a zeroed report for an
 * empty/unknown scope; M8 OVERRIDES that for interpretations — an empty scope → 404
 * and the provider is NOT called, because the provider call is a billable external
 * side effect and an empty bundle yields no useful analysis. Fetch/list reuse the M7
 * endpoints unchanged: GET /v1/reports/:id , GET /v1/reports?type=&scopeId=.
 */
export default async function interpretationRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { sessionId: string }; Body: GenerateSessionInterpretationBody }>(
    "/v1/sessions/:sessionId/interpretations",
    { schema: { body: generateSessionInterpretationBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      // sessionId is a connector text id (NOT a uuid) — ungated. Empty/unknown → 404
      // BEFORE the (billable) provider call (D8).
      const detail = await sessionDetail(app.db, request.params.sessionId);
      if (detail.eventCount === 0) {
        return reply.code(404).send({ error: "session not found or has no events" });
      }
      const userId = await ensureUserByEmail(app.db, DEFAULT_EMAIL);
      const generatedAt = new Date().toISOString();
      const row = await generateSessionInterpretation(
        app.db,
        app.analysisProvider,
        userId,
        request.params.sessionId,
        generatedAt,
        app.analysisMaxOutputTokens,
      );
      return reply.code(201).send(row);
    },
  );

  app.post<{ Params: { id: string }; Body: GenerateProjectInterpretationBody }>(
    "/v1/projects/:id/interpretations",
    { schema: { body: generateProjectInterpretationBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Existence guard (M7 FK lesson) — a well-formed-but-missing project must 404
      // BEFORE the insert (report_artifacts.project_id FKs to projects.id).
      if (!(await getProjectName(app.db, request.params.id))) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Empty project → 404 before the billable provider call (D8).
      const totals = await usageTotals(app.db, request.params.id);
      if (totals.eventCount === 0) {
        return reply.code(404).send({ error: "project has no events" });
      }
      const userId = await ensureUserByEmail(app.db, DEFAULT_EMAIL);
      const generatedAt = new Date().toISOString();
      const row = await generateProjectInterpretation(
        app.db,
        app.analysisProvider,
        userId,
        request.params.id,
        generatedAt,
        app.analysisMaxOutputTokens,
      );
      return reply.code(201).send(row);
    },
  );
}
