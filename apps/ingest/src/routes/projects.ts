import type { FastifyInstance } from "fastify";
import {
  withOrg,
  listProjects,
  createProject,
  renameProject,
  projectEventSummary,
  indexProjectDoc,
} from "@420ai/db";
import {
  createProjectBodySchema,
  patchProjectBodySchema,
  listProjectsQuerySchema,
} from "../schemas.js";
import { resolvePrincipal, isUuid, authorized } from "../auth.js";

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
 *
 * M15 15.3: every DB call runs inside `withOrg` (the RLS context). The best-effort
 * `indexProjectDoc` refresh gets its OWN short `withOrg` rather than joining the mutation's
 * transaction — keeping the swallow-on-failure semantics intact. If it shared the mutation's
 * transaction, a failed index write would abort the surrounding transaction (`current
 * transaction is aborted`) and the catch could no longer save the mutation it is meant to
 * protect: the swallow would become a lie.
 */
export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/v1/projects",
    { schema: { querystring: listProjectsQuerySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const projects = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        listProjects(tx, principal.orgId, {
          limit: request.query.limit,
          offset: request.query.offset,
        }),
      );
      return reply.code(200).send({ projects });
    },
  );

  app.post<{ Body: CreateProjectBody }>(
    "/v1/projects",
    { schema: { body: createProjectBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const userId = principal.userId;
      const { id } = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        createProject(tx, principal.orgId, userId, request.body.name, request.body.gitRemote),
      );
      try {
        await withOrg(app.db, principal.orgId, principal.role, (tx) => indexProjectDoc(tx, id));
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
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const row = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        renameProject(tx, principal.orgId, request.params.id, request.body.name),
      );
      if (!row) return reply.code(404).send({ error: "project not found" });
      try {
        await withOrg(app.db, principal.orgId, principal.role, (tx) => indexProjectDoc(tx, row.id));
      } catch (err) {
        request.log.warn({ err }, "project search indexing failed");
      }
      return reply.code(200).send({ id: row.id, name: row.name });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/projects/:id/summary", async (request, reply) => {
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
    const summary = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      projectEventSummary(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(summary);
  });
}
