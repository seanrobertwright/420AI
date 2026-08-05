import { and, eq, gte, or, sql } from "drizzle-orm";
import type {
  GitLinkageRow,
  IngestLagRow,
  RawRecordTotals,
  DuplicateTotals,
  ReconciliationSampleRow,
  SessionQualityRow,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import {
  events,
  rawSourceRecords,
  searchDocuments,
  sessionGitLinks,
  workspaceKeys,
  workspaces,
} from "../schema.js";
import { toIso } from "./sql-coerce.js";

/**
 * M16 16.4 — the windowed aggregate reads behind the data-quality audit (research plan §5.1).
 *
 * Read-only. Silent library (CLAUDE.md): throws typed errors, never logs. `orgId` is always the
 * SECOND parameter (D-15.2-4) so a transposed argument between two adjacent `string` params is
 * visible in review. NO `withOrg` here — the orchestrator wraps it.
 *
 * NO `org_id` APPEARS ON ANY RETURNED ROW (15.1): no ingest route declares a Fastify `response`
 * schema, so a bare `select()` would put every future column on the wire.
 *
 * TWO TIMESTAMP MECHANISMS LIVE IN THIS FILE, ten lines apart, and conflating them is the M5
 * `lastActivity` / M9 `activeSessions` bug class (CLAUDE.md "Drizzle / SQL gotchas"):
 *
 *   - `min(events.ts)` / `max(events.ts)` are AGGREGATES over a `mode:"string"` column. The
 *     column's parser does NOT apply inside a raw `sql` template, so the value comes back as
 *     Postgres TEXT (`2026-08-02 09:00:00+00`) and MUST go through `toIso`. Measured during
 *     planning (spike S4), not assumed.
 *   - `rawSourceRecords.ingestedAt` is a PLAIN timestamptz (no `mode`), so the driver `Date`
 *     reaches us untouched and `.toISOString()` is the fix. `toIso` is NOT what you want there,
 *     and the window bound compared against it is a `Date`, not an ISO string.
 *
 * `events.ts` being `mode:"string"` is also why the window bound for EVENTS is an ISO string
 * compared directly (`gte(events.ts, sinceIso)`) — the `connectorHealthWindowed` idiom
 * (projections.ts:401), with no Date coercion anywhere.
 *
 * EVERY COUNT IS `::int`. node-postgres returns a bare `numeric`/`bigint` aggregate as a STRING,
 * so an un-cast `count(*)` silently arrives as `"4"` and every ratio built on it is NaN or string
 * concatenation.
 */

/**
 * Per (session, connector) quality facts inside the window.
 *
 * GROUPED BY (session_id, source_connector), NEVER `session_id` ALONE. `session_id` is a
 * connector-supplied, globally-scoped string (15.1/15.2); grouping on it alone merges a collision
 * between two connectors AND forces an aggregate over `source_connector`, which is the 15.1
 * `min(org_id)` smell one column over.
 *
 * THE ATTRIBUTION SUBQUERY CARRIES `org_id` ON BOTH SIDES OF ITS JOIN, and CLAUDE.md records why in
 * a sentence that cost a slice to learn: "the org predicate on the FACT table gives isolation, not
 * ownership." `events.org_id` stops org A seeing org B's events; without `workspace_keys.org_id`
 * AND `workspaces.org_id` too, org B gets a rollup of its OWN events attributed to a project it
 * does not own — which for THIS metric would report attribution coverage against another tenant's
 * mapping table.
 *
 * `bool_or(...)` over the group, not a join: a join to `workspace_keys` would multiply the event
 * rows by the number of matching keys and inflate every count in the same select.
 */
export async function sessionQualityRows(
  db: DbClient,
  orgId: string,
  sinceIso: string,
): Promise<SessionQualityRow[]> {
  const rows = await db
    .select({
      sessionId: events.sessionId,
      sourceConnector: events.sourceConnector,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      // §5.1's "usable model + token data" — BOTH, not either. A token count with no model cannot
      // be priced and cannot be compared across models, so it is not usable data.
      withTokens: sql<number>`count(*) filter (where ${events.tokens} is not null and ${events.model} is not null)::int`,
      // `boolean | null` — `bool_or` over an empty group is NULL. It cannot actually be empty here
      // (the group exists because a row produced it), but the sibling read at `reconciliationSample`
      // types the identical expression the same way, and one expression typed two different ways in
      // one file is how a reader learns to distrust both. Coalesced at the boundary below.
      attributed: sql<boolean | null>`bool_or(exists (
        select 1
        from ${workspaceKeys} wk
        join ${workspaces} w on w.id = wk.workspace_id
        where wk.org_id = ${orgId}
          and w.org_id = ${orgId}
          and wk.project_key = ${events.projectPath}
      ))`,
      // NO `min(ts)`/`max(ts)` HERE. They were computed, `toIso`-normalized and typed, and read by
      // nothing: `deriveDataQualityMetrics` consumes only the counts and `attributed`, and these
      // rows never reach the stored `metrics`. (The same-named fields on `ReconciliationSampleRow`
      // ARE live — that row IS stored — which is exactly why the absence is worth a note here.)
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), gte(events.ts, sinceIso)))
    .groupBy(events.sessionId, events.sourceConnector)
    .orderBy(events.sessionId, events.sourceConnector);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    sourceConnector: r.sourceConnector,
    eventCount: r.eventCount,
    withTokens: r.withTokens,
    // A null `project_path` makes the EXISTS false rather than null, so this only collapses the
    // empty-group NULL the type admits.
    attributed: r.attributed === true,
  }));
}

