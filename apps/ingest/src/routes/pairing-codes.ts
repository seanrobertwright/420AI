import type { FastifyInstance } from "fastify";
import { createPairingCode, ensurePersonalOrg, users } from "@420ai/db";
import { pairingCodeBodySchema } from "../schemas.js";
import { resolvePrincipal } from "../auth.js";

interface PairingCodeBody {
  email?: string;
  userId?: string;
}

/**
 * POST /v1/pairing-codes — admin-gated issuance of a short-lived pairing code.
 * Temporary M2 affordance; the dashboard issues codes in a later milestone (§19).
 *
 * M15 15.3 — DELIBERATELY NOT wrapped in `withOrg`, and NOT an oversight. This route writes a
 * row for a TARGET user who may not be the caller (`body.email` / `body.userId`, D-15.2-5), so
 * the new `pairing_codes` row carries the TARGET's org — which under `withOrg(principal.orgId)`
 * the policy's implicit WITH CHECK would correctly REJECT as a cross-tenant insert. The
 * bootstrap-permissive policy (D-15.3-3) is what lets this legitimate case through. The
 * remaining writes touch `users` / `organizations` / `memberships`, which carry no RLS at all
 * (D-15.3-4 — they are the identity tables org resolution itself reads).
 */
export default async function pairingCodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PairingCodeBody }>(
    "/v1/pairing-codes",
    { schema: { body: pairingCodeBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }

      let userId = request.body.userId;
      if (!userId) {
        // D-15.2-5: the `body.email` upsert STAYS — closing that account-pre-seeding
        // primitive is D-M15-8 / slice 15.5. Only the fallback changes: an omitted
        // email now means "pair to the CALLER", not "pair to the env admin".
        const email = request.body.email ?? principal.email;
        // M2 single-user: upsert a user by email. NOTE: this is a THIRD `users` insert
        // that bypasses `repositories/users.ts` entirely — D-M15-8 deletes this whole
        // primitive in 15.5, so it is left in place and merely taught about orgs here.
        const [user] = await app.db
          .insert(users)
          .values({ email })
          .onConflictDoUpdate({ target: users.email, set: { email } })
          .returning({ id: users.id });
        userId = user!.id;
        // M15 15.1: a user created by this path needs an org before createPairingCode
        // (which resolves the code's org from the user) can succeed. Idempotent.
        await ensurePersonalOrg(app.db, userId, email);
      }

      const { code, expiresAt } = await createPairingCode(app.db, userId);
      return reply.code(200).send({ code, expiresAt: expiresAt.toISOString() });
    },
  );
}
