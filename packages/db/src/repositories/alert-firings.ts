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
import type { Db, DbClient, Tx } from "../client.js";
import { withOrg, withDeployment } from "../org-context.js";
import { alertFirings } from "../schema.js";

/**
 * M10 3c persisted Alert-Firing repository (PRD §20). A DIRECT clone of the
 * attribution.ts upsert/status/return mechanism: an `onConflictDoUpdate` against a
 * PARTIAL unique index (the `targetWhere` is MANDATORY — a bare target won't match a
 * partial index), then a guarded `update` that resolves the open firings no longer
 * derived, then a re-select → typed-row map.
 *
 * Evaluate-on-read (D1): `reconcileAlertFirings` is called from the ingest
 * `buildSnapshot` path; the route owns the wall clock and passes `now`. Silent library
 * (CLAUDE.md): throws, never logs.
 *
 * ---
 *
 * M16 16.7 — TWO SCOPES, AND THEY ARE DISJOINT BY CONSTRUCTION.
 *
 * Firings were keyed `(user_id, alert_key)` until this slice, which answered "who is looking at
 * this?" when the question is "what is broken?". Every operation here is now parameterized by a
 * `FiringScope`:
 *
 *   - `{ kind: "org", orgId }` — arbiter `alert_firings_open_key` on `(org_id, alert_key)`,
 *     predicate `org_id = orgId`. Seven of the nine alert codes.
 *   - `{ kind: "deployment" }` — arbiter `alert_firings_open_global_key` on `alert_key` alone,
 *     predicate `org_id IS NULL`. The two codes that derive from tables with no `org_id`
 *     (`catalog.update_requires_approval`, `ingest.auth_failure`).
 *
 * WHY DISJOINTNESS MATTERS MORE THAN IT LOOKS. `reconcileFirings` resolves every open firing whose
 * key is absent from the derived set, so two callers deriving different code sets would make every
 * firing in the difference FLAP — one closing what the other opens, with a resolve notice per cycle
 * for an outage that never ended. That is prevented here STRUCTURALLY rather than by agreement:
 * the org resolve filters `eq(orgId, …)`, which never matches a NULL row, and the deployment
 * resolve filters `isNull(orgId)`, which never matches an org row. Neither scope can resolve the
 * other's firings, whatever either caller derives.
 *
 * DO NOT MERGE THE TWO UPSERTS into one statement with a computed arbiter. Postgres suppresses
 * conflicts only on the INFERRED arbiter index, so using the org arbiter against a global row does
 * not silently insert a duplicate — it RAISES `duplicate key value violates unique constraint
 * "alert_firings_open_global_key"`. Measured, and a feature: the split is enforced by the database,
 * loudly. It stays that way only while the two remain separate statements.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * M16 16.7 — which scope an operation acts in. See the module doc.
 *
 * A discriminated union rather than a nullable `orgId?: string`, deliberately: `undefined` and
 * "the deployment" are not the same statement, and a caller that forgot to thread an org id would
 * silently become a deployment-wide write under the nullable spelling. Here it cannot compile.
 */
export type FiringScope = { kind: "org"; orgId: string } | { kind: "deployment" };