/**
 * Parse success: raw records ingested in the window, and how many yielded at least one event.
 *
 * THE DENOMINATOR IS RAW ROWS AND THE PREDICATE IS `exists`, NOT A JOIN — and that is a measured
 * decision, not a stylistic one. Spike S1 reproduced the trap: the same `source_record_id` held by
 * TWO machines produces two raw rows that each join to the SAME events, so a join-based `count(*)`
 * double-counts the denominator and the ratio drifts silently downward as machines are added.
 *
 * `events.raw_record_id` is the CONNECTOR's record id — the same namespace as
 * `raw_source_records.source_record_id` (spike S1 confirmed the match; `reparse.ts:235-240` already
 * treats them as one namespace). It is NOT the raw row's uuid.
 *
 * The window bound is a `Date`: `ingested_at` is a PLAIN timestamptz, a different mechanism from
 * `events.ts` above.
 */
export async function rawRecordTotals(
  db: DbClient,
  orgId: string,
  since: Date,
): Promise<RawRecordTotals> {
  const rows = await db.execute<{ raw_rows: number; yielded_events: number }>(sql`
    select
      count(*)::int as raw_rows,
      count(*) filter (where exists (
        select 1 from ${events} e
        where e.org_id = r.org_id
          and e.source_connector = r.source_connector
          and e.raw_record_id = r.source_record_id
      ))::int as yielded_events
    from ${rawSourceRecords} r
    where r.org_id = ${orgId} and r.ingested_at >= ${since}
  `);
  const row = rows.rows[0];
  return { rawRows: row?.raw_rows ?? 0, yieldedEvents: row?.yielded_events ?? 0 };
}

/**
 * Duplicate rate, measured at the ONLY layer where duplicates still exist (D-16.4-3).
 *
 * IT CANNOT BE MEASURED ON `events`: that table upserts by fingerprint, so every duplicate has
 * ALREADY collapsed before any query runs and a count there is a structural zero — a metric that
 * reports success because it is blind.
 *
 * It IS exactly measurable one layer down. `raw_source_records` dedups per-MACHINE
 * (`ON CONFLICT (machine_id, source_connector, source_record_id) DO NOTHING`), so two machines
 * shipping the same record leave TWO VISIBLE ROWS. And because
 * `fingerprint = sha256(source_connector | raw_record_id | event_index | event_type)`
 * (fingerprint.ts), those two rows provably produced IDENTICAL fingerprints. So the excess copies,
 * times that record's event yield, IS the collapsed-duplicate event count — exact, not a proxy.
 * (Spike S3 measured it on a seeded fixture: `raw_rows=4, distinct_raw=3, duplicate_events=2,
 * stored_events=3`.)
 *
 * THE GROUPING KEY OMITS `session_id` ON PURPOSE, matching the fingerprint's ACTUAL inputs —
 * `session_id` is not one of them. Adding it would under-count a real collision between two
 * sessions that share a record id, which is precisely the case worth catching.
 */
