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
  SERVICE_ROLE,
  alertKey,
  type AlertFiring,
  type LiveMonitorSnapshot,
  type OperationalAlert,
} from "@420ai/shared";
import {
  machineStatuses,
  activeSessions,
  connectorHealth,
  connectorHealthWindowed,
  recentBacklogSamples,
  reconcileAlertFirings,
  listAlertFirings,
  deliverPendingFirings,
  deliverResolvedFirings,
  countPendingCatalogs,
  countRecentAuthFailures,
  findLiveSession,
  isApiKeyLive,
  withOrg,
  type DbClient,
} from "@420ai/db";
import { resolvePrincipal, authorized } from "../auth.js";

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
 *
 * M15 15.4 (audit B.4): `reconcile` decides whether this tick performs that WRITE or merely
 * READS the persisted firing list. The emitted frame is identical in SHAPE either way; the
 * route owns the decision (see the throttle note there). `false` is not a degraded snapshot —
 * it is the same firing rows, just not re-derived on this particular tick.
 *
 * M15 15.4 — BOTH routes wrap this in `withOrg(..., SERVICE_ROLE, ...)`, NOT `principal.role`,
 * and that is the same call the plan makes for `deliverFirings`. Evaluate-on-read means a GET
 * performs a WRITE: the reconcile upserts a firing per derived alert. That write is the ORG's
 * bookkeeping, triggered by whoever happened to open the monitor — it is not the caller's
 * mutation. Under `principal.role` the 0016 restrictive INSERT policy rejects it for a viewer
 * and `GET /v1/monitor` returns **500** to every read-only member of the org. (Measured, not
 * theorised: it is what `rbac.int.test.ts` did on its first run.) The monitor's own route gate
 * at `viewer` is what authorizes the READ; nothing here is a user-initiated write.
 */
async function buildSnapshot(
  db: DbClient,
  orgId: string,
  userId: string,
  now: Date,
  reconcile: boolean,
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
  // M15 15.4: `orgId` SECOND on every one of these (the 15.2 convention). Before this slice
  // they filtered on `userId` alone and leaned entirely on RLS for isolation — the inverse of
  // D-M15-3. With two users in one org that is also WRONG on the read side, not merely
  // unlayered: a member would not see a colleague's machines.
  const machines = await machineStatuses(db, orgId);
  const connectors = await connectorHealth(db, orgId);
  const windowedConnectors = await connectorHealthWindowed(db, orgId, connectorRateSinceIso);
  const sessions = await activeSessions(db, orgId, sinceIso);
  const samplesByMachine = await recentBacklogSamples(db, orgId, trendSince);
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
  // The WRITE (D1): reconcile firing state against the derived alerts (route owns `now`).
  //
  // M15 15.4 (audit B.4) — the throttle suppresses the STEADY-STATE write, not a state CHANGE.
  // A blanket "skip the reconcile for 30 s" would have been wrong in a way that is easy to miss:
  // `alerts` is re-derived every tick, but `alertFirings` comes from persisted rows, and
  // `deliverPendingFirings` reads those ROWS. So a newly-derived alert would sit in `alerts` with
  // no firing row — un-ackable, and its webhook/email delayed from ~3 s to up to 30 s — on the
  // one path whose entire job is to tell someone that something broke. The frame would also be
  // internally inconsistent: an alert present in `alerts` and absent from `alertFirings`.
  //
  // So a throttled tick READS first (a SELECT it was going to do anyway) and reconciles anyway
  // when the derived set disagrees with what is persisted. The write is skipped only when there
  // is genuinely nothing to write, which is the actual goal — and the common case by far.
  let alertFirings = reconcile ? null : await listAlertFirings(db, orgId, userId, now);
  if (alertFirings === null || openFiringsDiverge(alerts, alertFirings)) {
    alertFirings = await reconcileAlertFirings(db, orgId, userId, alerts, now);
  }
  return { ...built, alerts, alertFirings };
}

/**
 * True when the set of OPEN firing keys differs from the set of derived alert keys — i.e. an
 * alert has appeared or cleared since the last reconcile. Compared by `alertKey` (the same key
 * the partial unique index uses), so this asks exactly the question the reconcile would answer.
 * Recently-RESOLVED firings are ignored: they linger in the list as confirmation by design and
 * are not evidence of a change.
 */
