import type { FastifyInstance } from "fastify";
import {
  deriveMachineStatus,
  isBacklogHigh,
  BACKLOG_TREND_WINDOW_MS,
  AUTH_FAILURE_ALERT,
  CONNECTOR_RATE_ALERT,
  MONITOR_VERSION,
  ACTIVE_WINDOW_MS,
  SERVICE_ROLE,
  sortAlerts,
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
  reconcileDeploymentFirings,
  listAlertFirings,
  listDeploymentFirings,
  deliverPendingFirings,
  deliverResolvedFirings,
  countPendingCatalogs,
  countRecentAuthFailures,
  findLiveSession,
  isApiKeyLive,
  withOrg,
  withDeployment,
  type DbClient,
} from "@420ai/db";
import { resolvePrincipal, authorized } from "../auth.js";
import {
  deriveAlertSet,
  deriveDeploymentAlertSet,
  openFiringsDiverge,
  reconcileThrottleKey,
  DEPLOYMENT_THROTTLE_KEY,
} from "../alert-set.js";

// `ACTIVE_WINDOW_MS` was a local const here until M16 16.2. It moved to `@420ai/shared` because
// `GET /v1/labels/queue` defines "settled" as the inverse of this same window (D-16.2-2) and the
// two surfaces must not be able to disagree. Behaviour here is unchanged — same 15 minutes.

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
  deploymentAlerts: OperationalAlert[],
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
  // M16 16.7: `countPendingCatalogs` / `countRecentAuthFailures` were read HERE until this slice.
  // They moved to `reconcileDeployment` in the route handler, which derives the two deployment
  // codes and hands them back as `deploymentAlerts` — so those tables are read ONCE per tick, not
  // once here plus once there. Neither carries an `org_id`, which is the whole reason they are not
  // this function's business.
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
  // Frozen deriveAlerts (D2) + the sibling backlog-growing + archive-unreachable + windowed
  // connector-rate derivatives, merged + re-sorted.
  //
  // M16 16.7 — THE TWO GLOBAL CODES ARE NOT HERE. `catalog.update_requires_approval` and
  // `ingest.auth_failure` moved to `deriveDeploymentAlertSet` and arrive as `deploymentAlerts`;
  // this comment used to name the catalog alert as one of these derivatives, which would send a
  // reader looking for it in the org reconcile and — not finding it — "restore" it, reintroducing
  // the one-firing-per-org defect the slice exists to remove.
  //
  // M16 16.6 — the shared list MOVED to `alert-set.ts` and is used by the background evaluator too.
  // Sharing is required rather than tidy: `reconcileAlertFirings` resolves any open firing whose key
  // is absent from the derived set, so two callers whose lists disagree WITHIN a scope make every
  // firing in the difference flap between the read path and the timer. Across the two SCOPES that
  // cannot happen at all — their resolve predicates are disjoint (D-16.7-3). See `alert-set.ts`.
  //
  // M16 16.7 — TWO derivations now. `orgAlerts` is what this org's firings reconcile against;
  // `alerts` on the wire is both scopes merged and re-sorted, so the dashboard's `alerts` array is
  // byte-identical to before the split. Only the FIRING rows moved scope.
  const orgAlerts = deriveAlertSet(built, { samplesByMachine, windowedConnectors });
  const alerts = sortAlerts([...orgAlerts, ...deploymentAlerts]);
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
  //
  // M16 16.7 — the divergence comparison is against the ORG-SCOPED firings only. `listAlertFirings`
  // returns this org's rows UNIONED with the deployment's (it must; the dashboard renders that list
  // and nothing else), and comparing that union against the seven org codes would differ on every
  // tick forever — reporting divergence permanently and quietly restoring the every-3-s write the
  // throttle exists to remove. The deployment scope reconciles separately, in the route handler.
  let alertFirings = reconcile ? null : await listAlertFirings(db, orgId, now);
  if (
    alertFirings === null ||
    openFiringsDiverge(
      orgAlerts,
      alertFirings.filter((f) => f.scope === "org"),
    )
  ) {
    alertFirings = await reconcileAlertFirings(db, orgId, userId, orgAlerts, now);
  }
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
 *
 * M15 15.4: passes `SERVICE_ROLE`, NOT `principal.role`, and that choice is load-bearing.
 * Delivery is TRIGGERED by whoever happens to have the monitor open, but the ACTION belongs to
 * the org. Under `principal.role` an org whose only active user is a viewer would have every
 * webhook and email silently stop — the 0016 restrictive UPDATE policy would reject the
 * `delivery_attempted_at` stamp inside a best-effort try/catch that is designed not to
 * complain. That is precisely the bug class the 15.3 code review caught here.
 */