export async function duplicateRawRecords(
  db: DbClient,
  orgId: string,
  since: Date,
): Promise<DuplicateTotals> {
  const rows = await db.execute<{ duplicate_events: number; distinct_events: number }>(sql`
    with dup as (
      select r.source_connector, r.source_record_id, count(*)::int as copies
      from ${rawSourceRecords} r
      where r.org_id = ${orgId} and r.ingested_at >= ${since}
      group by r.source_connector, r.source_record_id
    ),
    ev as (
      select e.source_connector, e.raw_record_id, count(*)::int as n
      from ${events} e
      where e.org_id = ${orgId}
      group by e.source_connector, e.raw_record_id
    )
    select
      coalesce(sum((d.copies - 1) * coalesce(e.n, 0)), 0)::int as duplicate_events,
      coalesce(sum(coalesce(e.n, 0)), 0)::int                  as distinct_events
    from dup d
    left join ev e
      on e.source_connector = d.source_connector
     and e.raw_record_id = d.source_record_id
  `);
  const row = rows.rows[0];
  return {
    duplicateEvents: row?.duplicate_events ?? 0,
    distinctEvents: row?.distinct_events ?? 0,
  };
}

/**
 * Sync freshness input: per (session, connector), how long after the session's last event its last
 * raw record landed in the archive.
 *
 * BOTH TIMESTAMP MECHANISMS MEET HERE, which is why the lag is computed in SQL rather than in TS
 * from two normalized strings: `max(e.ts)` is a `mode:"string"` aggregate (Postgres text) and
 * `max(r.ingested_at)` is a plain timestamptz. Subtracting them in Postgres, where both are real
 * `timestamptz` values, avoids parsing either representation by hand. The result is milliseconds,
 * and it is NULL when the raw side is missing — an UNMEASURABLE lag, never a zero one.
 *
 * THE JOIN IS A PLAIN `LEFT JOIN` DRIVEN BY THE EVENTS SIDE, and the asymmetry is worth naming
 * because it is NOT symmetric: `ev` determines the row set, and the aggregate is taken
 * independently on each side (raw is keyed per-machine while events converge, so both are grouped
 * to (session_id, source_connector) first).
 *
 *   - events but no in-window raw record → one row, `lagMs: null`, reported as unmeasurable.
 *   - raw but no in-window events        → NO ROW AT ALL. That gap is parse success's subject,
 *                                          not freshness's, so it is deliberately not counted here.
 */
