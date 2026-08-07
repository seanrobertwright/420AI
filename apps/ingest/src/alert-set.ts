import {
  alertKey,
  type AlertFiring,
  deriveAlerts,
  deriveBacklogTrendAlerts,
  deriveCatalogAlerts,
  deriveAuthFailureAlerts,
  deriveArchiveUnreachableAlerts,
  deriveConnectorFailureRateAlerts,
  sortAlerts,
  type BacklogSample,
  type ConnectorHealthRow,
  type LiveMonitorSnapshot,
  type OperationalAlert,
} from "@420ai/shared";

/**
 * M16 16.6 / 16.7 — THE one place the alert set is composed, now as TWO DISJOINT SCOPES.
 *
 * WHY THESE ARE SHARED FUNCTIONS AND NOT A COMMENT SAYING "KEEP THESE IN SYNC".
 *
 * Two callers derive alerts: `routes/monitor.ts`'s `buildSnapshot` (evaluate-on-read) and
 * `alert-evaluator.ts`'s background tick (evaluate-on-timer). Within a scope they MUST derive the
 * SAME codes, and that is a correctness requirement rather than tidiness: `reconcileFirings`
 * resolves every open firing whose key is not in the derived set (`alert-firings.ts`, D5). So if
 * one caller derives fewer codes than the other, each closes what the other opens — the firing
 * flaps every cycle, and with a deliverer wired the operator gets a resolve notice per tick for an
 * outage that never ended.
 *
 * As duplicated source text that requirement was enforced by NOTHING. Both call sites typecheck
 * independently, so `tsc` cannot see a divergence; no test covered it either. That is the repo's
 * own "a per-FILE grep exempts the file, not the call site" lesson one layer up — and CLAUDE.md is
 * explicit that a comment asserting an invariant IS the defect when nothing enforces it (15.5).
 * So there is one list per scope, and a new alert code can only be added to one of them once.
 *
 * ---
 *
 * M16 16.7 — WHAT CHANGED, AND WHY THE OLD ARGUMENT NO LONGER DESCRIBES THE MECHANISM.
 *
 * Until 16.7 this file argued that ONE shared list is what prevents flapping. That is no longer
 * the mechanism in force, and leaving the old prose beside the new code would reproduce the 15.5
 * defect exactly — a comment naming a mechanism that is not the one protecting you.
 *
 * There are now TWO lists, because two of the nine codes are not any tenant's:
 * `catalog.update_requires_approval` and `ingest.auth_failure` derive from `pricing_catalogs` and
 * `ingest_auth_failures`, which carry no `org_id` at all. Deriving them per-org opened one firing
 * per org for one deployment-wide condition.
 *
 * THE NEW MECHANISM IS DISJOINT `WHERE` PREDICATES, NOT A SHARED ARRAY. The org reconcile filters
 * `org_id = :orgId`, which never matches a NULL row; the deployment reconcile filters
 * `org_id IS NULL`, which never matches an org row. Neither scope can resolve the other's firings,
 * so the two lists CANNOT make each other flap however they diverge. That is strictly stronger
 * than one shared list — it survives a caller getting the split wrong — and it is what allowed the
 * split in the first place. The alternative considered and rejected was gating the global codes on
 * an `includeGlobal` flag both callers compute, which would have re-created precisely the coupling
 * this file exists to remove.
 *
 * What each list still owes is COMPLETENESS WITHIN ITS OWN SCOPE. `alert-set.test.ts` asserts the
 * two key sets are disjoint and that neither leaks a code into the other.
 *
 * DELIBERATELY NOT a refactor of `buildSnapshot` itself. That function carries the route's
 * throttle bookkeeping, its principal handling and its firing-list read, none of which a tick has.
 * What is shared is the pure composition — no clock, no database, no I/O.
 */

/** The non-snapshot inputs the ORG-scoped derive functions need. All pre-windowed by the caller. */
export interface AlertSetInputs {
  /** Recent heartbeat backlog samples per machine id (windowed to `BACKLOG_TREND_WINDOW_MS`). */
  samplesByMachine: Map<string, BacklogSample[]>;
  /** Connector health over `CONNECTOR_RATE_ALERT.windowMs`, distinct from the lifetime rows. */
  windowedConnectors: ConnectorHealthRow[];
}

/**
 * M16 16.7 — the inputs the DEPLOYMENT-scoped derive functions need. Both counts come from tables
 * with no `org_id`, which is precisely why they are here and not in `AlertSetInputs`.
 */
export interface DeploymentAlertInputs {
  /** Signed pricing catalogs awaiting approval — deployment-wide (`countPendingCatalogs`). */
  pendingCatalogs: number;
  /** Ingest auth failures in `AUTH_FAILURE_ALERT.windowMs` — deployment-wide, by design. */
  authFailureCount: number;
}

