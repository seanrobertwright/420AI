import { and, eq, gte, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  alertKey,
  ALERT_FIRINGS_RESOLVED_WINDOW_MS,
  type AlertCode,
  type AlertFiring,
  type AlertFiringStatus,
  type AlertSeverity,
  type OperationalAlert,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { alertFirings } from "../schema.js";

/**
 * M10 3c persisted Alert-Firing repository (PRD §20). A DIRECT clone of the
 * attribution.ts upsert/status/return mechanism: an `onConflictDoUpdate` against the
 * PARTIAL unique index `(user_id, alert_key) WHERE status='open'` (the `targetWhere`
 * is MANDATORY — a bare target won't match a partial index), then a guarded `update`
 * that resolves the open firings no longer derived, then a re-select → typed-row map.
 *
 * Evaluate-on-read (D1): `reconcileAlertFirings` is called from the ingest
 * `buildSnapshot` path; the route owns the wall clock and passes `now`. Silent library
 * (CLAUDE.md): throws, never logs. Every query is scoped by userId.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** All firing columns (reused by reconcile/list/ack so the row shape stays in one place). */
const firingColumns = {
  id: alertFirings.id,
  alertKey: alertFirings.alertKey,
  code: alertFirings.code,
  severity: alertFirings.severity,
  message: alertFirings.message,
  machineId: alertFirings.machineId,
  machineName: alertFirings.machineName,
  connector: alertFirings.connector,
  since: alertFirings.since,
  status: alertFirings.status,
  firstFiredAt: alertFirings.firstFiredAt,
  lastSeenAt: alertFirings.lastSeenAt,
  resolvedAt: alertFirings.resolvedAt,
  ackedAt: alertFirings.ackedAt,
  // M12 12.6 delivery marker — selected so deliverPendingFirings can filter on it; NOT
  // surfaced on the AlertFiring wire shape (toFiring accepts it in the row, ignores it).
  deliveryAttemptedAt: alertFirings.deliveryAttemptedAt,
};

/** Map a raw firing row (text unions, Date timestamps) onto the typed AlertFiring wire shape. */
function toFiring(r: {
  id: string;
  alertKey: string;
  code: string;
  severity: string;
  message: string;
  machineId: string | null;
  machineName: string | null;
  connector: string | null;
  since: string | null;
  status: string;
  firstFiredAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  ackedAt: Date | null;
  deliveryAttemptedAt: Date | null; // M12 12.6 — selected by firingColumns; not on the wire shape
}): AlertFiring {
  return {
    id: r.id,
    alertKey: r.alertKey,
    code: r.code as AlertCode,
    severity: r.severity as AlertSeverity,
    message: r.message,
    machineId: r.machineId,
    machineName: r.machineName,
    connector: r.connector,
    since: r.since,
    status: r.status as AlertFiringStatus,
    // Plain timestamptz columns come back as JS Date via the driver — normalize to ISO.
    firstFiredAt: r.firstFiredAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    ackedAt: r.ackedAt ? r.ackedAt.toISOString() : null,
  };
}

/** Sort precedence: open&unacked (0) → open&acked (1) → resolved (2). */
function rank(f: AlertFiring): number {
  if (f.status === "resolved") return 2;
  return f.ackedAt ? 1 : 0;
}

/**
 * Evaluate-on-read reconcile (D1/D3/D4/D5). For each derived alert, idempotently upsert
 * ONE open firing per (user, alert_key) — INSERT a fresh open row (stamping
 * first_fired_at) or, when one is already open, DO UPDATE touching only
 * last_seen_at/message/severity/since (first_fired_at is NEVER overwritten, D4). Then
 * resolve every open firing whose key is no longer derived (`notInArray([])` → true
 * resolves all open, D5). Returns the current firing list (open + recently resolved).
 */
export async function reconcileAlertFirings(
  db: DbClient,
  userId: string,
  alerts: OperationalAlert[],
  now: Date,
): Promise<AlertFiring[]> {
  const keys = alerts.map(alertKey);
  for (const a of alerts) {
    await db
      .insert(alertFirings)
      .values({
        userId,
        alertKey: alertKey(a),
        code: a.code,
        severity: a.severity,
        message: a.message,
        machineId: a.machineId ?? null,
        machineName: a.machineName ?? null,
        connector: a.connector ?? null,
        since: a.since,
        status: "open",
        firstFiredAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [alertFirings.userId, alertFirings.alertKey],
        targetWhere: sql`${alertFirings.status} = 'open'`,
        set: { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since },
      });
  }
  // Resolve open firings whose condition is no longer derived (zero alerts → resolve all, D5).
  await db
    .update(alertFirings)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        eq(alertFirings.userId, userId),
        eq(alertFirings.status, "open"),
        notInArray(alertFirings.alertKey, keys),
      ),
    );
  return listAlertFirings(db, userId, now);
}

