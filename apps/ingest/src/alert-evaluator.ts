import {
  listOrganizations,
  listMembers,
  machineStatuses,
  connectorHealth,
  connectorHealthWindowed,
  recentBacklogSamples,
  countPendingCatalogs,
  countRecentAuthFailures,
  reconcileAlertFirings,
  reconcileDeploymentFirings,
  listAlertFirings,
  listDeploymentFirings,
  deliverPendingFirings,
  deliverResolvedFirings,
  withOrg,
  withDeployment,
  type Db,
} from "@420ai/db";
import {
  deriveMachineStatus,
  isBacklogHigh,
  BACKLOG_TREND_WINDOW_MS,
  AUTH_FAILURE_ALERT,
  CONNECTOR_RATE_ALERT,
  MONITOR_VERSION,
  SERVICE_ROLE,
  type AlertFiring,
  type LiveMonitorSnapshot,
} from "@420ai/shared";
import {
  deriveAlertSet,
  deriveDeploymentAlertSet,
  openFiringsDiverge,
  reconcileThrottleKey,
  DEPLOYMENT_THROTTLE_KEY,
} from "./alert-set.js";

/**
 * M16 16.6 — the BACKGROUND alert evaluator (INC-2026-07).
 *
 * THE DEFECT THIS EXISTS FOR. M10 3c chose evaluate-on-read with "no background dispatcher"
 * (`routes/monitor.ts`'s D1). That decision was deliberate and documented; its CONSEQUENCE was
 * not. `reconcileAlertFirings` + `deliverPendingFirings` were reachable from exactly one place —
 * inside `GET /v1/monitor` — so **the trigger for evaluating alerts was a human opening the
 * dashboard**, and a human has no reason to do that while they believe things are fine. Capture
 * then ran dead for ~8 days with 159,828 queue items stranded, and all nine alert codes stayed
 * underivable-in-practice for the whole incident. The data was present, `deriveAuthFailureAlerts`
 * was correct, and `ingest_auth_failures` rows were being written the entire time. Only the
 * trigger was missing:
 *
 *   > `derivable ≠ detected` — the fourth member of the repo's `skipped ≠ passed`,
 *   > `bypassed ≠ enforced`, `passes on fixtures ≠ runs in production` family. A monitor whose
 *   > evaluation trigger is the operator's suspicion can only ever confirm what the operator
 *   > already suspects.
 *
 * SILENT LIBRARY (CLAUDE.md's logging boundary): nothing here logs, reads argv or exits. Errors
 * go to the injected `onError`, exactly as `routes/monitor.ts:190` passes `(e) => app.log.error(e)`.
 * The clock is injected too (repo convention: the caller owns `now`), which is what lets the
 * integration test drive a tick deterministically instead of sleeping on a 60 s interval.
 *
 * This module deliberately does NOT export or reuse `routes/monitor.ts`'s private `buildSnapshot`.
 * That function carries the route's throttle bookkeeping, its principal handling and its firing-list
 * read; a tick has none of them — no principal at all, and nothing to throttle against. Sharing it
 * would mean threading "am I a route?" flags through the load-bearing read path.
 *
 * What IS shared is the part that must never diverge: the six-call alert composition, extracted to
 * `alert-set.ts` and used by both. That distinction is the whole design — the READS differ
 * legitimately (the tick skips `activeSessions`, which nothing derives from), while the DERIVE list
 * cannot differ without making firings flap. The first cut of this slice duplicated the list and
 * asserted the requirement in a comment; review pointed out that a comment enforces nothing and
 * `tsc` sees two independently-valid call sites, so it was made structural.
 */