/** All firing columns (reused by reconcile/list/ack so the row shape stays in one place). */
const firingColumns = {
  id: alertFirings.id,
  // M16 16.7 — selected so `toFiring` can DERIVE `scope`; NOT surfaced on the wire itself (the
  // caller gets `scope: "org" | "deployment"`, never a raw org id belonging to nobody). Same
  // precedent as `deliveryAttemptedAt` below: selected, documented, not on the wire shape.
  // Explicit column lists rather than a bare `select()` are the M15 15.1 rule — no ingest route
  // declares a Fastify response schema, so a bare select puts every future column on the wire.
  orgId: alertFirings.orgId,
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
  orgId: string | null; // M16 16.7 — selected by firingColumns; becomes `scope`, never the wire id
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
    // M16 16.7: the scope IS the nullability of `org_id` — a NULL org means the row belongs to the
    // deployment. Derived here rather than stored, so the wire value cannot disagree with the row.
    scope: r.orgId === null ? "deployment" : "org",
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
 * The rows an operation in `scope` MAY act on — the predicate that makes the two scopes disjoint.
 *
 * `eq(orgId, …)` never matches a NULL row and `isNull(orgId)` never matches an org row, so an org
 * reconcile cannot resolve a deployment firing and vice versa. That is the whole non-flapping
 * argument, and it holds whatever either caller derives (module doc, D-16.7-3).
 */
function scopePredicate(scope: FiringScope) {
  return scope.kind === "org" ? eq(alertFirings.orgId, scope.orgId) : isNull(alertFirings.orgId);
}

/**
 * Open the RLS context matching `scope` around one statement — `withOrg` for a tenant, its 16.7
 * sibling `withDeployment` for the deployment (which sets the ROLE and deliberately leaves
 * `app.current_org` unset; an unset org context IS the deployment scope).
 *
 * Used only by the two deliverers, which are the only functions here that take the UNWRAPPED `Db`
 * and own their context internally. Everything else receives an already-scoped `DbClient` from a
 * caller that opened one transaction for a whole snapshot.
 */
function inScope<T>(
  db: Db,
  scope: FiringScope,
  role: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return scope.kind === "org" ? withOrg(db, scope.orgId, role, fn) : withDeployment(db, role, fn);
}

/**
 * Evaluate-on-read reconcile (D1/D3/D4/D5), in ONE scope. For each derived alert, idempotently
 * upsert ONE open firing — INSERT a fresh open row (stamping first_fired_at) or, when one is
 * already open, DO UPDATE touching only last_seen_at/message/severity/since (first_fired_at is
 * NEVER overwritten, D4). Then resolve every open firing IN THIS SCOPE whose key is no longer
 * derived (`notInArray([])` → true resolves all open in scope, D5).
 *
 * The two `onConflictDoUpdate` blocks below name DIFFERENT indexes and must stay separate
 * statements — see the module doc for what happens when the arbiters are crossed.
 *
 * `userId` is written on INSERT only and is PROVENANCE (D-16.7-2): the upsert's `set:` omits it,
 * so a second caller updating an existing row leaves the OPENER's id in place. "Who first saw
 * this" is the only question the column can now honestly answer.
 */
async function reconcileFirings(
  db: DbClient,
  scope: FiringScope,
  userId: string,
  alerts: OperationalAlert[],
  now: Date,
): Promise<void> {
  const keys = alerts.map(alertKey);
  for (const a of alerts) {
    const values = {
      orgId: scope.kind === "org" ? scope.orgId : null,
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
    };
    // M15 15.1: `orgId` is absent from BOTH `set:` blocks for the same reason as in ingest.ts —
    // an existing open firing keeps the scope it was opened under. `userId` is absent for the
    // 16.7 reason above.
    const set = { lastSeenAt: now, message: a.message, severity: a.severity, since: a.since };
    if (scope.kind === "org") {
      await db
        .insert(alertFirings)
        .values(values)
        .onConflictDoUpdate({
          // arbiter: alert_firings_open_key
          target: [alertFirings.orgId, alertFirings.alertKey],
          targetWhere: sql`${alertFirings.status} = 'open' AND ${alertFirings.orgId} IS NOT NULL`,
          set,
        });
    } else {
      await db
        .insert(alertFirings)
        .values(values)
        .onConflictDoUpdate({
          // arbiter: alert_firings_open_global_key — a DIFFERENT index, one column
          target: [alertFirings.alertKey],
          targetWhere: sql`${alertFirings.status} = 'open' AND ${alertFirings.orgId} IS NULL`,
          set,
        });
    }
  }
  // Resolve open firings whose condition is no longer derived (zero alerts → resolve all IN
  // SCOPE, D5). `scopePredicate` is what stops that "resolve all" from reaching the other scope.
  await db
    .update(alertFirings)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        scopePredicate(scope),
        eq(alertFirings.status, "open"),
        notInArray(alertFirings.alertKey, keys),
      ),
    );
}

