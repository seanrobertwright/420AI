import { and, eq, gte, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  alertKey,
  ALERT_FIRINGS_RESOLVED_WINDOW_MS,
  type AlertCode,
  type AlertFiring,
  type AlertFiringStatus,
  type AlertSeverity,
  type OperationalAlert,
} from "@420ai/shared";
import type { Db, DbClient } from "../client.js";
import { withOrg } from "../org-context.js";
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
  orgId: string,
  userId: string,
  alerts: OperationalAlert[],
  now: Date,
): Promise<AlertFiring[]> {
  const keys = alerts.map(alertKey);
  if (alerts.length > 0) {
    for (const a of alerts) {
      await db
        .insert(alertFirings)
        .values({
          orgId,
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
          // M15 15.1: `orgId` is absent here for the same reason as in ingest.ts —
          // an existing open firing keeps the org it was opened under.
          set: { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since },
        });
    }
  }
  // Resolve open firings whose condition is no longer derived (zero alerts → resolve all, D5).
  await db
    .update(alertFirings)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        // M15 15.4: org AND user. The `orgId` predicate closes the 15.2 backlog — with two
        // users in one org `userId` alone is no longer a proxy for the tenant, and RLS was
        // the only thing scoping this UPDATE (D-M15-3 says that must be the other way round).
        eq(alertFirings.orgId, orgId),
        eq(alertFirings.userId, userId),
        eq(alertFirings.status, "open"),
        notInArray(alertFirings.alertKey, keys),
      ),
    );
  return listAlertFirings(db, orgId, userId, now);
}

/**
 * The current firing surface: all OPEN firings plus firings RESOLVED within
 * ALERT_FIRINGS_RESOLVED_WINDOW_MS (a just-resolved alert lingers briefly as
 * confirmation). Ordered open&unacked → open&acked → resolved, then severity, then
 * oldest-first.
 *
 * M15 15.4 — scoped by org AND user (`orgId` second, the 15.2 convention). It was `userId`-only,
 * which was correct only while every org held exactly one user — the property this slice ends.
 */