/**
 * The current firing surface: all OPEN firings plus firings RESOLVED within
 * ALERT_FIRINGS_RESOLVED_WINDOW_MS (a just-resolved alert lingers briefly as
 * confirmation). Ordered open&unacked → open&acked → resolved, then severity, then
 * oldest-first. Scoped by userId.
 */
export async function listAlertFirings(
  db: DbClient,
  userId: string,
  now: Date,
): Promise<AlertFiring[]> {
  const cutoff = new Date(now.getTime() - ALERT_FIRINGS_RESOLVED_WINDOW_MS);
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(
      and(
        eq(alertFirings.userId, userId),
        or(
          eq(alertFirings.status, "open"),
          and(eq(alertFirings.status, "resolved"), gte(alertFirings.resolvedAt, cutoff)),
        ),
      ),
    );
  return rows
    .map(toFiring)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        Date.parse(a.firstFiredAt) - Date.parse(b.firstFiredAt),
    );
}

/**
 * Acknowledge a firing — sets `acked_at` (it stops drawing the eye) but does NOT
 * resolve it; resolution happens only when the condition clears. Mirrors
 * attribution.ts `setLinkStatus` (update by (id,userId) → re-select → map). Scoped by
 * userId; returns undefined for an unknown / other-user id.
 */
export async function ackAlertFiring(
  db: DbClient,
  userId: string,
  id: string,
  now: Date,
): Promise<AlertFiring | undefined> {
  const [updated] = await db
    .update(alertFirings)
    .set({ ackedAt: now })
    .where(and(eq(alertFirings.id, id), eq(alertFirings.userId, userId)))
    .returning({ id: alertFirings.id });
  if (!updated) return undefined;
  const [row] = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(eq(alertFirings.id, id))
    .limit(1);
  return row ? toFiring(row) : undefined;
}

/**
 * M12 12.6 alert delivery (PRD §20). Deliver any OPEN firing not yet attempted, then stamp
 * `delivery_attempted_at` (on success OR failure → at-most-ONE attempt; the firing row itself
 * stays the durable record — no 3 s retry spam to a dead webhook). Best-effort: a per-firing
 * `deliver()` throw is caught + handed to `log`, NEVER propagated, so the evaluate-on-read
 * snapshot path can't 500. Early-returns (no query) when no deliverer is wired — the default
 * no-webhook case stays cheap on the 3 s SSE tick. `now` is route-owned (CLAUDE.md). The
 * deliverer is an INLINE structural type so @420ai/db gains no dep on @420ai/shared/apps-ingest.
 */
export async function deliverPendingFirings(
  db: DbClient,
  userId: string,
  deliverer: { deliver(firing: AlertFiring): Promise<void> } | null,
  now: Date,
  log?: (err: unknown) => void,
): Promise<void> {
  if (!deliverer) return; // delivery disabled — no query
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(
      and(
        eq(alertFirings.userId, userId),
        eq(alertFirings.status, "open"),
        isNull(alertFirings.deliveryAttemptedAt),
      ),
    );
  for (const r of rows) {
    const firing = toFiring(r);
    try {
      await deliverer.deliver(firing);
    } catch (err) {
      log?.(err);
    }
    // Stamp regardless of outcome — at-most-once attempt, no 3-second retry spam.
    await db
      .update(alertFirings)
      .set({ deliveryAttemptedAt: now })
      .where(eq(alertFirings.id, r.id));
  }
}
