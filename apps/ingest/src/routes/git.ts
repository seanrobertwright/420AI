import type { FastifyInstance } from "fastify";
import type { GitCaptureRequest } from "@420ai/shared";
import { SERVICE_ROLE } from "@420ai/shared";
import {
  withOrg,
  getMachineOrgId,
  getMachineUserId,
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
import { resolvePrincipal, isUuid, authorized } from "../auth.js";

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
      // M15 15.3: machine-authed — resolve the org from `machines` (bootstrap-permissive)
      // before the RLS-scoped transaction; `recordGitCommits` nests its own as a savepoint.
      const orgId = await getMachineOrgId(app.db, request.machineId);
      if (!orgId) {
        return reply.code(401).send({ error: "machine has no organization" });
      }
      const result = await withOrg(app.db, orgId, SERVICE_ROLE, (tx) =>
        recordGitCommits(tx, request.machineId, request.body),
      );
      return reply.code(200).send(result);
    },
  );

  // Admin: commits attributed to a project (via the D5 repo-root join). Plaintext only.
  app.get<{ Params: { id: string } }>("/v1/projects/:id/git/commits", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const commits = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      gitCommitsByProject(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(commits);
  });

  // Admin: persisted session→commit links for a project.
  app.get<{ Params: { id: string } }>("/v1/projects/:id/git/links", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const userId = principal.userId;
    const links = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      listProjectLinks(tx, principal.orgId, userId, request.params.id),
    );
    return reply.code(200).send(links);
  });

  // Admin: run the §11.4 heuristic for the project's sessions (or one via {sessionId}).
  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>(
    "/v1/projects/:id/git/suggest",
    { schema: { body: suggestGitBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const { id } = request.params;
      if (!isUuid(id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Existence-check the project so an unknown (well-formed) id is a 404, not a 500.
      const exists = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        getProjectName(tx, principal.orgId, id),
      );
      if (!exists) {
        return reply.code(404).send({ error: "project not found" });
      }
      const userId = principal.userId;
      const scoped = request.body?.sessionId;
      // One transaction for the whole suggest pass: the session list and every per-session
      // heuristic read/write share it, so a mid-loop failure rolls the batch back rather than
      // leaving half the sessions with suggestions and half without.
      const links = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        const sessionIds = scoped ? [scoped] : await projectSessionIds(tx, principal.orgId, id);
        const acc = [];
        for (const sessionId of sessionIds) {
          acc.push(...(await computeSessionGitSuggestions(tx, principal.orgId, userId, sessionId)));
        }
        return acc;
      });
      return reply.code(200).send(links);
    },
  );

  // Admin: manually link a session to a commit (by SHA). Existence-check commit → 404, not FK-500.
  app.post<{ Params: { sessionId: string }; Body: { commitSha: string } }>(
    "/v1/sessions/:sessionId/git-links",
    { schema: { body: manualLinkBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const userId = principal.userId;
      const detail = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        gitCommitDetail(tx, principal.orgId, userId, request.body.commitSha),
      );
      if (!detail) return reply.code(404).send({ error: "commit not found" });
      const projectId = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        const resolved = await resolveWorkspaceId(
          tx,
          principal.orgId,
          userId,
          detail.commit.repoRootPath,
        );
        const pid = resolved?.projectId ?? null;
        await addManualLink(tx, principal.orgId, userId, request.params.sessionId, detail.id, pid);
        return pid;
      });
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
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "link not found" });
      }
      const userId = principal.userId;
      const link = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        setLinkStatus(tx, principal.orgId, userId, request.params.id, request.body.status),
      );
      if (!link) return reply.code(404).send({ error: "link not found" });
      return reply.code(200).send(link);
    },
  );
}
