import { and, eq, gte, sql } from "drizzle-orm";
import type { ActiveSessionRow, BacklogSample, MachineStatusRow } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { events, machineHeartbeats, machines } from "../schema.js";

/**
 * M9 Live Monitor projections (PRD §8.4, §10.1.1, §20). Read-only, CLOCK-FREE —
 * exactly like `connectorHealth` (projections.ts): the repo never reads the wall
 * clock; the ingest route passes `now`/`sinceIso` and applies `deriveMachineStatus`
 * (D6). Silent library (CLAUDE.md): throws, never logs.
 *
 * Scoping mirrors `connectorHealth`: reached via the `machines` join so
 * UNATTRIBUTED events (no workspace_keys row) still count.
 *
 * M15 15.4 — every read here takes `orgId` as its SECOND parameter (the 15.2 convention) and
 * scopes by ORG, not by user. The `userId` predicate is GONE, and its removal — not merely the
 * addition of `orgId` — is the point.
 *
 * Until this slice these filtered on `userId` alone, which had TWO defects that looked like one:
 * RLS was the only thing between tenants (the inverse of D-M15-3), AND the result was only
 * correct while every org held exactly one user. D-15.4-2 settles the second: org membership is
 * open-by-default, every member sees every machine/session/connector in their org. Keeping
 * `user_id` here would have left a colleague's monitor EMPTY — visible-but-partial, which is a
 * worse failure than the one it replaced because nothing errors.
 *
 * For the JOIN-based reads the org predicate goes on BOTH sides: the FACT table
 * (`events.orgId` / `machineHeartbeats.orgId`) gives isolation, and `machines.orgId` gives
 * OWNERSHIP — without the second, one tenant can get a non-empty rollup of its own rows
 * attributed through another tenant's machine (the 15.2 lesson, verbatim in CLAUDE.md).
 *
 * Timestamp coercion (CLAUDE.md Drizzle gotcha): `machines.*` timestamptz columns
 * are PLAIN `timestamp(..,{withTimezone:true})` (NOT mode:"string"), so the driver
 * returns JS `Date` — normalize to ISO with `.toISOString()`. `events.ts` IS
 * mode:"string" (already ISO) — do NOT re-coerce it.
 */

/** Per-machine status rows for the caller's ORG (clock-free; Date→ISO normalized). */
export async function machineStatuses(db: DbClient, orgId: string): Promise<MachineStatusRow[]> {
  const rows = await db
    .select({
      id: machines.id,
      name: machines.name,
      os: machines.os,
      hostname: machines.hostname,
      lastSeenAt: machines.lastSeenAt,
      lastHeartbeatAt: machines.lastHeartbeatAt,
      queuePending: machines.queuePending,
      queueInflight: machines.queueInflight,
      collectorVersion: machines.collectorVersion,
      consecutiveSyncFailures: machines.consecutiveSyncFailures,
    })
    .from(machines)
    .where(eq(machines.orgId, orgId))
    .orderBy(machines.name);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    os: r.os,
    hostname: r.hostname,
    // Plain timestamptz columns come back as JS Date via the driver — normalize to ISO.
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    lastHeartbeatAt: r.lastHeartbeatAt ? r.lastHeartbeatAt.toISOString() : null,
    queuePending: r.queuePending,
    queueInflight: r.queueInflight,
    collectorVersion: r.collectorVersion,
    // integer column → JS number | null; NO Date coercion (only the timestamptz cols get .toISOString()).
    consecutiveSyncFailures: r.consecutiveSyncFailures,
  }));
}

/**
 * Sessions with activity at or after `sinceIso` (the "active now" window). Clock-free:
 * the route computes `sinceIso = now - ACTIVE_WINDOW` and passes it in. Org-scoped via
 * the `machines` join (mirrors `connectorHealth`). Newest activity first.
 *
 * GOTCHA 1: the `since` filter is a HAVING value-comparison (`max(ts) >= sinceIso`), NOT
 * a GROUP BY / ORDER BY expression, so a bound ISO param cast `::timestamptz` is SAFE
 * (the bound-param-in-GROUP-BY hazard from CLAUDE.md does not apply to value comparisons).
 * GOTCHA 2: inside a raw `sql` aggregate the `events.ts` `mode:"string"` parser does NOT
 * apply (CLAUDE.md), so `min/max(ts)` come back in Postgres text form (`2026-06-14 11:59:00+00`),
 * NOT ISO — normalize to ISO with `toIso()` for a clean wire contract.
 */

/** Normalize a Postgres timestamp string (or already-ISO string) to a strict ISO string. */
const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
export async function activeSessions(
  db: DbClient,
  orgId: string,
  sinceIso: string,
): Promise<ActiveSessionRow[]> {
  const rows = await db
    .select({
      sessionId: events.sessionId,
      sourceConnector: sql<string>`max(${events.sourceConnector})`,
      startedAt: sql<string | null>`min(${events.ts})`,
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      models: sql<
        string[]
      >`coalesce(array_agg(distinct ${events.model}) filter (where ${events.model} is not null), '{}')`,
      projectPath: sql<string | null>`max(${events.projectPath})`,
      gitBranch: sql<string | null>`max(${events.gitBranch})`,
    })
    .from(events)
    .innerJoin(machines, eq(events.machineId, machines.id))
    // Fact table AND join table: `events.orgId` isolates, `machines.orgId` owns.
    .where(and(eq(events.orgId, orgId), eq(machines.orgId, orgId)))
    .groupBy(events.sessionId)
    .having(sql`max(${events.ts}) >= ${sinceIso}::timestamptz`)
    .orderBy(sql`max(${events.ts}) desc`);
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sourceConnector: r.sourceConnector,
    startedAt: toIso(r.startedAt),
    lastEventAt: toIso(r.lastEventAt),
    eventCount: r.eventCount,
    models: r.models ?? [],
    projectPath: r.projectPath ?? null,
    gitBranch: r.gitBranch ?? null,
  }));
}

/**
 * Recent backlog samples per machine for the trend derivative (M10 3c). Clock-free:
 * the route passes `since` (a Date = now - BACKLOG_TREND_WINDOW_MS). Org-scoped
 * via the machines join. `ts` is plain timestamptz → Date → ISO. Sorted asc (by machine
 * then ts) so the pure `deriveBacklogTrend` can read first/last directly.
 */
export async function recentBacklogSamples(
  db: DbClient,
  orgId: string,
  since: Date,
): Promise<Map<string, BacklogSample[]>> {
  const rows = await db
    .select({
      machineId: machineHeartbeats.machineId,
      ts: machineHeartbeats.ts,
      queuePending: machineHeartbeats.queuePending,
    })
    .from(machineHeartbeats)
    .innerJoin(machines, eq(machineHeartbeats.machineId, machines.id))
    .where(
      and(
        // Fact table AND join table — see the file header.
        eq(machineHeartbeats.orgId, orgId),
        eq(machines.orgId, orgId),
        gte(machineHeartbeats.ts, since),
      ),
    )
    .orderBy(machineHeartbeats.machineId, machineHeartbeats.ts);
  const byMachine = new Map<string, BacklogSample[]>();
  for (const r of rows) {
    const list = byMachine.get(r.machineId) ?? [];
    // Plain timestamptz column → JS Date → normalize to ISO (CLAUDE.md Drizzle gotcha).
    list.push({ ts: r.ts.toISOString(), queuePending: r.queuePending });
    byMachine.set(r.machineId, list);
  }
  return byMachine;
}