function openFiringsDiverge(alerts: OperationalAlert[], firings: AlertFiring[]): boolean {
  const open = new Set(firings.filter((f) => f.status === "open").map((f) => f.alertKey));
  const derived = new Set(alerts.map(alertKey));
  if (open.size !== derived.size) return true;
  for (const key of derived) if (!open.has(key)) return true;
  return false;
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
 *
 * M15 15.4: passes `SERVICE_ROLE`, NOT `principal.role`, and that choice is load-bearing.
 * Delivery is TRIGGERED by whoever happens to have the monitor open, but the ACTION belongs to
 * the org. Under `principal.role` an org whose only active user is a viewer would have every
 * webhook and email silently stop — the 0016 restrictive UPDATE policy would reject the
 * `delivery_attempted_at` stamp inside a best-effort try/catch that is designed not to
 * complain. That is precisely the bug class the 15.3 code review caught here.
 */
async function deliverFirings(
  app: FastifyInstance,
  orgId: string,
  userId: string,
  now: Date,
): Promise<void> {
  try {
    await deliverPendingFirings(app.db, orgId, SERVICE_ROLE, userId, app.alertDeliverer, now, (e) =>
      app.log.error(e),
    );
    await deliverResolvedFirings(
      app.db,
      orgId,
      SERVICE_ROLE,
      userId,
      app.alertDeliverer,
      now,
      (e) => app.log.error(e),
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
  /**
   * M15 15.4 (audit B.4) — the reconcile is a WRITE (an upsert per derived alert plus a bulk
   * update). 15.3 made every SSE tick a transaction, so before this throttle a single connected
   * dashboard produced that write every 3 s, forever, per org. Alert state does not change
   * meaningfully at 3 s granularity, so we reconcile at most once per `reconcileThrottleMs` and
   * serve the persisted firing list in between — the frame the client receives is identical in
   * shape either way.
   *
   * The map is keyed on org+user (the same grain as the firing rows themselves) and lives on the
   * app, so it is per-process and resets on restart. That is fine: a missed throttle window costs
   * one extra reconcile, never a wrong result.
   *
   * The timestamp is stamped BEFORE the snapshot await, not after: two overlapping requests must
   * not both observe a stale `last`. (The SSE path's `inFlight` guard prevents that within one
   * stream, but two browser tabs are two streams.)
   */
  const shouldReconcile = (orgId: string, userId: string, now: Date): boolean => {
    const key = `${orgId}:${userId}`;
    const last = app.reconcileLastRunAt.get(key) ?? 0;
    const due = now.getTime() - last >= app.reconcileThrottleMs;
    if (due) app.reconcileLastRunAt.set(key, now.getTime());
    return due;
  };

  app.get("/v1/monitor", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const userId = principal.userId;
    const now = new Date();
    // M15 15.2: the "no such user → empty snapshot" branch is gone — a resolved
    // principal always has a user row, so it was dead code once the gate returned one.
    const reconcile = shouldReconcile(principal.orgId, userId, now);
    const snap = await withOrg(app.db, principal.orgId, SERVICE_ROLE, (tx) =>
      buildSnapshot(tx, principal.orgId, userId, now, reconcile),
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
    // M15 15.4: the role gate is a PRE-HIJACK guard (D7). After `reply.hijack()` the error
    // handler no longer applies and a 403 cannot be sent — so it belongs here, with the others.
    // It gates at `viewer`, i.e. any resolved principal: every org member may watch the monitor.
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const userId = principal.userId;
    // M15 15.6 — captured BEFORE the hijack, alongside the other pre-hijack guards. Null for an
    // API-KEY caller, which has no session (D-15.9-5; see the per-tick re-check below).
    const sid = request.sessionId;
    // M15 15.9 — likewise, and for the same reason: after `reply.hijack()` the request object is
    // still readable, but capturing both credentials together here keeps the per-tick re-check
    // below reading two locals rather than reaching back into `request`.
    const keyId = request.apiKeyId;

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

    /** Tear the stream down mid-flight, telling the client WHY before closing the socket. */
    const terminate = (reason: string): void => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: reason })}\n\n`);
      reply.raw.end();
    };

    const push = async (): Promise<void> => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const now = new Date();
        // M15 15.6 (D-M15-12) — RE-CHECK THE SESSION EVERY TICK. This is the one route in the
        // product that keeps serving data after `resolvePrincipal` has returned, so a
        // connect-time-only gate means revocation does not reach it: measured before this fix, a
        // stream kept delivering the org's live snapshot for as long as the client held the socket
        // AFTER `revoke-all` (and after the viewer was removed from the org) had made every other
        // route 401. "Remove an employee, sign them out" is the canonical use case for this slice,
        // and the one long-lived thing they have open was exactly what it missed.
        //
        // The previous comment here justified NOT doing this — "that would be a DB round trip per
        // SSE frame" — and it was measuring the wrong thing. A full `resolvePrincipal` is two
        // queries; this is ONE primary-key probe, added to a tick that already opens a transaction
        // spanning eight reads plus a reconcile write. The cost is noise; the gap was a hole.
        //
        // M15 15.9 — THE SAME OBLIGATION NOW APPLIES TO API KEYS, and this comment previously said
        // the opposite. It justified skipping the probe when `sid === null` on the grounds that
        // such a caller was necessarily an `ADMIN_TOKEN` holder, whose tier was "un-revocable by
        // construction". That was true of `ADMIN_TOKEN` and is FALSE of an API key: a key is
        // revocable, expirable, and its owner can be removed from the org. Inheriting the old skip
        // would have re-opened, one tier over, the exact hole 15.6 closed here — revoke a key and
        // the desktop app's open stream keeps delivering the org's live snapshot for as long as it
        // holds the socket, with every other route already 401ing.
        //
        // Exactly ONE of the two is non-null for an authenticated caller (a key mints no session,
        // D-15.9-5), so this is two guards, not a branch — and if a THIRD credential tier is ever
        // added it inherits the same obligation. A connect-time-only gate does not revoke.
        //
        // `isApiKeyLive`, deliberately NOT `findLiveApiKey`: the latter is the auth hot path and
        // its caller stamps `last_used_at`. Probing with it here would make every connected client
        // a write per tick — precisely the audit-B.4 shape `shouldReconcile` above exists to
        // remove, and precisely why `sessions` has no such column at all.
        if (sid) {
          const live = await findLiveSession(app.db, sid);
          if (!live) return terminate("session revoked");
        }
        if (keyId && !(await isApiKeyLive(app.db, keyId))) {
          return terminate("api key revoked");
        }
        // M15 15.2: `userId` comes from the principal resolved ONCE before the stream
        // started, so the old `userId ? … : empty` fallback is dead. Teardown wiring
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
        const reconcile = shouldReconcile(principal.orgId, userId, now);
        const snap = await withOrg(app.db, principal.orgId, SERVICE_ROLE, (tx) =>
          buildSnapshot(tx, principal.orgId, userId, now, reconcile),
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