/** Everything a tick needs, all injected — no globals, no wall clock of its own. */
export interface EvaluatorDeps {
  /** The UNWRAPPED handle. `withOrg` is opened per org inside; see `evaluateOrgAlerts`. */
  db: Db;
  /** `null` → delivery disabled; the two deliver calls early-return without querying. */
  deliverer: { deliver(firing: AlertFiring): Promise<void> } | null;
  /** Caller-owned clock (CLAUDE.md). The tick reconciles and delivers with the SAME instant. */
  now: Date;
  /** Library file — it never logs itself. The plugin wires this to `app.log.error`. */
  onError: (err: unknown) => void;
  /**
   * The SAME reconcile gate `routes/monitor.ts` applies, injected so the tick and the route share
   * one throttle keyed on `(orgId, userId)` (M15 15.4 audit B.4).
   *
   * Sharing it is not about saving a write. Before this, the tick reconciled unconditionally while
   * the route consulted `app.reconcileLastRunAt`, so two reconciles for the SAME `(org, owner)`
   * could run concurrently — and `reconcileAlertFirings` takes locks in two phases: a per-alert
   * upsert loop, then a bulk `UPDATE … WHERE alert_key NOT IN (keys)`. When two transactions derive
   * DIFFERENT alert sets, phase 1 of one holds rows phase 2 of the other wants and vice versa —
   * a lock-order inversion, i.e. `40P01`. Divergent sets are ordinary rather than exotic: every
   * alert is time-windowed and the two callers hold different `now` values, so a window boundary
   * crossing between them is enough. That deadlock is also precisely the never-settling tick that
   * wedges the plugin's re-entrancy guard permanently, from which there is no automatic recovery.
   *
   * Omitted → always reconcile, which is the right default for a direct call in a test.
   *
   * M16 16.7 — takes an opaque KEY rather than `(orgId, userId)`, because there is now a third
   * caller with no org and no user: the deployment pass, which throttles under the reserved
   * `DEPLOYMENT_THROTTLE_KEY` sentinel. Both key spellings live in `alert-set.ts` so the route and
   * the tick cannot compute them differently — which would give each its own idea of when the last
   * reconcile happened, restoring both the steady-state write and the concurrent-reconcile
   * deadlock this dep exists to prevent.
   */
  shouldReconcile?: (key: string, now: Date) => boolean;
}

/** What one tick did, for the caller's log line. Counts, never rows — nothing here is a wire type. */
export interface EvaluatorTickResult {
  /** Orgs that were evaluated (i.e. had at least one member). */
  orgs: number;
  /** Orgs skipped because they had no members at all. */
  skipped: number;
  /** Total alerts derived — org scopes PLUS the deployment scope, so the log line has one total. */
  alerts: number;
  /**
   * M16 16.7 — of which, derived by the once-per-tick DEPLOYMENT pass. Broken out so an operator
   * reading the log can tell "one deployment-wide condition" from "one condition in each of four
   * orgs", which is exactly the distinction 16.7 exists to restore.
   */
  deploymentAlerts: number;
  /**
   * Evaluations that threw; each was reported via `onError` and did not stop the tick. Counts the
   * deployment pass as one alongside the per-org failures — it is isolated the same way.
   */
  failed: number;
}

/**
 * Evaluate, reconcile and deliver the alerts for ONE org, as that org's bookkeeping.
 *
 * `SERVICE_ROLE`, not a member's role, and the reasoning is M15 15.4's verbatim — "whose action
 * is this?", not "who triggered it?". Here the question barely needs asking: a timer tick has no
 * principal whatsoever, so there is no member role it could borrow. Passing an org's viewer would
 * make the 0016 RESTRICTIVE INSERT policy reject the reconcile and the `delivery_attempted_at`
 * stamp — silently, in the case of the stamp, because delivery is best-effort by design.
 *
 * D-16.6-2 — `userId` is the org's OWNER (resolved by the caller). Until 16.7 that choice decided
 * whether this tick COLLIDED with the dashboard's firing row or DUPLICATED it, because the unique
 * index carried `user_id`. It no longer does: the key is `(org_id, alert_key)` and `user_id` is
 * PROVENANCE (D-16.7-2), so any member's id converges on the same row. The owner is still the
 * deterministic choice — it makes "who first saw this" stable across ticks.
 *
 * THE TWO DEFECTS 16.6 DOCUMENTED HERE ARE FIXED, and 16.7's migration 0027 is the fix:
 *
 *   - Two of the nine codes are DEPLOYMENT-wide (`catalog.update_requires_approval`,
 *     `ingest.auth_failure`, both deriving from tables with no `org_id`), so the per-org loop
 *     opened a firing in EVERY org for one condition — and `ensurePersonalOrg` makes org count
 *     track USER count, so that was three or four notices as soon as two teammates were invited.
 *     They now derive ONCE per tick in `evaluateDeploymentAlerts` below, into a single row whose
 *     `org_id IS NULL`, which every org can see and any member can ack once.
 *   - Within one org, a non-owner opening the monitor opened a SECOND row under their own id. The
 *     org-keyed index makes that the same row.
 *
 * The two scopes cannot make each other flap: their reconciles filter `org_id = :orgId` and
 * `org_id IS NULL` respectively, which are disjoint (D-16.7-3, argued in full in `alert-set.ts`).
 * That is why splitting the derive list — which 16.6's module doc warned against — is safe here.
 *
 * Returns the number of alerts derived.
 */
