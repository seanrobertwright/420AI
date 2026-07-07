import type { FastifyInstance } from "fastify";
import {
  listProjects,
  createProject,
  renameProject,
  projectEventSummary,
  findUserIdByEmail,
  ensureUserByEmail,
  indexProjectDoc,
} from "@420ai/db";
import {
  createProjectBodySchema,
  patchProjectBodySchema,
  listProjectsQuerySchema,
} from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

interface CreateProjectBody {
  name: string;
  gitRemote?: string;
}
interface PatchProjectBody {
  name: string;
}

/**
 * Admin-gated project CRUD + the per-project event summary (PRD §6/§19, D5).
 * Mirrors `routes/pairing-codes.ts` admin pattern. Single-user (M2): the owning
 * user is the default-email user resolved/created here.
 *
 * M13 13.4: the create/rename mutations refresh the project's search doc
 * best-effort — awaited-with-swallow (the deliverFirings pattern), so index
 * maintenance never fails the mutation response.
 */
export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/v1/projects",
    { schema: { querystring: listProjectsQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      if (!userId) return reply.code(200).send({ projects: [] });
      const projects = await listProjects(app.db, userId, {
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return reply.code(200).send({ projects });
    },
  );

  app.post<{ Body: CreateProjectBody }>(
    "/v1/projects",
    { schema: { body: createProjectBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const userId = await ensureUserByEmail(app.db, app.adminEmail);
      const { id } = await createProject(app.db, userId, request.body.name, request.body.gitRemote);
      try {
        await indexProjectDoc(app.db, id);
      } catch (err) {
        request.log.warn({ err }, "project search indexing failed");
      }
      return reply.code(200).send({ id });
    },
  );

  app.patch<{ Params: { id: string }; Body: PatchProjectBody }>(
    "/v1/projects/:id",
    { schema: { body: patchProjectBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const row = await renameProject(app.db, request.params.id, request.body.name);
      if (!row) return reply.code(404).send({ error: "project not found" });
      try {
        await indexProjectDoc(app.db, row.id);
      } catch (err) {
        request.log.warn({ err }, "project search indexing failed");
      }
      return reply.code(200).send({ id: row.id, name: row.name });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/projects/:id/summary", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const summary = await projectEventSummary(app.db, request.params.id);
    return reply.code(200).send(summary);
  });
}
