import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Db } from "@420ai/db";
import { PairingError } from "@420ai/db";
import authPlugin from "./plugins/auth.js";
import healthRoutes from "./routes/health.js";
import pairingCodeRoutes from "./routes/pairing-codes.js";
import pairRoutes from "./routes/pair.js";
import ingestRoutes from "./routes/ingest.js";

export interface BuildAppOptions {
  db: Db;
  adminToken: string;
  logger?: boolean;
}

/**
 * Build the ingest Fastify instance with its dependencies injected (so tests
 * pass a test-DB-backed Db). Does NOT call listen — callers use app.inject()
 * (tests) or app.listen() (server.ts / collector push integration test).
 *
 * The auth plugin is registered before routes so app.authenticate exists when
 * the ingest route wires it as a preHandler.
 */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true });

  app.decorate("db", opts.db);
  app.decorate("adminToken", opts.adminToken);

  app.register(authPlugin);
  app.register(healthRoutes);
  app.register(pairingCodeRoutes);
  app.register(pairRoutes);
  app.register(ingestRoutes);

  // Map known failures to clean status codes; never leak internals on a 500.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof PairingError) {
      return reply.code(410).send({ error: err.message });
    }
    if (err.validation) {
      return reply.code(400).send({ error: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(err);
      return reply.code(status).send({ error: "internal server error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  return app;
}