export async function listAlertFirings(
  db: DbClient,
  orgId: string,
  userId: string,
  now: Date,
): Promise<AlertFiring[]> {
  const cutoff = new Date(now.getTime() - ALERT_FIRINGS_RESOLVED_WINDOW_MS);
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(
      and(
        eq(alertFirings.orgId, orgId),
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
  orgId: string,
  userId: string,
  id: string,
  now: Date,
): Promise<AlertFiring | undefined> {
  const [updated] = await db
    .update(alertFirings)
    .set({ ackedAt: now })
    // M15 15.2: org AND user, matching setLinkStatus / listReportArtifacts. A miss returns
    // undefined, which the route already turns into 404 (never 403 — no existence leak).
    .where(
      and(eq(alertFirings.id, id), eq(alertFirings.orgId, orgId), eq(alertFirings.userId, userId)),
    )
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
 *
 * M15 15.3 — takes `Db` + `orgId` and owns its RLS context INTERNALLY, in short transactions
 * around each statement, with `deliver()` running BETWEEN them and no transaction open.
 *
 * Both halves of that shape are load-bearing:
 *
 *   - It MUST be scoped. `alert_firings` carries a STRICT policy, so called with no org
 *     context this reads ZERO rows as the app role — silently, since RLS filters rather than
 *     errors and the deliverer's own try/catch would swallow an error anyway. The route
 *     originally called this on the unwrapped `app.db` handle and outbound alert delivery was
 *     simply dead in production while every owner-connected test stayed green.
 *   - It must NOT be one long transaction. `deliver()` is a webhook/SMTP round-trip to a third
 *     party; holding a pooled connection across it — on a path that runs every SSE tick — is
 *     how connection pools die. Hence `withOrg` per statement rather than one around the loop.
 *
 * The explicit `org_id` predicate is kept on every statement alongside the policy (D-M15-3:
 * RLS backstops application scoping, it does not replace it).
 *
 * M15 15.4 — `role` is threaded from the caller, never hardcoded here, and the route passes
 * `SERVICE_ROLE` rather than `principal.role`. Delivery is triggered by whoever happens to load
 * the monitor, but the ACTION belongs to the org. Passing a viewer's role would make the 0016
 * restrictive UPDATE policy reject the `delivery_attempted_at` stamp, so an org whose only
 * active user is a viewer would silently stop delivering every webhook and email — the exact
 * bug class the paragraph above records.
 */
export async function deliverPendingFirings(
  db: Db,
  orgId: string,
  role: string,
  userId: string,
  deliverer: { deliver(firing: AlertFiring): Promise<void> } | null,
  now: Date,
  log?: (err: unknown) => void,
): Promise<void> {
  if (!deliverer) return; // delivery disabled — no query
  // M16 16.6 — CLAIM ATOMICALLY, then deliver. This was `SELECT … WHERE delivery_attempted_at IS
  // NULL` → `await deliver()` → `UPDATE … SET delivery_attempted_at`, i.e. a read-then-write with a
  // THIRD-PARTY NETWORK ROUND TRIP inside the window and no lock, no claim and no conditional
  // update. Two callers could therefore select the same row and both deliver it.
  //
  // That was survivable while the only second caller was another browser tab. 16.6 makes an
  // unattended second caller permanent: the evaluator ticks for `(org, OWNER)` — and D-16.6-2
  // deliberately picks the owner, i.e. the one user most likely to also have the dashboard open —
  // while `routes/monitor.ts` calls `deliverFirings` on EVERY request and EVERY SSE frame,
  // UNTHROTTLED (unlike the reconcile, which `shouldReconcile` gates). At a 3 s stream cadence the
  // overlap is not exotic: tick selects a firing and awaits a ~200 ms webhook; 50 ms later the SSE
  // frame selects the same still-unstamped row and posts it again. Two identical pages for one
  // outage.
  //
  // `UPDATE … WHERE delivery_attempted_at IS NULL … RETURNING` makes the claim and the stamp one
  // statement, so exactly one caller can win a row — the same trick `attribution.ts` uses, and the
  // mechanism named rather than "it's in a transaction" (CLAUDE.md 15.5). The at-most-once contract
  // is unchanged and if anything strengthened: the stamp now lands BEFORE the attempt, so a crash
  // mid-delivery costs one notice rather than duplicating it. It is also fewer round trips — the
  // per-firing UPDATE loop is gone.
  const rows = await withOrg(db, orgId, role, (tx) =>
    tx
      .update(alertFirings)
      .set({ deliveryAttemptedAt: now })
      .where(
        and(
          eq(alertFirings.orgId, orgId),
          eq(alertFirings.userId, userId),
          eq(alertFirings.status, "open"),
          isNull(alertFirings.deliveryAttemptedAt),
        ),
      )
      .returning(firingColumns),
  );
  for (const r of rows) {
    try {
      await deliverer.deliver(toFiring(r));
    } catch (err) {
      log?.(err);
    }
  }
}

/**
 * M13 13.5 deliver-on-resolve (PRD §20). Send a resolve NOTICE for any firing that has
 * resolved but whose resolution hasn't yet been delivered — and ONLY for firings whose OPEN
 * state was itself delivered (`delivery_attempted_at IS NOT NULL`): a firing that opened and
 * closed between two snapshot ticks (never delivered open) must not emit a lone "resolved"
 * with no preceding "firing". Stamps `resolve_delivered_at` on success OR failure (at-most-once,
 * mirroring deliverPendingFirings). The firing row carries `status:"resolved"`, so the deliverer
 * derives an `alert.resolved` envelope. Best-effort: a per-firing throw is caught + logged,
 * never propagated. Early-returns (no query) when no deliverer is wired. `now` is route-owned.
 *
 * M15 15.3: same `Db` + `orgId` + per-statement `withOrg` shape as `deliverPendingFirings` —
 * see that function's note for why the scoping is mandatory and why it is NOT one long
 * transaction around the deliverer call.
 *
 * M15 15.4: `role` is threaded from the caller (`SERVICE_ROLE` at the route) for the same
 * reason as `deliverPendingFirings` — see its note.
 */
export async function deliverResolvedFirings(
  db: Db,
  orgId: string,
  role: string,
  userId: string,
  deliverer: { deliver(firing: AlertFiring): Promise<void> } | null,
  now: Date,
  log?: (err: unknown) => void,
): Promise<void> {
  if (!deliverer) return; // delivery disabled — no query
  // M16 16.6 — the same atomic claim as `deliverPendingFirings`, for the same reason and against
  // the same second caller. See that function's note; a resolve notice duplicates just as readily
  // as an open one, and `resolve_delivered_at` is its `delivery_attempted_at`.
  const rows = await withOrg(db, orgId, role, (tx) =>
    tx
      .update(alertFirings)
      .set({ resolveDeliveredAt: now })
      .where(
        and(
          eq(alertFirings.orgId, orgId),
          eq(alertFirings.userId, userId),
          eq(alertFirings.status, "resolved"),
          isNotNull(alertFirings.resolvedAt),
          isNotNull(alertFirings.deliveryAttemptedAt),
          isNull(alertFirings.resolveDeliveredAt),
        ),
      )
      .returning(firingColumns),
  );
  for (const r of rows) {
    try {
      await deliverer.deliver(toFiring(r));
    } catch (err) {
      log?.(err);
    }
  }
}
