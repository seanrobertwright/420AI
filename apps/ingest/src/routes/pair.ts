import type { FastifyInstance } from "fastify";
import type { PairRequest, PairResponse } from "@420ai/shared";
import { createMachine, issueIngestToken, redeemPairingCode, PairingError } from "@420ai/db";
import { pairBodySchema } from "../schemas.js";

/**
 * POST /v1/pair — the code IS the credential (no bearer). Atomically redeems the
 * code, registers the machine, and issues a revocable ingest token (PRD §19).
 */
export default async function pairRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PairRequest }>(
    "/v1/pair",
    { schema: { body: pairBodySchema } },
    async (request, reply) => {
      const { code, machine } = request.body;
      try {
        const result = await app.db.transaction(async (tx) => {
          // M15 15.1: the machine's org comes from the redeemed CODE, never from the
          // request body — a paired machine lands in the issuing user's tenant.
          const { userId, orgId } = await redeemPairingCode(tx, code);
          const { id: machineId } = await createMachine(tx, {
            orgId,
            userId,
            name: machine.name,
            os: machine.os,
            hostname: machine.hostname,
          });
          const { token } = await issueIngestToken(tx, machineId);
          return { token, machineId } satisfies PairResponse;
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof PairingError) {
          return reply.code(410).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
