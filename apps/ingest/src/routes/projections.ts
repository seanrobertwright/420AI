import type { FastifyInstance } from "fastify";
import {
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionProjections,
  sessionDetail,
  connectorHealth,
  projectGitMetadata,
  findUserIdByEmail,
} from "@420ai/db";
import { usageOverTimeQuerySchema } from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

/**
 * M6 deterministic-projection read endpoints (PRD §16.1, D6). All admin-gated
 * (mirrors routes/projects.ts) — these are dashboard/reporting reads, not the
 * machine-authed write path. Project routes guard `:id` with `isUuid` → 404;
 * `:sessionId` is a connector TEXT id (not a uuid) so it is ungated — an unknown
 * id returns a zeroed projection (200), not 404. Read-only: bad input is a guard
 * 401/404/400, never a new typed error.
 */
export default async function projectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/v1/projects/:id/sessions", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply.code(200).send(await sessionProjections(app.db, request.params.id));
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/usage", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply.code(200).send(await usageTotals(app.db, request.params.id));
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/usage/by-model", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply.code(200).send(await usageByModel(app.db, request.params.id));
  });

  app.get<{ Params: { id: string }; Querystring: { bucket?: "day" | "week" } }>(
    "/v1/projects/:id/usage/over-time",
    { schema: { querystring: usageOverTimeQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const bucket = request.query.bucket ?? "day";
      return reply.code(200).send(await usageOverTime(app.db, request.params.id, bucket));
    },
  );

  app.get<{ Params: { id: string } }>("/v1/projects/:id/git", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply.code(200).send(await projectGitMetadata(app.db, request.params.id));
  });

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    // sessionId is a connector text id (NOT a uuid) — unknown → zeroed projection.
    return reply.code(200).send(await sessionDetail(app.db, request.params.sessionId));
  });

  app.get("/v1/connectors/health", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = await findUserIdByEmail(app.db, app.adminEmail);
    if (!userId) return reply.code(200).send([]);
    return reply.code(200).send(await connectorHealth(app.db, userId));
  });
}
