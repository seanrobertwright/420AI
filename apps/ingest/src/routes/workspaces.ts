import type { FastifyInstance } from "fastify";
import type { DiscoverRequest, DiscoverResponse } from "@420ai/shared";
import { repoNameFromRemote, basenameFromRoot } from "@420ai/shared";
import {
  getMachineUserId,
  findUserIdByEmail,
  upsertWorkspace,
  addWorkspaceKey,
  remapWorkspace,
  listWorkspaces,
  findOrCreateProjectByRemote,
  createProject,
  getProjectName,
} from "@420ai/db";
import {
  discoverBodySchema,
  patchWorkspaceBodySchema,
} from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

const DEFAULT_EMAIL = "seanrobertwright@gmail.com";

interface PatchWorkspaceBody {
  projectId: string;
}

/**
 * Workspace discovery + admin remap (PRD §19 steps 7–8).
 *
 * - POST /v1/workspaces/discover is MACHINE-authed (like /v1/ingest): the
 *   collector reports the roots where AI work happened; the server upserts each
 *   workspace, auto-creates one project per workspace (unifying by git remote),
 *   and records the connector's `project_key` alias. Idempotent.
 * - GET /v1/workspaces and PATCH /v1/workspaces/:id are ADMIN-gated (the editable
 *   mapping, D4).
 */
export default async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DiscoverRequest }>(
    "/v1/workspaces/discover",
    { preHandler: app.authenticate, schema: { body: discoverBodySchema } },
    async (request, reply) => {
      const userId = await getMachineUserId(app.db, request.machineId);
      if (!userId) {
        return reply.code(401).send({ error: "machine has no owning user" });
      }

      const result = await app.db.transaction(async (tx) => {
        let workspacesUpserted = 0;
        let projectsCreated = 0;
        const mappings: DiscoverResponse["mappings"] = [];

        for (const w of request.body.workspaces) {
          const ws = await upsertWorkspace(tx, {
            userId,
            machineId: request.machineId,
            rootPath: w.rootPath,
            gitRemote: w.gitRemote,
            gitBranch: w.gitBranch,
          });
          workspacesUpserted += 1;

          // Auto-map a project only when the workspace is not yet mapped — so a
          // user's earlier remap survives re-discovery (D4).
          let projectId = ws.projectId;
          let projectName: string;
          if (!projectId) {
            if (w.gitRemote) {
              projectName = repoNameFromRemote(w.gitRemote);
              const proj = await findOrCreateProjectByRemote(
                tx,
                userId,
                w.gitRemote,
                projectName,
              );
              projectId = proj.id;
              if (proj.created) projectsCreated += 1;
            } else {
              projectName = basenameFromRoot(w.rootPath);
              const proj = await createProject(tx, userId, projectName);
              projectId = proj.id;
              projectsCreated += 1;
            }
            await remapWorkspace(tx, userId, ws.id, projectId);
          } else {
            projectName = (await getProjectName(tx, projectId)) ?? "";
          }

          await addWorkspaceKey(tx, {
            userId,
            workspaceId: ws.id,
            sourceConnector: w.sourceConnector,
            projectKey: w.projectKey,
          });

          mappings.push({
            projectKey: w.projectKey,
            workspaceId: ws.id,
            projectId,
            projectName,
          });
        }

        return { workspacesUpserted, projectsCreated, mappings } satisfies DiscoverResponse;
      });

      return reply.code(200).send(result);
    },
  );

  app.get("/v1/workspaces", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
    if (!userId) return reply.code(200).send({ workspaces: [] });
    const workspaces = await listWorkspaces(app.db, userId);
    return reply.code(200).send({ workspaces });
  });

  app.patch<{ Params: { id: string }; Body: PatchWorkspaceBody }>(
    "/v1/workspaces/:id",
    { schema: { body: patchWorkspaceBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const { id } = request.params;
      const { projectId } = request.body;
      if (!isUuid(id)) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      if (!isUuid(projectId)) {
        return reply.code(400).send({ error: "projectId must be a valid id" });
      }
      // Verify the target project exists, so an unknown id is a clean 404
      // rather than a foreign-key 500.
      if (!(await getProjectName(app.db, projectId))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
      if (!userId) return reply.code(404).send({ error: "workspace not found" });
      const row = await remapWorkspace(app.db, userId, id, projectId);
      if (!row) return reply.code(404).send({ error: "workspace not found" });
      return reply.code(200).send({ id: row.id, projectId: row.projectId });
    },
  );
}