/**
 * Compose the SEVEN org-scoped alert codes from an already-built snapshot plus the windowed inputs.
 *
 * Pure and clock-free — every time-dependent value is resolved by the caller and passed in, which
 * is what lets both an HTTP request and a timer tick share it. `built.machines` must already carry
 * derived `status` / `backlogHigh` (both `deriveAlerts` and the two per-machine siblings read them
 * and never recompute liveness), and `built.connectors` must be the LIFETIME rows — `deriveAlerts`
 * reads them for `connector.failing`, so passing `[]` silently drops a code.
 *
 * `built.activeSessions` is NOT read by any derive function; a caller with no other use for it may
 * pass `[]` and skip the query. The evaluator does exactly that.
 *
 * M16 16.7: `deriveCatalogAlerts` and `deriveAuthFailureAlerts` are NOT here — they moved to
 * `deriveDeploymentAlertSet`. Adding either back would put a deployment condition into every org's
 * reconcile, which is the defect 16.7 exists to fix.
 */
export function deriveAlertSet(
  built: LiveMonitorSnapshot,
  inputs: AlertSetInputs,
): OperationalAlert[] {
  return sortAlerts([
    ...deriveAlerts(built),
    ...deriveBacklogTrendAlerts(built.machines, inputs.samplesByMachine),
    ...deriveArchiveUnreachableAlerts(built.machines),
    ...deriveConnectorFailureRateAlerts(inputs.windowedConnectors),
  ]);
}

/**
 * M16 16.7 — compose the TWO deployment-scoped alert codes.
 *
 * Takes no snapshot at all, which is the honest signature: neither derivation reads a machine, a
 * connector or a session, because neither condition belongs to a tenant. Reconciled once per tick
 * (and once per throttled route call) under `withDeployment`, producing exactly one row, one ack
 * and one delivery for the whole installation.
 */
export function deriveDeploymentAlertSet(inputs: DeploymentAlertInputs): OperationalAlert[] {
  return sortAlerts([
    ...deriveCatalogAlerts(inputs.pendingCatalogs),
    ...deriveAuthFailureAlerts(inputs.authFailureCount),
  ]);
}

/**
 * True when the set of OPEN firing keys differs from the set of derived alert keys — i.e. an alert
 * has appeared or cleared since the last reconcile. Compared by `alertKey`, the same key the
 * partial unique index uses, so this asks exactly the question the reconcile would answer.
 * Recently-RESOLVED firings are ignored: they linger in the list as confirmation by design and are
 * not evidence of a change.
 *
 * M16 16.6 — moved here from `routes/monitor.ts` (behaviour identical) so the background evaluator
 * can make the SAME throttling decision the route does. That matters more than code reuse: the
 * throttle exists to stop a steady-state write, but skipping a reconcile when the derived set has
 * genuinely CHANGED would leave a newly-derived alert with no firing row — un-ackable and
 * undelivered — on the one path whose whole job is to say something broke. Both callers must
 * therefore apply "throttled, UNLESS the answer would differ", and having two copies of that
 * predicate is exactly the drift `deriveAlertSet` above exists to prevent.
 *
 * M16 16.7 — CALLERS MUST PASS A SCOPE-FILTERED FIRING LIST, and this is the subtle way the slice
 * can silently disable the throttle. `listAlertFirings` now returns an org's rows UNIONED with the
 * deployment's (it must — the dashboard renders that list and nothing else). Feed that union in
 * while deriving only the seven org codes and the key sets differ on every tick forever, so
 * `openFiringsDiverge` returns true forever, so the reconcile runs on every SSE frame — exactly
 * the steady-state write M15 15.4 audit B.4 added the throttle to remove, silently restored.
 * Filter on `f.scope` before comparing: org callers pass `scope === "org"`, the deployment caller
 * passes the deployment list (`listDeploymentFirings` returns only those).
 */
/**
 * M15 15.4 audit B.4 / M16 16.7 — the KEY under which a reconcile's last-run instant is recorded in
 * `app.reconcileLastRunAt`.
 *
 * It lives here for the same reason `deriveAlertSet` and `openFiringsDiverge` do: the route and the
 * background tick share ONE map, and two callers computing the key differently would each keep
 * their own idea of when the last reconcile happened — silently restoring the every-3-s write the
 * throttle exists to remove, and re-opening the concurrent-reconcile deadlock 16.6 documented.
 */
export function reconcileThrottleKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

/**
 * M16 16.7 — the reserved key for the DEPLOYMENT reconcile.
 *
 * A SENTINEL IN THE EXISTING MAP rather than a second map or a bare module-level timestamp, and the
 * choice is deliberate: the throttle window, its semantics ("stamped BEFORE the await so two
 * overlapping callers cannot both see a stale `last`") and its per-process lifetime are all
 * properties of `app.reconcileLastRunAt`, and a second mechanism would have to re-derive every one
 * of them. It cannot collide with a real key: `reconcileThrottleKey` composes two uuids, and `*` is
 * not a uuid character.
 *
 * It is load-bearing on the SSE path. `GET /v1/monitor/stream` reconciles every 3 s per connected
 * client, and the deployment scope is ONE row shared by the whole installation — so without a
 * throttle N connected dashboards would write that single row N times per tick, for a condition
 * that changes at human speed. This is M15 15.4 audit B.4 applied one scope over.
 */
export const DEPLOYMENT_THROTTLE_KEY = "*:deployment";

export function openFiringsDiverge(alerts: OperationalAlert[], firings: AlertFiring[]): boolean {
  const open = new Set(firings.filter((f) => f.status === "open").map((f) => f.alertKey));
  const derived = new Set(alerts.map(alertKey));
  if (open.size !== derived.size) return true;
  for (const key of derived) if (!open.has(key)) return true;
  return false;
}
