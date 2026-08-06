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
  listAlertFirings,
  deliverPendingFirings,
  deliverResolvedFirings,
  withOrg,
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
import { deriveAlertSet, openFiringsDiverge } from "./alert-set.js";

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
   */
  shouldReconcile?: (orgId: string, userId: string, now: Date) => boolean;
}

/** What one tick did, for the caller's log line. Counts, never rows — nothing here is a wire type. */
export interface EvaluatorTickResult {
  /** Orgs that were evaluated (i.e. had at least one member). */
  orgs: number;
  /** Orgs skipped because they had no members at all. */
  skipped: number;
  /** Total alerts derived across all evaluated orgs. */
  alerts: number;
  /** Orgs whose evaluation threw; each was reported via `onError` and did not stop the loop. */
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
 * D-16.6-2 — `userId` is the org's OWNER (resolved by the caller). `alert_firings_open_key` is
 * unique on `(user_id, alert_key) WHERE status = 'open'` (`schema.ts:980`), so the choice of user
 * decides whether this tick COLLIDES with the dashboard's firing row or DUPLICATES it. Reconciling
 * under a different user than the dashboard would open a second row and send a second email for
 * one outage. Measured in the planning spike, not reasoned about.
 *
 * KNOWN, OUT OF SCOPE, AND NOT AS DORMANT AS IT LOOKS — two of the nine codes are GLOBAL.
 * `catalog.update_requires_approval` and `ingest.auth_failure` derive from tables with no `org_id`
 * (`countPendingCatalogs`, `countRecentAuthFailures`), so ONE pending catalog opens a firing in
 * EVERY org and, with a deliverer wired, sends one notice per org plus one resolve notice per org.
 *
 * An earlier version of this note defended that with "each org's dashboard read already does
 * exactly this". Review showed the defence is FALSE, and the way it is false is the interesting
 * part: `ensurePersonalOrg` gives every user their own org, so org count tracks USER count rather
 * than tenant count — inviting two teammates makes this a three- or four-org deployment
 * immediately. Nobody ever opens a dashboard for a colleague's auto-created personal org, so before
 * 16.6 those orgs were never evaluated at all. The tick evaluates them, which is correct for
 * per-machine codes and is duplicative for the two global ones.
 *
 * Left as-is deliberately: this slice adds no alert code and changes no derivation, and the fix
 * (deriving the global codes once per tick rather than once per org, or gating on "the org owns at
 * least one machine") changes alert semantics for the read path too. It is stated here so the next
 * reader inherits the measurement rather than the earlier wrong reassurance.
 *
 * A SECOND, OLDER WART THIS DOES NOT FIX, named for the same reason: firings are keyed
 * `(user_id, alert_key)`, and the dashboard reconciles as `principal.userId`. So an `admin` or
 * `viewer` opening the monitor opens a SECOND row for the same condition under their own id and
 * triggers a second delivery. That predates 16.6 and is inherent to the per-user firing model —
 * but because the tick now guarantees the owner's row always exists, what used to need two people
 * with the dashboard open is now the default for any non-owner viewer. D-16.6-2 reasons only about
 * not duplicating the OWNER's row. The real fix is making firings org-keyed.
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
    const pendingCatalogs = await countPendingCatalogs(tx);
    // NO `orgId`, deliberately. `countRecentAuthFailures` is global on purpose
    // (`auth-failures.ts:37`): the auth failure that matters here is by definition from a machine
    // no org can claim — which is precisely the signal INC-2026-07 generated and nobody evaluated.
    const authFailureCount = await countRecentAuthFailures(
      tx,
      new Date(nowMs - AUTH_FAILURE_ALERT.windowMs),
    );

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

    // ALL NINE CODES — via the SHARED composition, which is the whole point. Completeness is a
    // CORRECTNESS requirement rather than tidiness: `reconcileAlertFirings` resolves every open
    // firing whose key is not in the derived set (`alert-firings.ts`, D5), so a tick deriving fewer
    // codes than the dashboard would silently RESOLVE the missing ones every 60 s while the
    // dashboard re-opened them — flapping, plus a resolve email per cycle for an outage that never
    // ended. This slice originally duplicated the six-call list here and asserted the requirement
    // in a comment; review pointed out that a comment enforces nothing and `tsc` cannot see a
    // divergence between two independently-valid call sites, so it is now structural: one list, in
    // `alert-set.ts`, shared with the route. See that file for the full argument.
    //
    // It is also why `connectors` above is really queried: `deriveAlerts` reads
    // `snapshot.connectors` for `connector.failing`, so passing `[]` would drop a code.
    const derived = deriveAlertSet(built, {
      samplesByMachine,
      pendingCatalogs,
      authFailureCount,
      windowedConnectors,
    });
    // THROTTLED, UNLESS THE ANSWER WOULD DIFFER — the route's exact logic (`routes/monitor.ts`),
    // now reached through the shared `openFiringsDiverge`. A blanket "skip the reconcile while
    // throttled" would be wrong in the way that is easy to miss: `deliverPendingFirings` reads
    // persisted ROWS, so a newly-derived alert with no row yet would be un-ackable and undelivered
    // until the throttle elapsed — on the one path whose entire job is to report that something
    // broke. So a throttled tick READS first (a SELECT it would do anyway) and reconciles anyway
    // when the derived set disagrees with what is persisted. The write is skipped only when there
    // is genuinely nothing to write, which is the common case by far.
    const due = deps.shouldReconcile?.(orgId, userId, deps.now) ?? true;
    const persisted = due ? null : await listAlertFirings(tx, orgId, userId, deps.now);
    if (persisted === null || openFiringsDiverge(derived, persisted)) {
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
  await deliverPendingFirings(
    deps.db,
    orgId,
    SERVICE_ROLE,
    userId,
    deps.deliverer,
    deps.now,
    deps.onError,
  );
  await deliverResolvedFirings(
    deps.db,
    orgId,
    SERVICE_ROLE,
    userId,
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
  const result: EvaluatorTickResult = { orgs: 0, skipped: 0, alerts: 0, failed: 0 };
  const orgs = await listOrganizations(deps.db);
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
