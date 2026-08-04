import type { FastifyInstance } from "fastify";
import type { HeartbeatRequest, HeartbeatResponse } from "@420ai/shared";
import { SERVICE_ROLE } from "@420ai/shared";
import { recordHeartbeat, getMachineOrgId, replaceMachineConnectors, withOrg } from "@420ai/db";
import { heartbeatBodySchema } from "../schemas.js";

/**
 * POST /v1/heartbeat (M9, PRD §20) — machine-authed collector liveness ping.
 * ADDITIVE to the M2 ingest contract: a sibling of POST /v1/ingest, not a change
 * to it (D1). The `app.authenticate` preHandler resolves the bearer token to a
 * machineId AND touches `lastSeenAt` (plugins/auth.ts) — so we do NOT re-auth; the
 * handler only writes the dedicated heartbeat columns (backlog + version + the
 * purpose-built `lastHeartbeatAt`). A malformed body is a schema 400 before here.
 */
export default async function heartbeatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: HeartbeatRequest }>(
    "/v1/heartbeat",
    { preHandler: app.authenticate, schema: { body: heartbeatBodySchema } },
    async (request, reply) => {
      // M15 15.3: machine-authed — resolve the org from `machines` (bootstrap-permissive, so
      // this read runs with no context yet) before opening the RLS-scoped transaction.
      const orgId = await getMachineOrgId(app.db, request.machineId);
      if (!orgId) {
        return reply.code(401).send({ error: "machine has no organization" });
      }
      const reports = request.body.connectors;
      await withOrg(app.db, orgId, SERVICE_ROLE, async (tx) => {
        await recordHeartbeat(tx, request.machineId, {
          queuePending: request.body.queuePending,
          queueInflight: request.body.queueInflight,
          collectorVersion: request.body.collectorVersion,
          consecutiveSyncFailures: request.body.consecutiveSyncFailures,
        });
        // M16 16.3 — the DECLARED half of capture health, persisted in the SAME transaction on
        // purpose: a heartbeat that records liveness but loses the inventory is a split state the
        // scorecard would then misreport as an honest zero.
        //
        // `undefined` vs `[]` IS LOAD-BEARING (D-16.3-2). `undefined` means a pre-16.3 collector
        // that does not report at all, and its existing rows must be left alone; `[]` means a
        // collector that reports zero connectors, and prunes. Collapsing them would let a collector
        // downgrade silently wipe the inventory.
        //
        // SERVICE_ROLE is correct and unchanged: this is a machine-authed write with no membership
        // role, exactly like `recordHeartbeat`. It also satisfies the 0016 restrictive INSERT
        // policy (`<> 'viewer'`).
        if (reports !== undefined) {
          await replaceMachineConnectors(tx, orgId, request.machineId, reports, new Date());
        }
      });
      return reply.code(200).send({ ok: true } satisfies HeartbeatResponse);
    },
  );
}