async function deliverFirings(app: FastifyInstance, orgId: string, now: Date): Promise<void> {
  const log = (e: unknown): void => app.log.error(e);
  try {
    // M16 16.7 — FOUR calls, two scopes. The deployment pass claims the `org_id IS NULL` rows under
    // `withDeployment` (opened internally, per statement, exactly as the org pass does). Running it
    // per request is safe for the same two reasons the deployment RECONCILE is: the scopes are
    // disjoint, and 16.6's atomic claim (`UPDATE … WHERE delivery_attempted_at IS NULL …
    // RETURNING`) means exactly one caller can ever win a row however many race for it. That is why
    // collapsing N per-member rows to one collapsed N notices to one with no new dedupe machinery.
    const orgScope = { kind: "org", orgId } as const;
    const deploymentScope = { kind: "deployment" } as const;
    await deliverPendingFirings(app.db, orgScope, SERVICE_ROLE, app.alertDeliverer, now, log);
    await deliverResolvedFirings(app.db, orgScope, SERVICE_ROLE, app.alertDeliverer, now, log);
    await deliverPendingFirings(
      app.db,
      deploymentScope,
      SERVICE_ROLE,
      app.alertDeliverer,
      now,
      log,
    );
    await deliverResolvedFirings(
      app.db,
      deploymentScope,
      SERVICE_ROLE,
      app.alertDeliverer,
      now,
      log,
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
   * The map is keyed on an OPAQUE THROTTLE KEY — `reconcileThrottleKey(orgId, userId)` for an org,
   * and the reserved `DEPLOYMENT_THROTTLE_KEY` sentinel for the once-per-tick deployment pass (both
   * spelled in `alert-set.ts` so the route and the background tick cannot compute them differently).
   *
   * M16 16.7: this used to read "keyed on org+user (the same grain as the firing rows themselves)",
   * which is now false on BOTH halves — firing rows key on `(org_id, alert_key)` with `user_id`
   * demoted to provenance, and the map also holds a key belonging to no org at all. A reader
   * trusting the old sentence would take the sentinel for a bug and "fix" it. The org key is simply
   * FINER than the rows it throttles, which costs at most one extra reconcile and never a wrong
   * result.
   *
   * It lives on the app, so it is per-process and resets on restart — also fine, for the same
   * reason: a missed throttle window costs one extra reconcile.
   *
   * The timestamp is stamped BEFORE the snapshot await, not after: two overlapping requests must
   * not both observe a stale `last`. (The SSE path's `inFlight` guard prevents that within one
   * stream, but two browser tabs are two streams.)
   */
  const shouldReconcile = (key: string, now: Date): boolean => {
    const last = app.reconcileLastRunAt.get(key) ?? 0;
    const due = now.getTime() - last >= app.reconcileThrottleMs;
    if (due) app.reconcileLastRunAt.set(key, now.getTime());
    return due;
  };

  /**
   * M16 16.7 — the DEPLOYMENT-scoped half of evaluate-on-read: derive the two codes that belong to
   * no tenant, reconcile them into the single `org_id IS NULL` firing row, and return the alerts so
   * the caller can merge them into the snapshot's `alerts` array.
   *
   * IT CANNOT LIVE INSIDE `buildSnapshot`. That function receives a `Tx` (the route already wrapped
   * it in `withOrg`), while `withDeployment` takes a `Db` and opens its OWN transaction — a `Tx`
   * would produce a SAVEPOINT whose `set_config` scope is the outer org transaction, i.e. an org
   * context wearing a deployment label. So it sits here in the handler, beside `deliverFirings`,
   * which is here for the sibling reason.
   *
   * It runs BEFORE `buildSnapshot`, deliberately: the snapshot's `listAlertFirings` unions the
   * deployment rows, so reconciling afterwards would leave a newly-opened deployment firing out of
   * the very frame that reports it — visible in `alerts`, absent from `alertFirings`, and therefore
   * un-ackable until the next tick. That is the internally-inconsistent frame M15 15.4's throttle
   * note warns about, one scope over.
   *
   * `userId` is PROVENANCE only (D-16.7-2) — whoever's request first opened the row. It scopes
   * nothing, and the upsert leaves the original opener's id in place on every later touch.
   *
   * THROTTLED, UNLESS THE ANSWER WOULD DIFFER — the org path's exact logic, under the reserved
   * sentinel key. The two count reads happen every tick regardless (the wire `alerts` array needs
   * them); only the WRITE is gated.
   */
  const reconcileDeployment = async (userId: string, now: Date): Promise<OperationalAlert[]> => {
    return withDeployment(app.db, SERVICE_ROLE, async (tx) => {
      // SEQUENTIAL awaits, never `Promise.all` — a transaction is ONE connection (see the note in
      // `buildSnapshot`). Neither table carries RLS (both are deployment-global, D-M15-9), so the
      // unset org context here reads them normally.
      const pendingCatalogs = await countPendingCatalogs(tx);
      const authFailureCount = await countRecentAuthFailures(
        tx,
        new Date(now.getTime() - AUTH_FAILURE_ALERT.windowMs),
      );
      const alerts = deriveDeploymentAlertSet({ pendingCatalogs, authFailureCount });
      const due = shouldReconcile(DEPLOYMENT_THROTTLE_KEY, now);
      const persisted = due ? null : await listDeploymentFirings(tx, now);
      if (persisted === null || openFiringsDiverge(alerts, persisted)) {
        await reconcileDeploymentFirings(tx, userId, alerts, now);
      }
      return alerts;
    });
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
    const reconcile = shouldReconcile(reconcileThrottleKey(principal.orgId, userId), now);
    // M16 16.7: deployment scope FIRST — see `reconcileDeployment` for why the order matters.
    const deploymentAlerts = await reconcileDeployment(userId, now);
    const snap = await withOrg(app.db, principal.orgId, SERVICE_ROLE, (tx) =>
      buildSnapshot(tx, principal.orgId, userId, now, reconcile, deploymentAlerts),
    );
    await deliverFirings(app, principal.orgId, now); // best-effort; never throws
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
        const reconcile = shouldReconcile(reconcileThrottleKey(principal.orgId, userId), now);
        // M16 16.7: the deployment reconcile is its own short transaction, before the snapshot's
        // (so the frame includes any firing it opens) and outside it (`withDeployment` takes a
        // `Db`). Its write is gated by the sentinel throttle, which is what stops N connected
        // dashboards writing the single shared deployment row N times every 3 s.
        const deploymentAlerts = await reconcileDeployment(userId, now);
        const snap = await withOrg(app.db, principal.orgId, SERVICE_ROLE, (tx) =>
          buildSnapshot(tx, principal.orgId, userId, now, reconcile, deploymentAlerts),
        );
        // Deliver newly-opened firings before writing the frame (best-effort; guarded on
        // still-connected so a deliver query never runs against a dropped client).
        // OUTSIDE this `withOrg` on purpose: it is best-effort webhook/SMTP I/O, and holding a
        // transaction open across a network round-trip to a third party is how connection
        // pools die. It is still org-SCOPED — it opens its own short transactions internally,
        // which it must, because `alert_firings` carries a strict policy.
        if (!closed) await deliverFirings(app, principal.orgId, now);
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