export async function evaluateOrgAlerts(
  deps: EvaluatorDeps,
  orgId: string,
  userId: string,
): Promise<number> {
  const nowMs = deps.now.getTime();
  const trendSince = new Date(nowMs - BACKLOG_TREND_WINDOW_MS);
  const connectorRateSinceIso = new Date(nowMs - CONNECTOR_RATE_ALERT.windowMs).toISOString();

  const alerts = await withOrg(deps.db, orgId, SERVICE_ROLE, async (tx) => {
    // SEQUENTIAL awaits, never `Promise.all` — inherited verbatim from `routes/monitor.ts:81-86`.
    // `tx` is a transaction, a transaction is ONE connection, and node-postgres queues concurrent
    // queries on it while emitting `Calling client.query() when the client is already executing a
    // query is deprecated` (removed in pg@9). The "parallel" version never overlapped anyway.
    //
    // `orgId` is the SECOND argument on every one of these (the 15.2 convention).
    const machines = await machineStatuses(tx, orgId);
    const connectors = await connectorHealth(tx, orgId);
    const windowedConnectors = await connectorHealthWindowed(tx, orgId, connectorRateSinceIso);
    const samplesByMachine = await recentBacklogSamples(tx, orgId, trendSince);
    // M16 16.7: `countPendingCatalogs` / `countRecentAuthFailures` are NOT read here any more.
    // Both are deployment-wide (neither table carries an `org_id`), so reading them per org is
    // what produced one firing per org for one condition. They moved to
    // `evaluateDeploymentAlerts`, which runs ONCE per tick.

    const machineRows = machines.map((m) => ({
      ...m,
      status: deriveMachineStatus(m, nowMs),
      backlogHigh: isBacklogHigh(m.queuePending),
    }));
    const built: LiveMonitorSnapshot = {
      monitorVersion: MONITOR_VERSION,
      generatedAt: deps.now.toISOString(),
      machines: machineRows,
      connectors,
      // `activeSessions` IS DELIBERATELY EMPTY AND MUST STAY THAT WAY. It is the most expensive
      // read in `buildSnapshot` and NO alert derives from it — grep the six derive functions:
      // none touches `snapshot.activeSessions`. Do not "complete the pattern" by adding the query
      // here; it would cost the tick its cheapest property for nothing. (Contrast `connectors`
      // directly above, which `deriveAlerts` DOES read for `connector.failing` — see below.)
      activeSessions: [],
      alerts: [],
      alertFirings: [],
    };

    // THE SEVEN ORG CODES — via the SHARED composition, which is the whole point. Completeness
    // WITHIN THE SCOPE is a CORRECTNESS requirement rather than tidiness: `reconcileAlertFirings`
    // resolves every open firing in scope whose key is not in the derived set (`alert-firings.ts`,
    // D5), so a tick deriving fewer org codes than the dashboard would silently RESOLVE the missing
    // ones every 60 s while the dashboard re-opened them — flapping, plus a resolve email per cycle
    // for an outage that never ended. One list, in `alert-set.ts`, shared with the route.
    //
    // M16 16.7: the DEPLOYMENT codes are legitimately absent — they are a different scope with a
    // disjoint resolve predicate, so neither list can resolve the other's firings. That is what
    // makes splitting the list safe where merely duplicating it was not.
    //
    // It is also why `connectors` above is really queried: `deriveAlerts` reads
    // `snapshot.connectors` for `connector.failing`, so passing `[]` would drop a code.
    const derived = deriveAlertSet(built, { samplesByMachine, windowedConnectors });
    // THROTTLED, UNLESS THE ANSWER WOULD DIFFER — the route's exact logic (`routes/monitor.ts`),
    // now reached through the shared `openFiringsDiverge`. A blanket "skip the reconcile while
    // throttled" would be wrong in the way that is easy to miss: `deliverPendingFirings` reads
    // persisted ROWS, so a newly-derived alert with no row yet would be un-ackable and undelivered
    // until the throttle elapsed — on the one path whose entire job is to report that something
    // broke. So a throttled tick READS first (a SELECT it would do anyway) and reconciles anyway
    // when the derived set disagrees with what is persisted. The write is skipped only when there
    // is genuinely nothing to write, which is the common case by far.
    //
    // M16 16.7 — compare against the ORG-SCOPED firings only. `listAlertFirings` unions this org's
    // rows with the deployment's, so feeding the union in while deriving only the seven org codes
    // would report divergence on EVERY tick forever, defeating the throttle entirely.
    const due = deps.shouldReconcile?.(reconcileThrottleKey(orgId, userId), deps.now) ?? true;
    const persisted = due ? null : await listAlertFirings(tx, orgId, deps.now);
    if (
      persisted === null ||
      openFiringsDiverge(
        derived,
        persisted.filter((f) => f.scope === "org"),
      )
    ) {
      await reconcileAlertFirings(tx, orgId, userId, derived, deps.now);
    }
    return derived;
  });

  // OUTSIDE the transaction, on the UNWRAPPED `deps.db`, and both halves are load-bearing (M15
  // 15.3, restated at `routes/monitor.ts:170-174`). These two open their OWN short `withOrg`
  // transactions around each statement and run the webhook/SMTP round-trip BETWEEN them. Wrapping
  // them in the `withOrg` above would pin one pooled connection across a third-party network hop.
  // Calling them with no org context at all would be worse: `alert_firings` carries a strict
  // policy, so they would read ZERO rows, deliver nothing, and report success.
  const scope = { kind: "org", orgId } as const;
  await deliverPendingFirings(deps.db, scope, SERVICE_ROLE, deps.deliverer, deps.now, deps.onError);
  await deliverResolvedFirings(
    deps.db,
    scope,
    SERVICE_ROLE,
    deps.deliverer,
    deps.now,
    deps.onError,
  );
  return alerts.length;
}

