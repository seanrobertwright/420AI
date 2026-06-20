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
  firstFiredAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  ackedAt: string | null;
}

/**
 * Stable per-alert identity — the partial-unique reconcile key (D3). A machine alert
 * keys on its machineId, a connector alert on its connector; `*` is the (unreachable in
 * practice) fallback for an alert carrying neither. One OPEN firing per (user, alertKey).
 */
export function alertKey(a: Pick<OperationalAlert, "code" | "machineId" | "connector">): string {
  return `${a.code}:${a.machineId ?? a.connector ?? "*"}`;
}

/**
 * Resolved firings stay visible on the snapshot for this long (so a just-resolved alert
 * lingers briefly as confirmation), then drop from `listAlertFirings`.
 */
export const ALERT_FIRINGS_RESOLVED_WINDOW_MS = 60 * 60_000; // 1 hour
