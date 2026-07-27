import type { FastifyInstance } from "fastify";
import {
  deriveMachineStatus,
  deriveAlerts,
  deriveBacklogTrendAlerts,
  deriveCatalogAlerts,
  deriveAuthFailureAlerts,
  deriveArchiveUnreachableAlerts,
  deriveConnectorFailureRateAlerts,
  sortAlerts,
  isBacklogHigh,
  BACKLOG_TREND_WINDOW_MS,
  AUTH_FAILURE_ALERT,
  CONNECTOR_RATE_ALERT,
  MONITOR_VERSION,
  type LiveMonitorSnapshot,
} from "@420ai/shared";
import {
  machineStatuses,
  activeSessions,
  connectorHealth,
  connectorHealthWindowed,
  recentBacklogSamples,
  reconcileAlertFirings,
  deliverPendingFirings,
  deliverResolvedFirings,
  countPendingCatalogs,
  countRecentAuthFailures,
  withOrg,
  type DbClient,
} from "@420ai/db";
import { resolvePrincipal } from "../auth.js";

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
async function buildSnapshot(
  db: DbClient,
  orgId: string,
  userId: string,
  now: Date,
): Promise<LiveMonitorSnapshot> {
  const nowMs = now.getTime();
  const sinceIso = new Date(nowMs - ACTIVE_WINDOW_MS).toISOString();
  const trendSince = new Date(nowMs - BACKLOG_TREND_WINDOW_MS);
  const connectorRateSinceIso = new Date(nowMs - CONNECTOR_RATE_ALERT.windowMs).toISOString();
  // M15 15.3: SEQUENTIAL, not `Promise.all`. `db` is now a transaction handle (the route wraps
  // this in `withOrg`), and a transaction is ONE connection — node-postgres queues concurrent
  // queries on it and emits `Calling client.query() when the client is already executing a query
  // is deprecated` (removed in pg@9). So the "parallel" version never actually overlapped; it
  // only bought a deprecation warning and a future breakage. Awaiting in order is what the
  // driver does anyway, stated honestly.
  const machines = await machineStatuses(db, userId);
  const connectors = await connectorHealth(db, userId);
  const windowedConnectors = await connectorHealthWindowed(db, userId, connectorRateSinceIso);
  const sessions = await activeSessions(db, userId, sinceIso);
  const samplesByMachine = await recentBacklogSamples(db, userId, trendSince);
  const pendingCatalogs = await countPendingCatalogs(db);
  const authFailureCount = await countRecentAuthFailures(
    db,
    new Date(nowMs - AUTH_FAILURE_ALERT.windowMs),
  );
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
    ...deriveConnectorFailureRateAlerts(windowedConnectors),
  ]);
  // The new WRITE (D1): reconcile firing state against the derived alerts (route owns `now`).
  const alertFirings = await reconcileAlertFirings(db, orgId, userId, alerts, now);
  return { ...built, alerts, alertFirings };
}

/**
 * M12 12.6 / M13 13.5 alert delivery — push any newly-opened firing AND any newly-resolved
 * firing to the injected deliverer, AFTER the snapshot has reconciled firing state. Kept as a
 * route-boundary helper (NOT folded into the load-bearing `buildSnapshot(db,orgId,userId,now)`) so the
 * delivery I/O is explicitly best-effort: a webhook/SMTP problem NEVER 500s GET /v1/monitor or
 * breaks the SSE stream. Both deliver calls early-return (no query) when no deliverer is wired.
 * Uses the SAME `now` the snapshot reconciled with.
 *
 * M15 15.3: takes `orgId` and passes the UNWRAPPED `app.db` on purpose. `alert_firings` carries a
 * strict policy, so these two MUST run with an org context — but the context belongs INSIDE them,
 * not around them: each opens short `withOrg` transactions around its statements and runs the
 * webhook/SMTP round-trip between them, with no connection pinned across the network hop. Wrapping
 * this call in `withOrg` instead would restore the leak this comment used to describe.
 */