/**
 * Reconcile ONE ORG's alerts, then return the org's full firing surface (which INCLUDES the
 * deployment-scoped rows — see `listAlertFirings`).
 *
 * M16 16.7: the signature is unchanged from 15.4, but `userId` no longer scopes anything. Two
 * members of one org reconciling the same condition now converge on ONE row, one ack and one
 * delivery, where before they opened one row each.
 */
export async function reconcileAlertFirings(
  db: DbClient,
  orgId: string,
  userId: string,
  alerts: OperationalAlert[],
  now: Date,
): Promise<AlertFiring[]> {
  await reconcileFirings(db, { kind: "org", orgId }, userId, alerts, now);
  return listAlertFirings(db, orgId, now);
}

/**
 * M16 16.7 — reconcile the DEPLOYMENT's alerts (the two codes with no owning tenant), then return
 * the deployment-scoped firing list.
 *
 * Must run under `withDeployment` (or the owner handle in a test): an org context can SEE these
 * rows but the write is the deployment's, not any tenant's. Passing `[]` resolves every open
 * deployment firing and leaves every org row untouched — that asymmetry is the point.
 */
export async function reconcileDeploymentFirings(
  db: DbClient,
  userId: string,
  alerts: OperationalAlert[],
  now: Date,
): Promise<AlertFiring[]> {
  await reconcileFirings(db, { kind: "deployment" }, userId, alerts, now);
  return listDeploymentFirings(db, now);
}

/** The open + recently-resolved window every list read shares. */
function visibleWindow(now: Date) {
  const cutoff = new Date(now.getTime() - ALERT_FIRINGS_RESOLVED_WINDOW_MS);
  return or(
    eq(alertFirings.status, "open"),
    and(eq(alertFirings.status, "resolved"), gte(alertFirings.resolvedAt, cutoff)),
  );
}

/**
 * The current firing surface for an ORG: all OPEN firings plus firings RESOLVED within
 * ALERT_FIRINGS_RESOLVED_WINDOW_MS (a just-resolved alert lingers briefly as
 * confirmation). Ordered open&unacked → open&acked → resolved, then severity, then
 * oldest-first.
 *
 * M16 16.7 — `userId` is GONE from the signature (it scoped the read until 15.4 and merely
 * narrowed it after; either way two members of one org saw different lists for the same
 * conditions), and the predicate is WIDENED to include the deployment rows.
 *
 * Including them is not a convenience. The dashboard renders `snapshot.alertFirings` and nothing
 * else, so a list that omitted `org_id IS NULL` rows would stop showing the two global codes
 * entirely. The caller that must be careful is the RECONCILE-throttle check: comparing this union
 * against a single scope's derived alerts reports divergence forever — partition on
 * `firing.scope` first.
 */
export async function listAlertFirings(
  db: DbClient,
  orgId: string,
  now: Date,
): Promise<AlertFiring[]> {
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(and(or(eq(alertFirings.orgId, orgId), isNull(alertFirings.orgId)), visibleWindow(now)));
  return sortFirings(rows);
}

/**
 * M16 16.7 — the DEPLOYMENT-scoped firing list alone (`org_id IS NULL`). This is the list the
 * deployment reconcile compares against for divergence; `listAlertFirings` is the one the
 * dashboard renders, and it deliberately unions both scopes.
 */
export async function listDeploymentFirings(db: DbClient, now: Date): Promise<AlertFiring[]> {
  const rows = await db
    .select(firingColumns)
    .from(alertFirings)
    .where(and(isNull(alertFirings.orgId), visibleWindow(now)));
  return sortFirings(rows);
}

