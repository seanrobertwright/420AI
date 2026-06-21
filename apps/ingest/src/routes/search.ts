import type { FastifyInstance } from "fastify";
import { searchDocuments, rebuildSearchIndex } from "@420ai/db";
import type { SearchEntityType } from "@420ai/shared";
import { searchQuerySchema } from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

/**
 * M12 §21 admin search endpoints. Both admin-gated (mirrors routes/projections.ts:
 * inline `adminAuthorized`→401, `isUuid`→404). Hits come from the REDACTED
 * `search_documents` projection — never the encrypted originals (PRD §18.1).
 *
 *   - GET  /v1/search          — ranked, redacted hits (querystring-validated `q`).
 *   - POST /v1/search/reindex  — full delete-then-rebuild of the index (manual-first).
 *
 * `reindex` decrypts session content to redact-then-store it, so the server needs
 * `ARCHIVE_ENCRYPTION_KEY` (the same env every decrypt path requires). The empty/
 * over-long `q` case is rejected by `searchQuerySchema` (400) before the handler.
 */
export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q: string; type?: SearchEntityType; projectId?: string; limit?: number };
  }>("/v1/search", { schema: { querystring: searchQuerySchema } }, async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const { q, type, projectId, limit } = request.query;
    // A project filter must be a well-formed uuid (else a PG uuid-cast 500) →
    // unknown/malformed id is 404, preserving the repo-wide invariant.
    if (projectId !== undefined && !isUuid(projectId)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return reply
      .code(200)
      .send(await searchDocuments(app.db, { q, type, projectId: projectId ?? null, limit }));
  });

  app.post("/v1/search/reindex", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    return reply.code(200).send(await rebuildSearchIndex(app.db));
  });
}