async function deliverFirings(
  app: FastifyInstance,
  orgId: string,
  userId: string,
  now: Date,
): Promise<void> {
  try {
    await deliverPendingFirings(app.db, orgId, userId, app.alertDeliverer, now, (e) =>
      app.log.error(e),
    );
    await deliverResolvedFirings(app.db, orgId, userId, app.alertDeliverer, now, (e) =>
      app.log.error(e),
    );
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
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = principal.userId;
    const now = new Date();
    // M15 15.2: the "no such user → empty snapshot" branch is gone — a resolved
    // principal always has a user row, so it was dead code once the gate returned one.
    const snap = await withOrg(app.db, principal.orgId, (tx) =>
      buildSnapshot(tx, principal.orgId, userId, now),
    );
    await deliverFirings(app, principal.orgId, userId, now); // best-effort; never throws
    return reply.code(200).send(snap);
  });

  app.get("/v1/monitor/stream", async (request, reply) => {
    // --- ALL guards BEFORE hijack (D7) ---
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const userId = principal.userId;

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
    // M15 15.3: ticks must NOT overlap. Before this slice a tick was a handful of autocommit
    // statements, so an interval that fired faster than the snapshot took was merely wasteful —
    // each statement released its locks immediately. Now a tick is ONE transaction spanning
    // eight reads plus the `reconcileAlertFirings` write, so two overlapping ticks are two
    // concurrent transactions taking multi-table locks in whatever order the planner picks.
    // That is a DEADLOCK (measured: it aborted unrelated suites' `TRUNCATE`s with 40P01 once
    // the interval was shorter than the snapshot). Skipping a tick while one is in flight is
    // also the right semantic — an SSE consumer wants the LATEST snapshot, not a backlog.
    let inFlight = false;
    request.raw.on("close", () => {
      closed = true;
      if (timer) clearInterval(timer);
    });

    const push = async (): Promise<void> => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const now = new Date();
        // M15 15.2: `userId` comes from the principal resolved ONCE before the stream
        // started (never re-resolved per tick — that would be a DB round trip per SSE
        // frame), so the old `userId ? … : empty` fallback is dead. Teardown wiring
        // above is deliberately untouched.
        // M15 15.3: the RLS context wraps the SNAPSHOT BUILD ONLY — one short transaction per
        // tick. Deliberately NOT the stream, the writeHead, the hijack or the interval: an SSE
        // connection lives for minutes to hours, and a transaction spanning it would pin a
        // pooled connection per connected client for that whole time. The teardown wiring
        // above (close listener armed before the first `await push()`, the `closed` guard,
        // `clearInterval`) is untouched by design — CLAUDE.md's long-lived-resource rule, and
        // exactly the class /lril:code-review caught in M9. The `inFlight` guard above is the
        // NEW half of that rule this slice forced: making the tick transactional means two
        // ticks can now deadlock each other, so they must not overlap.
        const snap = await withOrg(app.db, principal.orgId, (tx) =>
          buildSnapshot(tx, principal.orgId, userId, now),
        );
        // Deliver newly-opened firings before writing the frame (best-effort; guarded on
        // still-connected so a deliver query never runs against a dropped client).
        // OUTSIDE this `withOrg` on purpose: it is best-effort webhook/SMTP I/O, and holding a
        // transaction open across a network round-trip to a third party is how connection
        // pools die. It is still org-SCOPED — it opens its own short transactions internally,
        // which it must, because `alert_firings` carries a strict policy.
        if (!closed) await deliverFirings(app, principal.orgId, userId, now);
        if (!closed) reply.raw.write(`data: ${JSON.stringify(snap)}\n\n`);
      } catch (err) {
        // The error handler is bypassed post-hijack — emit + keep the stream alive.
        if (!closed) {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ error: "snapshot failed" })}\n\n`,
          );
        }
        request.log.error(err);
      } finally {
        // In `finally`, so a thrown snapshot never wedges the stream on `inFlight = true`.
        inFlight = false;
      }
    };

    await push(); // initial snapshot immediately on connect
    // LOAD-BEARING: only arm the interval if the client is still connected.
    if (!closed) timer = setInterval(() => void push(), app.monitorStreamIntervalMs);
  });
}
