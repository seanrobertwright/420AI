import type { FastifyInstance } from "fastify";
import {
  listProjects,
  createProject,
  renameProject,
  projectEventSummary,
  findUserIdByEmail,
  ensureUserByEmail,
} from "@420ai/db";
import { createProjectBodySchema, patchProjectBodySchema } from "../schemas.js";
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
 */
export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/projects", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = await findUserIdByEmail(app.db, app.adminEmail);
    if (!userId) return reply.code(200).send({ projects: [] });
    const projects = await listProjects(app.db, userId);
    return reply.code(200).send({ projects });
  });

  app.post<{ Body: CreateProjectBody }>(
    "/v1/projects",
    { schema: { body: createProjectBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const userId = await ensureUserByEmail(app.db, app.adminEmail);
      const { id } = await createProject(
        app.db,
        userId,
        request.body.name,
        request.body.gitRemote,
      );
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
      return reply.code(200).send({ id: row.id, name: row.name });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/projects/:id/summary",
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const summary = await projectEventSummary(app.db, request.params.id);
      return reply.code(200).send(summary);
    },
  );
}