export async function ingestLagRows(
  db: DbClient,
  orgId: string,
  sinceIso: string,
  since: Date,
): Promise<IngestLagRow[]> {
  const rows = await db.execute<{
    session_id: string;
    source_connector: string;
    /**
     * A `bigint`, and node-postgres hands a bare `bigint` back as a STRING — hence `Number(...)`
     * below. It is deliberately NOT cast to `::int` like every count in this file: the lag is a
     * DIFFERENCE between two clocks, so a back-dated event (or a connector whose timestamps
     * predate the archive by months) overflows `int4` and Postgres raises `22003 integer out of
     * range` — a 500 on the whole audit. Measured, not hypothesised: it took down the app-role
     * behavioural test in `rls.int.test.ts`, whose fixtures are seeded a year before `now`.
     */
    lag_ms: string | null;
  }>(sql`
    with ev as (
      select e.session_id, e.source_connector, max(e.ts) as last_event_at
      from ${events} e
      where e.org_id = ${orgId} and e.ts >= ${sinceIso}
      group by e.session_id, e.source_connector
    ),
    raw as (
      select r.session_id, r.source_connector, max(r.ingested_at) as last_ingested_at
      from ${rawSourceRecords} r
      where r.org_id = ${orgId} and r.ingested_at >= ${since}
      group by r.session_id, r.source_connector
    )
    select
      ev.session_id,
      ev.source_connector,
      case
        when raw.last_ingested_at is null then null
        else (extract(epoch from (raw.last_ingested_at - ev.last_event_at)) * 1000)::bigint
      end as lag_ms
    from ev
    left join raw
      on raw.session_id = ev.session_id
     and raw.source_connector = ev.source_connector
    order by ev.session_id, ev.source_connector
  `);
  return rows.rows.map((r) => ({
    sessionId: r.session_id,
    sourceConnector: r.source_connector,
    // A raw record that landed BEFORE its last event (clock skew, or an event timestamp the
    // connector back-dated) is clamped to 0 rather than reported as a negative lag: "arrived
    // early" is not a freshness failure, and a negative number on the row would read as a bug.
    lagMs: r.lag_ms === null ? null : Math.max(0, Number(r.lag_ms)),
  }));
}

/*
 * THERE IS DELIBERATELY NO `connectorDeclarations` READ HERE.
 *
 * The token/liveness declarations this module's pure layer needs are already carried by 16.3's
 * `declaredConnectorHealth` (capture-health.ts), whose `DeclaredConnectorRow` is a strict superset
 * of the three fields `summarizeDeclarations` reads — and the orchestrator calls that read anyway,
 * in the same transaction, for the capture-health roll-up. A second read of `machine_connectors`
 * would be a redundant round-trip AND a second place for the two to disagree, which is D-16.4-2's
 * argument applied to an input rather than a verdict. The orchestrator projects the three fields
 * from `declared` instead; see `generate-report-audit.ts`.
 */

/**
 * Distinct (session, git-link status) pairs for sessions with activity in the window.
 *
 * THE BUCKETING IS NOT DONE HERE. Returning raw pairs and deciding in TS is what makes the two
 * judgements that matter unit-testable with no database: a session holding BOTH a confirmed and a
 * suggested link counts once as confirmed, and a session holding only REJECTED links counts as no
 * linkage. Both are §7 P1.7 claims about what the evidence supports, and a `case` expression buried
 * in SQL is the wrong place for a claim of that kind.
 *
 * `session_git_links` has no timestamp tying it to the event window, so the window is applied via
 * the `events` side — a link is included only when its session has events inside the window.
 */
export async function gitLinkageRows(
  db: DbClient,
  orgId: string,
  sinceIso: string,
): Promise<GitLinkageRow[]> {
  const rows = await db
    .selectDistinct({
      sessionId: sessionGitLinks.sessionId,
      status: sessionGitLinks.status,
    })
    .from(sessionGitLinks)
    .where(
      and(
        eq(sessionGitLinks.orgId, orgId),
        // `session_id` is a connector-supplied globally-scoped string, so the EXISTS carries its
        // own org predicate rather than relying on the outer one (15.2).
        sql`exists (
          select 1 from ${events} e
          where e.org_id = ${orgId}
            and e.session_id = ${sessionGitLinks.sessionId}
            and e.ts >= ${sinceIso}
        )`,
      ),
    )
    .orderBy(sessionGitLinks.sessionId, sessionGitLinks.status);
  return rows.map((r) => ({ sessionId: r.sessionId, status: r.status }));
}

