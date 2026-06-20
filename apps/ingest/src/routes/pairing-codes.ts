import type { FastifyInstance } from "fastify";
import { createPairingCode, users } from "@420ai/db";
import { pairingCodeBodySchema } from "../schemas.js";
import { adminAuthorized } from "../auth.js";

interface PairingCodeBody {
  email?: string;
  userId?: string;
}

/**
 * POST /v1/pairing-codes — admin-gated issuance of a short-lived pairing code.
 * Temporary M2 affordance; the dashboard issues codes in a later milestone (§19).
 */
export default async function pairingCodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PairingCodeBody }>(
    "/v1/pairing-codes",
    { schema: { body: pairingCodeBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }

      let userId = request.body.userId;
      if (!userId) {
        const email = request.body.email ?? app.adminEmail;
        // M2 single-user: upsert a user by email.
        const [user] = await app.db
          .insert(users)
          .values({ email })
          .onConflictDoUpdate({ target: users.email, set: { email } })
          .returning({ id: users.id });
        userId = user!.id;
      }

      const { code, expiresAt } = await createPairingCode(app.db, userId);
      return reply.code(200).send({ code, expiresAt: expiresAt.toISOString() });
    },
  );
}
