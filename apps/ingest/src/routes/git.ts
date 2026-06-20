import type { FastifyInstance } from "fastify";
import type { GitCaptureRequest } from "@420ai/shared";
import {
  getMachineUserId,
  findUserIdByEmail,
  getProjectName,
  resolveWorkspaceId,
  recordGitCommits,
  gitCommitsByProject,
  gitCommitDetail,
  computeSessionGitSuggestions,
  addManualLink,
  setLinkStatus,
  listProjectLinks,
  projectSessionIds,
} from "@420ai/db";
import {
  gitCaptureBodySchema,
  suggestGitBodySchema,
  manualLinkBodySchema,
  patchGitLinkBodySchema,
} from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

/**
 * M10 Git Outcomes + Attribution (PRD §11.3, §11.4). Mirrors the workspaces.ts
 * machine+admin split:
 *  - POST /v1/git is MACHINE-authed (like /v1/ingest): the collector reports
 *    captured commits; the server records them idempotently (SHA dedup, D3).
 *  - The GET reads + suggest/link/patch writes are ADMIN-gated, with the
 *    existence-check → 404 guard so an unknown id is never an FK/cast 500
 *    (CLAUDE.md M6–M9 gotcha). A suggestion ALWAYS carries a confidence + status.
 */
export default async function gitRoutes(app: FastifyInstance): Promise<void> {
  // Machine-authed git capture. Idempotent: re-POSTing the same commits inserts 0.
  app.post<{ Body: GitCaptureRequest }>(
    "/v1/git",
    { preHandler: app.authenticate, schema: { body: gitCaptureBodySchema } },
    async (request, reply) => {
      const userId = await getMachineUserId(app.db, request.machineId);
      if (!userId) {
        return reply.code(401).send({ error: "machine has no owning user" });
      }
      const result = await recordGitCommits(app.db, request.machineId, request.body);
      return reply.code(200).send(result);
    },
  );

  // Admin: commits attributed to a project (via the D5 repo-root join). Plaintext only.
  app.get<{ Params: { id: string } }>("/v1/projects/:id/git/commits", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply.code(200).send(await gitCommitsByProject(app.db, request.params.id));
  });

  // Admin: persisted session→commit links for a project.
  app.get<{ Params: { id: string } }>("/v1/projects/:id/git/links", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const userId = await findUserIdByEmail(app.db, app.adminEmail);
    if (!userId) return reply.code(200).send([]);
    return reply.code(200).send(await listProjectLinks(app.db, userId, request.params.id));
  });

  // Admin: run the §11.4 heuristic for the project's sessions (or one via {sessionId}).
  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>(
    "/v1/projects/:id/git/suggest",
    { schema: { body: suggestGitBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const { id } = request.params;
      if (!isUuid(id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Existence-check the project so an unknown (well-formed) id is a 404, not a 500.
      if (!(await getProjectName(app.db, id))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      if (!userId) return reply.code(200).send([]);
      const scoped = request.body?.sessionId;
      const sessionIds = scoped ? [scoped] : await projectSessionIds(app.db, id);
      const links = [];
      for (const sessionId of sessionIds) {
        links.push(...(await computeSessionGitSuggestions(app.db, userId, sessionId)));
      }
      return reply.code(200).send(links);
    },
  );

  // Admin: manually link a session to a commit (by SHA). Existence-check commit → 404, not FK-500.
  app.post<{ Params: { sessionId: string }; Body: { commitSha: string } }>(
    "/v1/sessions/:sessionId/git-links",
    { schema: { body: manualLinkBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      if (!userId) return reply.code(404).send({ error: "commit not found" });
      const detail = await gitCommitDetail(app.db, userId, request.body.commitSha);
      if (!detail) return reply.code(404).send({ error: "commit not found" });
      const resolved = await resolveWorkspaceId(app.db, userId, detail.commit.repoRootPath);
      const projectId = resolved?.projectId ?? null;
      await addManualLink(app.db, userId, request.params.sessionId, detail.id, projectId);
      return reply.code(200).send({
        sessionId: request.params.sessionId,
        commitSha: detail.commit.commitSha,
        projectId,
        confidence: "manual",
        status: "confirmed",
      });
    },
  );

  // Admin: confirm/reject a link (the human decision the suggest path then preserves).
  app.patch<{ Params: { id: string }; Body: { status: "confirmed" | "rejected" } }>(
    "/v1/git-links/:id",
    { schema: { body: patchGitLinkBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "link not found" });
      }
      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      if (!userId) return reply.code(404).send({ error: "link not found" });
      const link = await setLinkStatus(app.db, userId, request.params.id, request.body.status);
      if (!link) return reply.code(404).send({ error: "link not found" });
      return reply.code(200).send(link);
    },
  );
}