/**
 * M16 16.7 — evaluate, reconcile and deliver the DEPLOYMENT's alerts. Runs ONCE per tick, not once
 * per org, which is the entire fix for defect 1.
 *
 * `catalog.update_requires_approval` and `ingest.auth_failure` derive from `pricing_catalogs` and
 * `ingest_auth_failures`, neither of which carries an `org_id`. Reading them inside the per-org
 * loop meant ONE pending catalog opened a firing in EVERY org and — with a deliverer wired — sent
 * one notice per org plus one resolve notice per org. `ensurePersonalOrg` gives every user their
 * own org, so that scaled with the head-count, not with the tenant count.
 *
 * Runs under `withDeployment`, which sets the role and deliberately leaves `app.current_org` unset:
 * an unset org context reads exactly the `org_id IS NULL` rows and may insert one, while still
 * being refused an org-scoped insert. Both tables it reads carry no RLS at all (D-M15-9).
 *
 * `userId` is PROVENANCE for the row (the column is NOT NULL); the caller passes some real user —
 * there is no deployment-level principal, and inventing one would need a users row.
 *
 * Returns the number of deployment alerts derived.
 */
export async function evaluateDeploymentAlerts(
  deps: EvaluatorDeps,
  userId: string,
): Promise<number> {
  const alerts = await withDeployment(deps.db, SERVICE_ROLE, async (tx) => {
    // SEQUENTIAL awaits — a transaction is ONE connection (see `evaluateOrgAlerts`).
    const pendingCatalogs = await countPendingCatalogs(tx);
    // NO `orgId`, deliberately. `countRecentAuthFailures` is global on purpose
    // (`auth-failures.ts:37`): the auth failure that matters here is by definition from a machine
    // no org can claim — which is precisely the signal INC-2026-07 generated and nobody evaluated.
    const authFailureCount = await countRecentAuthFailures(
      tx,
      new Date(deps.now.getTime() - AUTH_FAILURE_ALERT.windowMs),
    );
    const derived = deriveDeploymentAlertSet({ pendingCatalogs, authFailureCount });
    // Same "throttled, UNLESS the answer would differ" logic as the org path, under the reserved
    // sentinel key so the route and the tick share ONE throttle for the single shared row.
    const due = deps.shouldReconcile?.(DEPLOYMENT_THROTTLE_KEY, deps.now) ?? true;
    const persisted = due ? null : await listDeploymentFirings(tx, deps.now);
    if (persisted === null || openFiringsDiverge(derived, persisted)) {
      await reconcileDeploymentFirings(tx, userId, derived, deps.now);
    }
    return derived;
  });

  // OUTSIDE the transaction, on the UNWRAPPED handle, for the reasons `evaluateOrgAlerts` states:
  // these open their own short contexts per statement and run the webhook/SMTP hop between them.
  const scope = { kind: "deployment" } as const;
  await deliverPendingFirings(deps.db, scope, SERVICE_ROLE, deps.deliverer, deps.now, deps.onError);
  await deliverResolvedFirings(
    deps.db,
    scope,
    SERVICE_ROLE,
    deps.deliverer,
    deps.now,
    deps.onError,
  );
  return alerts.length;
}