/**
 * The §4.4 reconciliation sample: N sessions selected DETERMINISTICALLY (D-16.4-5).
 *
 * `ORDER BY md5(session_id)` is the selector, and the two rejected alternatives are the argument
 * for it:
 *
 *   - RANDOM makes the artifact unreproducible. A versioned report whose sample cannot be
 *     re-derived defeats the point of §23 replay metadata — a hand-count four weeks later would be
 *     auditing different sessions than the report did.
 *   - MOST RECENT N biases every sample toward the newest capture configuration, which is the one
 *     least likely to be broken. The metric would systematically miss the regressions it exists to
 *     find.
 *
 * `md5(...)` is a plain function call over a column, NOT a closed-set keyword, so it needs no
 * `sql.raw` and adding one would be wrong (CLAUDE.md's `date_trunc` rule does not apply here).
 *
 * The four archive-answerable §4.4 checks are pre-filled; checks 1 (a tool-native session exists)
 * and 4 (attribution is CORRECT) have no archive answer at all and are left to the human.
 */
export async function reconciliationSample(
  db: DbClient,
  orgId: string,
  sinceIso: string,
  limit: number,
): Promise<ReconciliationSampleRow[]> {
  const rows = await db.execute<{
    session_id: string;
    source_connector: string;
    machine_id: string | null;
    raw_record_count: number;
    event_count: number;
    events_with_tokens: number;
    models: string[] | null;
    cost_confidences: string[] | null;
    indexed: boolean;
    project_paths: string[] | null;
    attributed: boolean | null;
    first_ts: string | null;
    last_ts: string | null;
  }>(sql`
    select
      e.session_id,
      e.source_connector,
      -- INDICATIVE, and nothing depends on it. An aggregate over a grouping that does not include
      -- machine_id picks whichever uuid sorts first as text, so a session captured by two machines
      -- reports one of them arbitrarily. That is the shape CLAUDE.md flags as a smell, and it is
      -- deliberately tolerated HERE and nowhere else: machine_id is not a tenancy key (org_id is,
      -- and it is in the WHERE clause), this column is display-only on the worksheet, and the dry
      -- run does NOT read it -- recoverabilityTargets re-derives the full machine set from
      -- raw_source_records independently, precisely so no re-parse subject can be lost to this
      -- aggregate. Treat it as "one of the machines that captured this", never as "the machine".
      min(e.machine_id::text) as machine_id,
      (select count(*)::int from ${rawSourceRecords} r
        where r.org_id = ${orgId}
          and r.session_id = e.session_id
          and r.source_connector = e.source_connector) as raw_record_count,
      count(e.fingerprint)::int as event_count,
      count(*) filter (where e.tokens is not null and e.model is not null)::int as events_with_tokens,
      coalesce(array_agg(distinct e.model) filter (where e.model is not null), '{}') as models,
      -- The filter guards the EXTRACTED value, not e.cost. Guarding "e.cost is not null" lets a
      -- cost object written by an older shape (no confidence key) contribute a NULL ELEMENT to
      -- the array, which the declared type says cannot happen and which the renderer's join(", ")
      -- then prints as an unlabelled blank in the §4.4 check-5 cell — the one cell whose job is to
      -- say the cost figure carries a label.
      coalesce(array_agg(distinct e.cost ->> 'confidence')
        filter (where e.cost ->> 'confidence' is not null), '{}') as cost_confidences,
      exists (
        select 1 from ${searchDocuments} sd
        where sd.org_id = ${orgId}
          and sd.entity_type = 'session'
          and sd.entity_id = e.session_id
      ) as indexed,
      -- ALL distinct paths, not min(...). project_path is not in the GROUP BY, so an aggregate
      -- would display one arbitrary path while attributed below is a bool_or over all of them —
      -- the worksheet cell and its verdict could contradict each other, and §4.4 check 4 is a human
      -- judging "is this the RIGHT project" against exactly that cell.
      coalesce(array_agg(distinct e.project_path)
        filter (where e.project_path is not null), '{}') as project_paths,
      bool_or(exists (
        select 1 from ${workspaceKeys} wk
        join ${workspaces} w on w.id = wk.workspace_id
        where wk.org_id = ${orgId} and w.org_id = ${orgId} and wk.project_key = e.project_path
      )) as attributed,
      min(e.ts) as first_ts,
      max(e.ts) as last_ts
    from ${events} e
    where e.org_id = ${orgId} and e.ts >= ${sinceIso}
    group by e.session_id, e.source_connector
    order by md5(e.session_id), e.source_connector
    limit ${limit}
  `);

  return rows.rows.map((r) => ({
    sessionId: r.session_id,
    sourceConnector: r.source_connector,
    machineId: r.machine_id,
    rawRecordCount: r.raw_record_count,
    eventCount: r.event_count,
    eventsWithTokens: r.events_with_tokens,
    models: r.models ?? [],
    // `cost ->> 'confidence'` is free text out of jsonb; the shared type is a closed union, so this
    // is the one place the two meet. A row written by an older cost shape yields a string outside
    // the union rather than throwing — it is rendered verbatim on the worksheet, which is the
    // honest treatment (§5.1: record what is there, do not substitute).
    costConfidences: (r.cost_confidences ?? []) as ReconciliationSampleRow["costConfidences"],
    indexed: r.indexed === true,
    projectPaths: r.project_paths ?? [],
    attributed: r.attributed === true,
    // MANDATORY — `mode:"string"` aggregates are Postgres text, not ISO.
    firstTs: toIso(r.first_ts),
    lastTs: toIso(r.last_ts),
  }));
}

