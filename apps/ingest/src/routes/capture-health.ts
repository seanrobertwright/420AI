import type { FastifyInstance } from "fastify";
import type { CaptureHealthSnapshot } from "@420ai/shared";
import { CAPTURE_HEALTH_VERSION, deriveCaptureHealth, deriveMachineStatus } from "@420ai/shared";
import {
  declaredConnectorHealth,
  machineStatuses,
  observedConnectorAggregates,
  withOrg,
} from "@420ai/db";
import { authorized, resolvePrincipal } from "../auth.js";

/**
 * GET /v1/capture-health (M16 16.3) — the capture health scorecard (research plan §7 P0.1).
 *
 * A SEPARATE ENDPOINT rather than an extension of the monitor snapshot (D-16.3-5). `buildSnapshot`
 * already performs eight reads plus a reconcile WRITE per tick and the SSE stream runs it every 3 s,
 * whereas capture health changes at HEARTBEAT cadence (30 s) — folding it in would multiply the cost
 * of the hottest query path in the product by a signal that cannot change that fast.
 *
 * `principal.role`, NOT `SERVICE_ROLE`, AND THE NEIGHBOURING FILE DOES THE OPPOSITE ON PURPOSE.
 * `routes/monitor.ts` uses `SERVICE_ROLE` because its GET performs a write (the evaluate-on-read
 * alert reconcile), which is the ORG's bookkeeping rather than the caller's mutation — under
 * `principal.role` the 0016 restrictive INSERT policy 500s it for every viewer. This route writes
 * NOTHING, so the honest answer to the 15.4 "whose action is this?" test is: the caller's. It runs
 * as them.
 *
 * `viewer` is the gate and it is the FLOOR — there is no rung below it, so this is "any member of
 * the org may see whether their own capture is working", which is the least surprising reading of a
 * health panel.
 */
export default async function captureHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/capture-health", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // THE ROUTE OWNS THE CLOCK. `@420ai/shared` never reads it, so every judgement below is
    // deterministic and unit-tested without a database.
    const now = new Date();
    const nowMs = now.getTime();

    const snapshot = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
      // SEQUENTIAL, not `Promise.all`: `tx` is ONE connection and node-postgres queues concurrent
      // queries on it (the 15.3 note at repositories/monitor.ts).
      const machines = await machineStatuses(tx, principal.orgId);
      const declared = await declaredConnectorHealth(tx, principal.orgId);
      const observed = await observedConnectorAggregates(tx, principal.orgId);
      return deriveCaptureHealth(
        {
          machines: machines.map((m) => ({
            id: m.id,
            name: m.name,
            status: deriveMachineStatus(m, nowMs),
          })),
          declared,
          observed,
        },
        nowMs,
      );
    });

    return reply.code(200).send({
      captureHealthVersion: CAPTURE_HEALTH_VERSION,
      generatedAt: now.toISOString(),
      rows: snapshot,
    } satisfies CaptureHealthSnapshot);
  });
}
