import type { FastifyInstance } from "fastify";
import {
  deriveMachineStatus,
  deriveAlerts,
  deriveBacklogTrendAlerts,
  deriveCatalogAlerts,
  deriveAuthFailureAlerts,
  deriveArchiveUnreachableAlerts,
  sortAlerts,
  isBacklogHigh,
  BACKLOG_TREND_WINDOW_MS,
  AUTH_FAILURE_ALERT,
  MONITOR_VERSION,
  emptyMonitorSnapshot,
  type LiveMonitorSnapshot,
} from "@420ai/shared";
import {
  machineStatuses,
  activeSessions,
  connectorHealth,
  recentBacklogSamples,
  reconcileAlertFirings,
  deliverPendingFirings,
  countPendingCatalogs,
  countRecentAuthFailures,
  findUserIdByEmail,
  type DbClient,
} from "@420ai/db";
import { adminAuthorized } from "../auth.js";

/**
 * The "active now" window: a session whose last event is within this lookback is
 * shown as active. M9 stores only the LATEST heartbeat sample, so this is current
 * recency — NOT a rate-of-change ("backlog growing" / trend is M10, D4).
 */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Compose the LiveMonitorSnapshot from the clock-free projections. The ONLY wall-clock
 * read is `now`, passed in by the route (D6 — route owns the clock, like routes/reports.ts
 * owns `generatedAt`). `deriveMachineStatus`/`isBacklogHigh` are applied per machine here.
 *
 * M10 3c (D1): this is now also a WRITER. After deriving the alerts (the frozen
 * `deriveAlerts` plus the sibling `deriveBacklogTrendAlerts` over the recent heartbeat
 * samples, merged + re-sorted by `sortAlerts`), it reconciles them against the persisted
 * open firings (evaluate-on-read — no background dispatcher) and attaches `alertFirings`.
 */
async function buildSnapshot(db: DbClient, userId: string, now: Date): Promise<LiveMonitorSnapshot> {
  const nowMs = now.getTime();
  const sinceIso = new Date(nowMs - ACTIVE_WINDOW_MS).toISOString();
  const trendSince = new Date(nowMs - BACKLOG_TREND_WINDOW_MS);
  const [machines, connectors, sessions, samplesByMachine, pendingCatalogs, authFailureCount] =
    await Promise.all([
      machineStatuses(db, userId),
      connectorHealth(db, userId),
      activeSessions(db, userId, sinceIso),
      recentBacklogSamples(db, userId, trendSince),
      countPendingCatalogs(db),
      countRecentAuthFailures(db, new Date(nowMs - AUTH_FAILURE_ALERT.windowMs)),
    ]);
  // Assemble the derived-state snapshot first, then fold in alerts — deriveAlerts reads the
  // already-derived machine status/backlogHigh + connector rows (no clock, no re-derivation, D3).
  const machineRows = machines.map((m) => ({
    ...m,
    status: deriveMachineStatus(m, nowMs),
    backlogHigh: isBacklogHigh(m.queuePending),
  }));
  const built: LiveMonitorSnapshot = {
    monitorVersion: MONITOR_VERSION,
    generatedAt: now.toISOString(),
    machines: machineRows,
    connectors,
    activeSessions: sessions,
    alerts: [],
    alertFirings: [],
  };
  // Frozen deriveAlerts (D2) + the sibling backlog-growing + the §20 catalog-approval
  // derivatives, merged + re-sorted. The catalog alert is GLOBAL (no machine/connector).
  const alerts = sortAlerts([
    ...deriveAlerts(built),
    ...deriveBacklogTrendAlerts(machineRows, samplesByMachine),
    ...deriveCatalogAlerts(pendingCatalogs),
    ...deriveArchiveUnreachableAlerts(machineRows),
    ...deriveAuthFailureAlerts(authFailureCount),
  ]);
  // The new WRITE (D1): reconcile firing state against the derived alerts (route owns `now`).
  const alertFirings = await reconcileAlertFirings(db, userId, alerts, now);
  return { ...built, alerts, alertFirings };
}

/**
 * M12 12.6 alert delivery — push any newly-opened firing to the injected deliverer, AFTER the
 * snapshot has reconciled firing state. Kept as a route-boundary helper (NOT folded into the
 * load-bearing `buildSnapshot(db,userId,now)`) so the delivery I/O is explicitly best-effort:
 * a webhook problem NEVER 500s GET /v1/monitor or breaks the SSE stream. Early-returns (no
 * query) when no deliverer is wired. Uses the SAME `now` the snapshot reconciled with.
 */
async function deliverFirings(app: FastifyInstance, userId: string, now: Date): Promise<void> {
  try {
    await deliverPendingFirings(app.db, userId, app.alertDeliverer, now, (e) => app.log.error(e));
  } catch (e) {
    app.log.error(e);
  }
}

/**
 * M9 Live Monitor read API (PRD §8.4). Admin-gated (mirrors routes/projections.ts) —
 * dashboard reads, served via the server-side proxy that holds the admin token (D8).
 *
 * GET /v1/monitor          — one composed snapshot (route owns the clock).
 * GET /v1/monitor/stream   — SSE: a fresh snapshot every `monitorStreamIntervalMs`.
 *
 * D7: the SSE route runs ALL guards (auth + user resolution + the 200 head) BEFORE
 * `reply.hijack()`, because hijack removes the response from Fastify's lifecycle and the
 * global setErrorHandler no longer applies. After hijack, each snapshot build is wrapped
 * in try/catch and a failure is emitted as an SSE `event: error` frame (the connection
 * survives and recovers on the next tick). The interval is ALWAYS cleared on disconnect.
 */
export default async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/monitor", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = await findUserIdByEmail(app.db, app.adminEmail);
    const now = new Date();
    if (!userId) return reply.code(200).send(emptyMonitorSnapshot(now.toISOString()));
    const snap = await buildSnapshot(app.db, userId, now);
    await deliverFirings(app, userId, now); // best-effort; never throws
    return reply.code(200).send(snap);
  });

  app.get("/v1/monitor/stream", async (request, reply) => {
    // --- ALL guards BEFORE hijack (D7) ---
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = await findUserIdByEmail(app.db, app.adminEmail);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.hijack(); // take over the socket; the error handler no longer applies past here

    // Register the disconnect handler BEFORE the first (awaited) snapshot build: if the
    // client drops during that DB query, the socket's "close" fires before any later
    // listener would exist — attaching it here (and guarding `push` on `closed`) ensures
    // the interval is always cleared and we never write to a dead socket (no leak).
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
      if (timer) clearInterval(timer);
    });

    const push = async (): Promise<void> => {
      if (closed) return;
      try {
        const now = new Date();
        const snap = userId
          ? await buildSnapshot(app.db, userId, now)
          : emptyMonitorSnapshot(now.toISOString());
        // Deliver newly-opened firings before writing the frame (best-effort; guarded on
        // still-connected so a deliver query never runs against a dropped client).
        if (userId && !closed) await deliverFirings(app, userId, now);
        if (!closed) reply.raw.write(`data: ${JSON.stringify(snap)}\n\n`);
      } catch (err) {
        // The error handler is bypassed post-hijack — emit + keep the stream alive.
        if (!closed) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "snapshot failed" })}\n\n`);
        }
        request.log.error(err);
      }
    };

    await push(); // initial snapshot immediately on connect
    // LOAD-BEARING: only arm the interval if the client is still connected.
    if (!closed) timer = setInterval(() => void push(), app.monitorStreamIntervalMs);
  });
}