/** Shared row-map + ordering for both list reads. */
function sortFirings(rows: Parameters<typeof toFiring>[0][]): AlertFiring[] {
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
 * attribution.ts `setLinkStatus` (update by id + scope → re-select → map).
 *
 * M16 16.7 — the `userId` PARAMETER IS GONE, and its absence is the honest spelling.
 *
 * An org's condition is now ONE row, so any member may ack it and every other member sees it
 * acked — the behaviour the per-user key made impossible, and the reason `userId` can no longer
 * appear in the `where`. A DEPLOYMENT firing (`org_id IS NULL`) is ackable from any org,
 * deliberately: one row, one ack, one notice, universally visible. The alternative (a deployment
 * admin who alone sees it) has no schema support, since roles are org-scoped.
 *
 * The 16.7 plan called for keeping the parameter "only to stamp who acked". There is nowhere to
 * stamp it: `alert_firings` has an `acked_at` but no `acked_by_user_id`, and `user_id` is the
 * OPENER's id (D-16.7-2 provenance) which an ack must not overwrite. A parameter that is accepted
 * and then ignored is the 15.5 defect in miniature — a signature asserting a behaviour the body
 * does not have — so it is dropped rather than carried.
 *
 * WORTH KNOWING, because this slice is what loses it: before 16.7 the acker was necessarily the
 * row's `user_id`, so "who silenced this?" was answerable by accident. With a shared row it is
 * not, and answering it again needs a column and a migration nobody has written. Recorded here
 * rather than papered over with an unused argument.
 *
 * A miss still returns undefined, which the route turns into 404 (never 403 — no existence leak).
 */
export async function ackAlertFiring(
  db: DbClient,
  orgId: string,
  id: string,
  now: Date,
): Promise<AlertFiring | undefined> {
  const [updated] = await db
    .update(alertFirings)
    .set({ ackedAt: now })
    .where(
      and(eq(alertFirings.id, id), or(eq(alertFirings.orgId, orgId), isNull(alertFirings.orgId))),
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
 *
 * M16 16.7 — takes a `FiringScope` instead of a bare `orgId`, and the `userId` predicate is GONE.
 * Dropping it is the delivery half of the fix: one condition was previously N rows across N
 * members, hence N claims and N notices. It is now one row, and 16.6's atomic claim
 * (`UPDATE … WHERE delivery_attempted_at IS NULL … RETURNING`) already guarantees exactly one
 * caller can win it — so collapsing the rows collapses the notices with no new dedupe machinery.
 * The deployment scope runs under `withDeployment` (no org context at all) and claims the
 * `org_id IS NULL` rows; see `withDeployment` for why an unset context IS that scope.
 */
export async function deliverPendingFirings(
  db: Db,
  scope: FiringScope,
  role: string,
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
  const rows = await inScope(db, scope, role, (tx) =>
    tx
      .update(alertFirings)
      .set({ deliveryAttemptedAt: now })
      .where(
        and(
          scopePredicate(scope),
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
 *
 * M16 16.7: same `FiringScope` conversion and same dropped `userId` predicate as
 * `deliverPendingFirings` — a resolve notice duplicated across N members exactly as an open one
 * did, and `resolve_delivered_at` is its `delivery_attempted_at`.
 */
export async function deliverResolvedFirings(
  db: Db,
  scope: FiringScope,
  role: string,
  deliverer: { deliver(firing: AlertFiring): Promise<void> } | null,
  now: Date,
  log?: (err: unknown) => void,
): Promise<void> {
  if (!deliverer) return; // delivery disabled — no query
  // M16 16.6 — the same atomic claim as `deliverPendingFirings`, for the same reason and against
  // the same second caller. See that function's note; a resolve notice duplicates just as readily
  // as an open one, and `resolve_delivered_at` is its `delivery_attempted_at`.
  const rows = await inScope(db, scope, role, (tx) =>
    tx
      .update(alertFirings)
      .set({ resolveDeliveredAt: now })
      .where(
        and(
          scopePredicate(scope),
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