/**
 * One full tick: every org in the deployment, evaluated and delivered.
 *
 * The loop shape is the one `listOrganizations`' own doc comment already prescribes for
 * deployment-wide work (M15 15.3, D-15.3-5): `listOrganizations` then one `withOrg` pass per org.
 * The alternative — a privileged cross-org connection — would put a permanent tenancy seam in the
 * server so that a timer could avoid a loop. `organizations` and `memberships` carry no RLS
 * (D-15.3-4), which is why both reads here run on the unwrapped app-role handle.
 *
 * PER-ORG ERROR ISOLATION. One org's failure must not cost every other org its detection — this is
 * the component whose entire job is to survive to report other components' failures. Each org is
 * evaluated in its own try/catch; the error is handed to `onError` and the loop continues.
 */
export async function runEvaluatorTick(deps: EvaluatorDeps): Promise<EvaluatorTickResult> {
  const result: EvaluatorTickResult = {
    orgs: 0,
    skipped: 0,
    alerts: 0,
    deploymentAlerts: 0,
    failed: 0,
  };
  const orgs = await listOrganizations(deps.db);
  /**
   * M16 16.7 — THE DEPLOYMENT PASS, once, before the org loop.
   *
   * IN ITS OWN try/catch, mirroring the per-org isolation below and for the stronger version of the
   * same reason: this is the tick's shared prologue, so an unhandled failure here would abort EVERY
   * org's evaluation — one broken deployment-wide count taking down the whole detector, in the
   * component whose entire job is to survive to report other components' failures. The error is
   * labelled `deployment` for the same reason the org error is wrapped with its org id: `onError`
   * is also the sink for per-firing delivery failures from three other places, so a bare stack
   * trace leaves the operator unable to tell which pass produced it.
   *
   * It needs SOME user id for the firing row's provenance column and there is no deployment-level
   * principal, so it borrows the first org's reconcile user — resolved by the same
   * `owner-then-first-member` rule the loop uses. A deployment with no users at all has nothing to
   * alert anybody about, so the pass is skipped rather than failed.
   */
  let deploymentUserId: string | undefined;
  for (const org of orgs) {
    try {
      const members = await listMembers(deps.db, org.id);
      const user = members.find((m) => m.role === "owner") ?? members[0];
      if (user) {
        deploymentUserId = user.userId;
        break;
      }
    } catch {
      // A failure to resolve a provenance user from THIS org is not a reason to skip the whole
      // deployment pass — the loop below reports the same org's failure with its own id attached.
      continue;
    }
  }
  if (deploymentUserId) {
    try {
      result.deploymentAlerts = await evaluateDeploymentAlerts(deps, deploymentUserId);
      result.alerts += result.deploymentAlerts;
    } catch (err) {
      result.failed += 1;
      deps.onError(new Error("alert evaluator: deployment scope failed", { cause: err }));
    }
  }
  for (const org of orgs) {
    try {
      const members = await listMembers(deps.db, org.id);
      // D-16.6-2: the OWNER, deterministically — `listMembers` orders by `(created_at, id)`, so
      // "the first owner" is the same row on every tick and matches what `findPrincipalByEmail`
      // resolves for a single-member org (the dogfood case). The fallback to the first member
      // covers an org mid-teardown whose last owner has already been removed; an org with NO
      // members is skipped rather than throwing, because `withOrg` needs a user to reconcile as.
      const reconcileUser = members.find((m) => m.role === "owner") ?? members[0];
      if (!reconcileUser) {
        result.skipped += 1;
        continue;
      }
      // A FRESH CLOCK PER ORG, not one instant frozen across the whole tick. Within a single org
      // the reconcile and both deliver calls must share an instant (that pairing is what makes
      // `first_fired_at`/`resolved_at`/`delivery_attempted_at` consistent), but ACROSS orgs a frozen
      // clock means the last org is judged against a `now` stale by the whole tick duration: a
      // machine that crossed the offline threshold mid-tick stays `online` for another cycle, and
      // stamps record times earlier than the events they describe. Harmless at one org; org count
      // tracks USER count here (`ensurePersonalOrg`), so it does not stay at one.
      result.alerts += await evaluateOrgAlerts(
        { ...deps, now: new Date() },
        org.id,
        reconcileUser.userId,
      );
      result.orgs += 1;
    } catch (err) {
      result.failed += 1;
      // WRAPPED WITH THE ORG ID. `onError` is also the sink for per-firing delivery failures from
      // two other functions, so a bare stack trace leaves the operator unable to tell which org
      // failed or even which of three sources produced it — in a component whose entire value is
      // making failures legible.
      deps.onError(new Error(`alert evaluator: org ${org.id} failed`, { cause: err }));
    }
  }
  return result;
}
