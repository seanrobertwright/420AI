import type { AlertCode, AlertSeverity, OperationalAlert } from "./alerts.js";

/**
 * M10 3c persisted Alert Firings (PRD §20, glossary "Alert Firing" in docs/CONTEXT.md).
 *
 * The M10 op-alerts slice is STATELESS — `deriveAlerts` re-derives a ranked list on
 * every read with no memory of WHEN a condition started. This module is the wire type
 * for the persisted firing record that closes that gap: a firing remembers its
 * `firstFiredAt` (the thing the stateless version lacked), advances `lastSeenAt` while
 * the condition holds, `resolvedAt` when it clears, and `ackedAt` when a human silences
 * it. Reconciliation is evaluate-on-read in the ingest `buildSnapshot` path (D1) — no
 * background dispatcher, no new long-lived resource.
 *
 * Pure + dependency-free + clock-free (the `@420ai/shared` invariant): only the
 * `AlertCode`/`AlertSeverity`/`OperationalAlert` types are imported; `alertKey` is pure.
 * The wall clock + persistence live in the db/ingest layers.
 */

/** A firing is OPEN while its condition holds; RESOLVED once the key is no longer derived. */
export type AlertFiringStatus = "open" | "resolved";

/**
 * M16 16.7 — WHOSE condition this firing is.
 *
 * `"org"` — a tenant's condition (a machine of theirs is offline, a connector of theirs is
 * failing). One row per `(org, alertKey)`, visible only to that org.
 *
 * `"deployment"` — a condition of the INSTALLATION, not of any tenant:
 * `catalog.update_requires_approval` and `ingest.auth_failure` derive from tables that carry no
 * `org_id` at all. Exactly ONE row exists per key across the whole deployment, every org sees it,
 * and one ack and one delivery serve everyone. Universal visibility is the honest model here —
 * a pricing catalog changes everyone's costs, and ingest auth failures affect the whole archive —
 * and it is what makes a single shared ack coherent.
 *
 * This field is LOAD-BEARING rather than cosmetic. `listAlertFirings` returns both scopes (or the
 * dashboard, which renders `alertFirings` and nothing else, would stop showing the two global
 * codes entirely). But `openFiringsDiverge` compares OPEN firing keys against DERIVED alert keys,
 * so a caller deriving only its own scope's codes must filter the firing list to that same scope
 * before comparing — otherwise it reports divergence on every tick forever and defeats the
 * reconcile throttle. `scope` is what a caller partitions on.
 */
export type AlertFiringScope = "org" | "deployment";

/**
 * One persisted Operational-Alert firing. `firstFiredAt`/`lastSeenAt`/`resolvedAt`/
 * `ackedAt` are ISO strings (normalized from timestamptz by the repo). `since` is the
 * opaque evidence-time display label carried verbatim from the derived alert (text —
 * never compared temporally).
 */
export interface AlertFiring {
  id: string;
  alertKey: string;
  code: AlertCode;
  severity: AlertSeverity;
  message: string;
  machineId: string | null;
  machineName: string | null;
  connector: string | null;
  since: string | null;
  status: AlertFiringStatus;
  /** M16 16.7 — org-scoped or deployment-scoped; see `AlertFiringScope`. */
  scope: AlertFiringScope;
  firstFiredAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  ackedAt: string | null;
}

/**
 * Stable per-alert identity — the partial-unique reconcile key (D3). A machine alert
 * keys on its machineId, a connector alert on its connector; `*` is the (unreachable in
 * practice) fallback for an alert carrying neither.
 *
 * M16 16.7: one OPEN firing per `(org, alertKey)` — or per `alertKey` ALONE in the deployment
 * scope, where there is no org to key on. It was `(user, alertKey)` until 16.7, which made N
 * members of one org open N rows for one condition.
 *
 * The `${code}:${…}` SHAPE is depended on outside TypeScript: migration 0027 recovers the code
 * with `split_part(alert_key, ':', 1)`, which is only valid because no `AlertCode` contains a
 * colon. `alert-firings.test.ts` pins that over the whole union so a future code cannot break the
 * migration silently.
 */
export function alertKey(a: Pick<OperationalAlert, "code" | "machineId" | "connector">): string {
  return `${a.code}:${a.machineId ?? a.connector ?? "*"}`;
}

/**
 * Resolved firings stay visible on the snapshot for this long (so a just-resolved alert
 * lingers briefly as confirmation), then drop from `listAlertFirings`.
 */
export const ALERT_FIRINGS_RESOLVED_WINDOW_MS = 60 * 60_000; // 1 hour
