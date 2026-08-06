import {
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
 * M16 16.6 — THE one place the full alert set is composed.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT A COMMENT SAYING "KEEP THESE IN SYNC".
 *
 * Two callers now derive alerts: `routes/monitor.ts`'s `buildSnapshot` (evaluate-on-read) and
 * `alert-evaluator.ts`'s background tick (evaluate-on-timer). They MUST derive the SAME codes, and
 * that is a correctness requirement rather than tidiness: `reconcileAlertFirings` resolves every
 * open firing whose key is not in the derived set (`alert-firings.ts`, D5). So if one caller ever
 * derives fewer codes than the other, each will close what the other opens — the firing flaps every
 * cycle, and with a deliverer wired the operator gets a resolve notice per tick for an outage that
 * never ended.
 *
 * As duplicated source text that requirement was enforced by NOTHING. Both call sites typecheck
 * independently, so `tsc` cannot see a divergence; no test covered it either. Adding a tenth alert
 * code to one list and forgetting the other would have shipped green. That is the repo's own
 * "a per-FILE grep exempts the file, not the call site" lesson one layer up — and CLAUDE.md is
 * explicit that a comment asserting an invariant IS the defect when nothing enforces it (15.5).
 * Here the invariant is cheap to make structural, so it is structural: there is one list, and a
 * new alert code can only be added to it once.
 *
 * DELIBERATELY NOT a refactor of `buildSnapshot` itself. That function carries the route's
 * throttle bookkeeping, its principal handling and its firing-list read, none of which a tick has;
 * the 16.6 plan is explicit that it stays private to the route. What is shared is the pure
 * composition — no clock, no database, no I/O — which is exactly the part that must not diverge.
 */

/** The non-snapshot inputs the six derive functions need. All pre-windowed by the caller. */
export interface AlertSetInputs {
  /** Recent heartbeat backlog samples per machine id (windowed to `BACKLOG_TREND_WINDOW_MS`). */
  samplesByMachine: Map<string, BacklogSample[]>;
  /** Signed pricing catalogs awaiting approval — GLOBAL (no org). */
  pendingCatalogs: number;
  /** Ingest auth failures in `AUTH_FAILURE_ALERT.windowMs` — GLOBAL (no org), by design. */
  authFailureCount: number;
  /** Connector health over `CONNECTOR_RATE_ALERT.windowMs`, distinct from the lifetime rows. */
  windowedConnectors: ConnectorHealthRow[];
}

/**
 * Compose all nine alert codes from an already-built snapshot plus the windowed inputs.
 *
 * Pure and clock-free — every time-dependent value is resolved by the caller and passed in, which
 * is what lets both an HTTP request and a timer tick share it. `built.machines` must already carry
 * derived `status` / `backlogHigh` (both `deriveAlerts` and the two per-machine siblings read them
 * and never recompute liveness), and `built.connectors` must be the LIFETIME rows — `deriveAlerts`
 * reads them for `connector.failing`, so passing `[]` silently drops a code.
 *
 * `built.activeSessions` is NOT read by any derive function; a caller with no other use for it may
 * pass `[]` and skip the query. The evaluator does exactly that.
 */
export function deriveAlertSet(
  built: LiveMonitorSnapshot,
  inputs: AlertSetInputs,
): OperationalAlert[] {
  return sortAlerts([
    ...deriveAlerts(built),
    ...deriveBacklogTrendAlerts(built.machines, inputs.samplesByMachine),
    ...deriveCatalogAlerts(inputs.pendingCatalogs),
    ...deriveArchiveUnreachableAlerts(built.machines),
    ...deriveAuthFailureAlerts(inputs.authFailureCount),
    ...deriveConnectorFailureRateAlerts(inputs.windowedConnectors),
  ]);
}