/**
 * The (session, connector, machine) tuples the recoverability dry run should attempt, drawn from
 * the SAME deterministic sample so the two sections of the report describe the same sessions.
 *
 * Keyed off `raw_source_records` rather than `events`, because the dry run reads raw records and
 * raw is PER-MACHINE — a session captured by two machines has two independent re-parse subjects,
 * and collapsing them would silently test only one.
 *
 * IT TAKES (session, connector) PAIRS, NOT BARE SESSION IDS, and the reason is a bound rather than
 * a tidiness preference. Filtering on `session_id` alone would pull in every connector that ever
 * captured that session — including connectors the deterministic sample did not select — so the
 * report's recoverability row would describe a different set of subjects than its worksheet lists,
 * while the function's own header claimed they were the same. It would also make the real decrypt
 * fan-out `sampleSize × connectors × machines`, silently widening the ceiling `schemas.ts` states.
 *
 * The per-MACHINE expansion is the one multiplier that remains, and it is deliberate (raw is
 * per-machine; see above). So the honest bound is `sampleSize × machines-per-session`, which is what
 * `schemas.ts` now says.
 */
export async function recoverabilityTargets(
  db: DbClient,
  orgId: string,
  sampled: { sessionId: string; sourceConnector: string }[],
): Promise<{ sessionId: string; sourceConnector: string; machineId: string }[]> {
  if (sampled.length === 0) return [];
  // An OR of (session, connector) equality pairs rather than `inArray` on either column alone: the
  // pair is the unit, and two separate `inArray`s would form a CROSS PRODUCT that re-admits exactly
  // the unsampled (session, connector) combinations this signature exists to exclude.
  //
  // Bound parameters, never interpolation: inside a raw `sql` template drizzle binds a JS array as
  // ONE scalar parameter, which Postgres rejects with `22P02 malformed array literal` (measured — it
  // reached the driver as the bare string `s1`). The query builder expands each pair into its own
  // bound params, which is also what keeps the param count honest and bounded by `sampleSize`.
  const pairPredicate = or(
    ...sampled.map((s) =>
      and(
        eq(rawSourceRecords.sessionId, s.sessionId),
        eq(rawSourceRecords.sourceConnector, s.sourceConnector),
      ),
    ),
  );
  const rows = await db
    .selectDistinct({
      sessionId: rawSourceRecords.sessionId,
      sourceConnector: rawSourceRecords.sourceConnector,
      machineId: rawSourceRecords.machineId,
    })
    .from(rawSourceRecords)
    .where(and(eq(rawSourceRecords.orgId, orgId), pairPredicate))
    .orderBy(
      rawSourceRecords.sessionId,
      rawSourceRecords.sourceConnector,
      rawSourceRecords.machineId,
    );
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sourceConnector: r.sourceConnector,
    machineId: r.machineId,
  }));
}
