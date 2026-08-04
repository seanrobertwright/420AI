import { and, eq, notInArray, sql } from "drizzle-orm";
import type {
  DeclaredConnectorRow,
  MachineConnectorReport,
  ObservedConnectorRow,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { events, machineConnectors, machines } from "../schema.js";

/**
 * M16 16.3 — the DECLARED × OBSERVED join behind the capture health scorecard (§7 P0.1).
 *
 * Read-only aggregation plus one replace-in-place write. Silent library (CLAUDE.md): throws typed
 * errors, never logs. `orgId` is always the SECOND parameter (D-15.2-4) so a transposed argument
 * between two adjacent `string` params is visible in review. NO `withOrg` here — the route wraps it.
 *
 * NO `org_id` APPEARS ON ANY RETURNED ROW (15.1): no ingest route declares a Fastify `response`
 * schema, so a bare `select()` would put every future column on the wire. The explicit column
 * constants below mirror the exported row interfaces in `@420ai/shared`.
 *
 * TWO DIFFERENT TIMESTAMP MECHANISMS SIT TEN LINES APART IN THIS FILE, and conflating them is the
 * M5 `lastActivity` / M9 `activeSessions` bug class (CLAUDE.md "Drizzle / SQL gotchas"):
 *
 *   - `max(events.ts)` is an AGGREGATE over a `mode:"string"` column. The column's parser does NOT
 *     apply inside a raw `sql` template, so it comes back as Postgres TEXT
 *     (`2026-08-01 00:00:00+00`) and MUST go through `toIso`. Measured, not assumed (spike S2).
 *   - `machineConnectors.reportedAt` / `.lastErrorAt` are PLAIN timestamptz columns selected
 *     directly, so the driver returns a JS `Date` and the fix is `.toISOString()`, exactly as
 *     `machineStatuses` (repositories/monitor.ts:61) does.
 */

/** Postgres timestamp text → strict ISO. For AGGREGATES only — see the header. */
const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

/** Explicit column list — keeps `DeclaredConnectorRow` honest and keeps `org_id` off the wire. */
const declaredColumns = {
  machineId: machineConnectors.machineId,
  connectorId: machineConnectors.connectorId,
  enabled: machineConnectors.enabled,
  approval: machineConnectors.approval,
  status: machineConnectors.status,
  captureMethod: machineConnectors.captureMethod,
  liveness: machineConnectors.liveness,
  tokens: machineConnectors.tokens,
  cost: machineConnectors.cost,
  knownGaps: machineConnectors.knownGaps,
  requiredPermissions: machineConnectors.requiredPermissions,
  custom: machineConnectors.custom,
  lastErrorMessage: machineConnectors.lastErrorMessage,
  lastErrorAt: machineConnectors.lastErrorAt,
  errorCount: machineConnectors.errorCount,
  reportedAt: machineConnectors.reportedAt,
} as const;

/**
 * Replace one machine's declared connector inventory: upsert every report, then prune whatever the
 * collector stopped reporting.
 *
 * THE CONFLICT TARGET IS THE UNIQUE INDEX `(machine_id, connector_id)`, not the `id` primary key —
 * `id` is a fresh `gen_random_uuid()` on every call and would never conflict, silently turning this
 * into an append and leaving the panel showing every historical report.
 *
 * `errorCount` / `lastError*` are OVERWRITTEN from the report and never accumulated server-side
 * (D-16.3-7): the collector holds them in `queue.sqlite` and is their single source of truth. Two
 * counters would diverge and the operator would not know which to believe.
 *
 * The caller decides whether to call this at all: `undefined` connectors on a heartbeat means "this
 * collector does not report" (pre-16.3) and must leave existing rows alone, whereas an EMPTY array
 * means "this collector reports zero connectors" and prunes everything. That distinction lives at
 * the route; here, an empty `reports` prunes.
 */
export async function replaceMachineConnectors(
  db: DbClient,
  orgId: string,
  machineId: string,
  reports: MachineConnectorReport[],
  now: Date,
): Promise<void> {
  if (reports.length > 0) {
    await db
      .insert(machineConnectors)
      .values(
        reports.map((r) => ({
          orgId,
          machineId,
          connectorId: r.id,
          enabled: r.enabled,
          approval: r.approval,
          status: r.status,
          captureMethod: r.captureMethod,
          liveness: r.liveness,
          tokens: r.tokens,
          cost: r.cost,
          knownGaps: r.knownGaps,
          requiredPermissions: r.requiredPermissions,
          custom: r.custom ?? false,
          lastErrorMessage: r.lastErrorMessage,
          lastErrorAt: r.lastErrorAt ? new Date(r.lastErrorAt) : null,
          errorCount: r.errorCount,
          reportedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [machineConnectors.machineId, machineConnectors.connectorId],
        set: {
          // `org_id` is deliberately ABSENT, mirroring the ingest upsert (CLAUDE.md): a row's owner
          // is fixed by the machine that reported it and a converging write must never flip it.
          enabled: sql`excluded.enabled`,
          approval: sql`excluded.approval`,
          status: sql`excluded.status`,
          captureMethod: sql`excluded.capture_method`,
          liveness: sql`excluded.liveness`,
          tokens: sql`excluded.tokens`,
          cost: sql`excluded.cost`,
          knownGaps: sql`excluded.known_gaps`,
          requiredPermissions: sql`excluded.required_permissions`,
          custom: sql`excluded.custom`,
          lastErrorMessage: sql`excluded.last_error_message`,
          lastErrorAt: sql`excluded.last_error_at`,
          errorCount: sql`excluded.error_count`,
          reportedAt: sql`excluded.reported_at`,
        },
      });
  }

  // PRUNE — machine-scoped, so machine B's rows survive machine A's replace. Drizzle emits invalid
  // SQL for `not in ()`, so an empty report branches to a plain delete rather than being guarded
  // by a `length > 0` check that would make "reports zero connectors" a silent no-op.
  const ids = reports.map((r) => r.id);
  await db
    .delete(machineConnectors)
    .where(
      ids.length > 0
        ? and(
            eq(machineConnectors.machineId, machineId),
            notInArray(machineConnectors.connectorId, ids),
          )
        : eq(machineConnectors.machineId, machineId),
    );
}

/**
 * Every DECLARED (machine, connector) pair with whatever was OBSERVED for it — the row that does
 * not exist today (spike S3: `connectorHealth` returns nothing at all for a declared-but-silent
 * connector, which is why "broken" and "idle" are currently indistinguishable).
 *
 * THE JOIN IS ON `machine_id`, AND THAT IS WHAT MAKES IT CORRECT. `machine_id` is a uuid whose org
 * is fixed by `machines.org_id` (D-M15-1), so two tenants cannot share one and a declared row can
 * only ever meet its own machine's events. The `events.orgId` predicate on the join is
 * defence-in-depth and RLS alignment — it is NOT the mechanism preventing a cross-tenant merge, and
 * saying otherwise would be the 15.5 failure of a comment naming the wrong mechanism. (Spike S5
 * measured the alternative: joining on `connector_id` alone gave org A a count of org B's events.)
 */
export async function declaredConnectorHealth(
  db: DbClient,
  orgId: string,
): Promise<DeclaredConnectorRow[]> {
  const rows = await db
    .select({
      ...declaredColumns,
      // AGGREGATES over `events.ts`, which is `mode:"string"` — Postgres text, NOT ISO. See header.
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      parserVersions: sql<
        string[]
      >`coalesce(array_agg(distinct ${events.parserVersion}) filter (where ${events.parserVersion} is not null), '{}')`,
    })
    .from(machineConnectors)
    .leftJoin(
      events,
      and(
        eq(events.machineId, machineConnectors.machineId),
        eq(events.sourceConnector, machineConnectors.connectorId),
        eq(events.orgId, machineConnectors.orgId),
      ),
    )
    .where(eq(machineConnectors.orgId, orgId))
    .groupBy(
      machineConnectors.machineId,
      machineConnectors.connectorId,
      machineConnectors.enabled,
      machineConnectors.approval,
      machineConnectors.status,
      machineConnectors.captureMethod,
      machineConnectors.liveness,
      machineConnectors.tokens,
      machineConnectors.cost,
      machineConnectors.knownGaps,
      machineConnectors.requiredPermissions,
      machineConnectors.custom,
      machineConnectors.lastErrorMessage,
      machineConnectors.lastErrorAt,
      machineConnectors.errorCount,
      machineConnectors.reportedAt,
    )
    .orderBy(machineConnectors.machineId, machineConnectors.connectorId);

  return rows.map((r) => ({
    machineId: r.machineId,
    connectorId: r.connectorId,
    enabled: r.enabled,
    approval: r.approval,
    status: r.status,
    captureMethod: r.captureMethod,
    liveness: r.liveness,
    tokens: r.tokens,
    cost: r.cost,
    knownGaps: r.knownGaps ?? [],
    requiredPermissions: r.requiredPermissions ?? [],
    custom: r.custom,
    lastErrorMessage: r.lastErrorMessage,
    // PLAIN timestamptz → JS Date. A DIFFERENT mechanism to the aggregate below.
    lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null,
    errorCount: r.errorCount,
    reportedAt: r.reportedAt.toISOString(),
    // MANDATORY, not optional and not already ISO — the `mode:"string"` aggregate rule.
    lastEventAt: toIso(r.lastEventAt),
    eventCount: r.eventCount,
    parserVersions: r.parserVersions ?? [],
  }));
}

/**
 * Every OBSERVED (machine, connector) pair in the org, declared or not.
 *
 * The SET DIFFERENCE against the declared keys — which yields the `unreported` state — is done by
 * the pure `deriveCaptureHealth`, deliberately: it moves a judgement out of SQL and into a
 * unit-tested function, and `unreported` is exactly the kind of "we cannot tell" claim that must be
 * testable without a database (M16 Risk 2).
 *
 * Org-scoped on BOTH sides of the join, as `connectorHealth` is: `events.orgId` isolates,
 * `machines.orgId` establishes ownership (the 15.2 lesson).
 */
export async function observedConnectorAggregates(
  db: DbClient,
  orgId: string,
): Promise<ObservedConnectorRow[]> {
  const rows = await db
    .select({
      // `machines.id`, NOT `events.machineId`: the latter is a NULLABLE column (an event can be
      // stored without a machine), and the inner join already guarantees a machine here. Selecting
      // the join side keeps the type honest instead of forcing a non-null assertion.
      machineId: machines.id,
      connectorId: events.sourceConnector,
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      parserVersions: sql<
        string[]
      >`coalesce(array_agg(distinct ${events.parserVersion}) filter (where ${events.parserVersion} is not null), '{}')`,
    })
    .from(events)
    .innerJoin(machines, eq(events.machineId, machines.id))
    .where(and(eq(events.orgId, orgId), eq(machines.orgId, orgId)))
    .groupBy(machines.id, events.sourceConnector)
    .orderBy(machines.id, events.sourceConnector);

  return rows.map((r) => ({
    machineId: r.machineId,
    connectorId: r.connectorId,
    lastEventAt: toIso(r.lastEventAt),
    eventCount: r.eventCount,
    parserVersions: r.parserVersions ?? [],
  }));
}
