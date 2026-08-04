import { and, eq, sql } from "drizzle-orm";
import type { LabelQueueRow } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { events, machines, outcomeLabels } from "../schema.js";

/**
 * M16 16.2 — the LABEL QUEUE: settled, in-window sessions that carry no label row yet
 * (research plan §4.3, D-16.2-1). This is `activeSessions` (monitor.ts:86) with two changes —
 * a `leftJoin` onto `outcome_labels` and an INVERTED window — and it is deliberately a sibling
 * of that query rather than a generalisation of it, because the two answer opposite questions.
 *
 * WHY THE QUEUE IS A SERVER READ AND NOT CLIENT-SIDE FILTERING (D-16.2-1). The alternative was for
 * the desktop panel to pull sessions and labels separately and diff them. The client has no bounded
 * way to enumerate "my sessions" (`sessionProjections` is project-scoped; `activeSessions` is the
 * wrong window), and — decisively — "do not nag repeatedly" would then be a CLIENT behaviour that a
 * reinstall resets. Here it is a predicate over durable rows.
 *
 * §4.3's "DO NOT NAG REPEATEDLY" IS `count(labels.id) = 0`, NOT A FEATURE. D-16.1-2 made a skip a
 * ROW, so a skipped session is excluded by exactly the same predicate that excludes a judged one.
 * There is no "already asked" bookkeeping anywhere in this slice because the schema already carries
 * it. Measured in planning (spikes S3/S4): both a `labeled` and a `skipped` row removed the session
 * from the queue.
 *
 * ── THE JOIN-SIDE `orgId` PREDICATE IS LOAD-BEARING. READ THIS BEFORE TOUCHING THE JOIN. ──
 * `eq(outcomeLabels.orgId, orgId)` sits inside the `leftJoin`'s `and(...)`, not in the `where`, and
 * moving it is a silent cross-tenant bug rather than a style question. `session_id` is a
 * CONNECTOR-SUPPLIED, GLOBALLY-SCOPED string (schema.ts:1201) — two tenants can hold the same
 * value — so a join written on `sessionId` ALONE lets org B's label suppress org A's queue row.
 *
 * This was REPRODUCED as a negative control, both in planning (spike S5) and again during execution
 * by deleting the predicate and re-running the suite: exactly one test failed, the cross-org one in
 * `label-queue.int.test.ts`. It runs on the OWNER handle so it measures the PREDICATE and not the
 * RLS backstop. Its failure mode is silence — the operator's session simply never appears in the
 * queue, so it never gets labelled, so 16.4's denominator is quietly wrong.
 *
 * Note also that a `where`-clause predicate would NOT be equivalent: on a LEFT JOIN, a `where` on
 * the nullable side turns the join into an inner one and drops every unlabeled session — the exact
 * rows this query exists to return. Right guard, wrong clause, opposite bug.
 *
 * WHY `count(outcomeLabels.id)` IS NOT THE 15.1 AGGREGATE-OVER-AN-OWNERSHIP-COLUMN SMELL. CLAUDE.md
 * flags aggregates over tenancy columns (`min(org_id)` in 15.1's `indexSessions`, which merged two
 * orgs' content into one document). `outcomeLabels.id` is a row identity, not an ownership key, and
 * both sides of this join are already confined to a single org — so the aggregate cannot pick a
 * winner between tenants. Stated here so the next reader does not have to re-derive it.
 *
 * TIMESTAMPS ARE NOT ISO UNTIL `toIso` RUNS. Inside a raw `sql` aggregate the `events.ts`
 * `mode:"string"` parser does not apply (CLAUDE.md "Drizzle / SQL gotchas"), so `min/max(ts)` come
 * back as Postgres text. Measured (spike S2): `max(ts)` was `"2026-08-01 00:00:00+00"` and
 * `raw === new Date(raw).toISOString()` was `false`. This is the bug class that shipped as M5
 * `lastActivity` and recurred in M9 `activeSessions`; the `toIso` calls below are not optional.
 *
 * CLOCK-FREE, like every projection in this package: the ROUTE computes `settledBeforeIso` and
 * `sinceIso` from `ACTIVE_WINDOW_MS` / `LABEL_QUEUE_LOOKBACK_MS` and passes them in. `orgId` is the
 * SECOND parameter (the 15.2 convention). Silent library — throws, never logs. The caller wraps
 * this in `withOrg`; do NOT call `withOrg` in here.
 */

/** Normalize a Postgres timestamp string (or already-ISO string) to a strict ISO string. */
const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

export async function labelQueue(
  db: DbClient,
  orgId: string,
  opts: { settledBeforeIso: string; sinceIso: string; limit?: number },
): Promise<LabelQueueRow[]> {
  const query = db
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
    // ── THE `orgId` PREDICATE ON THIS JOIN IS LOAD-BEARING — see the header. ──
    .leftJoin(
      outcomeLabels,
      and(eq(outcomeLabels.sessionId, events.sessionId), eq(outcomeLabels.orgId, orgId)),
    )
    // Fact table AND join table: `events.orgId` isolates, `machines.orgId` owns (the 15.2 rule).
    .where(and(eq(events.orgId, orgId), eq(machines.orgId, orgId)))
    .groupBy(events.sessionId)
    // All three are VALUE COMPARISONS inside HAVING, not GROUP BY / ORDER BY expressions, so a
    // bound param cast `::timestamptz` is safe here — the CLAUDE.md bound-param hazard applies to
    // grouping expressions only, and the identical construction is shipped at monitor.ts:109.
    .having(
      sql`max(${events.ts}) < ${opts.settledBeforeIso}::timestamptz
          and max(${events.ts}) >= ${opts.sinceIso}::timestamptz
          and count(${outcomeLabels.id}) = 0`,
    )
    .orderBy(sql`max(${events.ts}) desc`)
    .$dynamic();
  if (opts.limit !== undefined) query.limit(opts.limit);
  const rows = await query;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sourceConnector: r.sourceConnector,
    // ── MANDATORY. Postgres text, not ISO (spike S2). Not optional, not already ISO. ──
    startedAt: toIso(r.startedAt),
    lastEventAt: toIso(r.lastEventAt),
    eventCount: r.eventCount,
    models: r.models ?? [],
    projectPath: r.projectPath ?? null,
    gitBranch: r.gitBranch ?? null,
  }));
}
