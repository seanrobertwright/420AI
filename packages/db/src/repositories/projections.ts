import { and, eq, inArray, sql } from "drizzle-orm";
import {
  lowestConfidence,
  zeroTokens,
  type ConnectorHealthRow,
  type CostConfidence,
  type NormalizedTokens,
  type ProjectGitMetadata,
  type SessionDetail,
  type SessionProjection,
  type UsageByModelRow,
  type UsageOverTimeRow,
  type UsageTotals,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { events, machines, workspaceKeys, workspaces } from "../schema.js";

/**
 * Deterministic projection repository (M6, PRD §16.1). Read-only aggregation over
 * the event log, extending the proven M5 attribution join (`projectEventSummary`,
 * workspaces.ts) with token/cost/shape aggregates. Reads ONLY the plaintext
 * columns — never decrypts a payload (PRD §18.1, D3). On-demand, no materialized
 * rollups (D2). Silent library (CLAUDE.md): throws, never logs.
 *
 * Token sums use the four `computeTotal` sub-types and RECOMPUTE `total` (never
 * trust a possibly-stale stored `total`) so server totals match the M1 report
 * arithmetic (D5). Cost USD sums in SQL; the confidence LABEL reduces in TS via
 * the shared `lowestConfidence` ladder (lowest-wins, PRD §13.3).
 */

const TOKEN_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

/**
 * NULL-safe jsonb token sum for one sub-type, restricted to `usage.reported` so
 * message/tool events (NULL tokens) never poison the sum. `::int` → JS number.
 */
const tokenSum = (field: TokenField) =>
  sql<number>`coalesce(sum((${events.tokens} ->> ${field})::bigint) filter (where ${events.eventType} = 'usage.reported'), 0)::int`;

/** Cost USD sum (numeric → string via the driver; wrap with Number). */
const costSum = sql<string>`coalesce(sum((${events.cost} ->> 'usd')::numeric) filter (where ${events.eventType} = 'cost.estimated'), 0)`;

/** Distinct cost-confidence labels (text[] → string[]); reduced in TS. */
const costConfidences = sql<string[]>`coalesce(array_agg(distinct ${events.cost} ->> 'confidence') filter (where ${events.eventType} = 'cost.estimated'), '{}')`;

/** The token-subtype select columns, reused across the project/usage/session queries. */
const tokenColumns = {
  input: tokenSum("input"),
  output: tokenSum("output"),
  cacheRead: tokenSum("cache_read"),
  cacheWrite: tokenSum("cache_write"),
};

interface TokenRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Build a NormalizedTokens from the summed sub-types, recomputing `total` (== computeTotal). */
function tokensFromRow(r: TokenRow | undefined): NormalizedTokens {
  const t = zeroTokens();
  t.input = r?.input ?? 0;
  t.output = r?.output ?? 0;
  t.cache_read = r?.cacheRead ?? 0;
  t.cache_write = r?.cacheWrite ?? 0;
  t.total = t.input + t.output + t.cache_read + t.cache_write;
  return t;
}

/** Per-project token + cost totals (the on-demand version of the D5 summary, scaled to metrics). */
export async function usageTotals(db: DbClient, projectId: string): Promise<UsageTotals> {
  const [row] = await db
    .select({
      ...tokenColumns,
      costUsd: costSum,
      confidences: costConfidences,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId));
  return {
    tokens: tokensFromRow(row),
    costUsd: Number(row?.costUsd ?? 0),
    costConfidence: lowestConfidence((row?.confidences ?? []) as CostConfidence[]),
    eventCount: row?.eventCount ?? 0,
  };
}

/** Per-model token + cost breakdown for a project (tool/model comparison input, PRD §14). */
export async function usageByModel(db: DbClient, projectId: string): Promise<UsageByModelRow[]> {
  const rows = await db
    .select({
      model: events.model,
      ...tokenColumns,
      costUsd: costSum,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    // Group only over the events that carry usage/cost — message/tool/file events
    // (NULL model) would otherwise collapse into a phantom all-zero `model: null`
    // row. A usage event that genuinely lacks a model still yields a null row here.
    .where(
      and(
        eq(workspaces.projectId, projectId),
        inArray(events.eventType, ["usage.reported", "cost.estimated"]),
      ),
    )
    .groupBy(events.model);
  return rows.map((r) => ({
    model: r.model,
    tokens: tokensFromRow(r),
    costUsd: Number(r.costUsd ?? 0),
  }));
}

/** Per-time-bucket usage for a project (cost-over-time, PRD §14). Ascending by bucket. */
export async function usageOverTime(
  db: DbClient,
  projectId: string,
  bucket: "day" | "week",
): Promise<UsageOverTimeRow[]> {
  // Inline the unit as a raw literal (closed set, injection-safe) so the SELECT,
  // GROUP BY, and ORDER BY share ONE identical expression — a bound parameter
  // would make Postgres treat them as distinct and reject the GROUP BY.
  const unit = bucket === "week" ? "week" : "day";
  const bucketExpr = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${events.ts}::timestamptz)`;
  const rows = await db
    .select({
      bucket: bucketExpr,
      ...tokenColumns,
      costUsd: costSum,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr);
  return rows.map((r) => ({
    // date_trunc on a timestamptz returns a JS Date via the driver — normalize to ISO.
    bucket: new Date(r.bucket as unknown as string | Date).toISOString(),
    tokens: tokensFromRow(r),
    costUsd: Number(r.costUsd ?? 0),
  }));
}

/**
 * The conditional-count + min/max-ts + distinct-model aggregate columns shared by
 * the session list and the single-session detail. `count(*) filter` matches the
 * canonical event-type strings byte-for-byte (events.ts) — a typo silently yields 0.
 */
const sessionAggregateColumns = {
  sourceConnector: sql<string>`max(${events.sourceConnector})`,
  projectPath: sql<string | null>`max(${events.projectPath})`,
  gitBranch: sql<string | null>`max(${events.gitBranch})`,
  models: sql<string[]>`coalesce(array_agg(distinct ${events.model}) filter (where ${events.model} is not null), '{}')`,
  startedAt: sql<string | null>`min(${events.ts})`,
  endedAt: sql<string | null>`max(${events.ts})`,
  eventCount: sql<number>`count(${events.fingerprint})::int`,
  userMessages: sql<number>`count(*) filter (where ${events.eventType} = 'message.user')::int`,
  assistantMessages: sql<number>`count(*) filter (where ${events.eventType} = 'message.assistant')::int`,
  toolCalls: sql<number>`count(*) filter (where ${events.eventType} like 'tool.call.%')::int`,
  toolsCompleted: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.completed')::int`,
  toolsFailed: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.failed')::int`,
  filesRead: sql<number>`count(*) filter (where ${events.eventType} = 'file.read')::int`,
  filesModified: sql<number>`count(*) filter (where ${events.eventType} = 'file.modified')::int`,
  ...tokenColumns,
  costUsd: costSum,
  confidences: costConfidences,
};

type SessionRow = {
  sessionId: string;
  sourceConnector: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[];
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolsCompleted: number;
  toolsFailed: number;
  filesRead: number;
  filesModified: number;
  confidences: string[];
  costUsd: string;
} & TokenRow;

/** Assemble a SessionProjection from an aggregate row + a known sessionId. */
function sessionFromRow(sessionId: string, r: SessionRow | undefined): SessionProjection {
  return {
    sessionId,
    sourceConnector: r?.sourceConnector ?? "",
    projectPath: r?.projectPath ?? null,
    gitBranch: r?.gitBranch ?? null,
    models: r?.models ?? [],
    startedAt: r?.startedAt ?? null,
    endedAt: r?.endedAt ?? null,
    eventCount: r?.eventCount ?? 0,
    userMessages: r?.userMessages ?? 0,
    assistantMessages: r?.assistantMessages ?? 0,
    toolCalls: r?.toolCalls ?? 0,
    toolsCompleted: r?.toolsCompleted ?? 0,
    toolsFailed: r?.toolsFailed ?? 0,
    filesRead: r?.filesRead ?? 0,
    filesModified: r?.filesModified ?? 0,
    tokens: tokensFromRow(r),
    costUsd: Number(r?.costUsd ?? 0),
    costConfidence: lowestConfidence((r?.confidences ?? []) as CostConfidence[]),
  };
}

/** Reconstruct every session in a project (newest first by last activity, PRD §15 precursor). */
export async function sessionProjections(
  db: DbClient,
  projectId: string,
): Promise<SessionProjection[]> {
  const rows = await db
    .select({ sessionId: events.sessionId, ...sessionAggregateColumns })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId))
    .groupBy(events.sessionId)
    .orderBy(sql`max(${events.ts}) desc`);
  return rows.map((r) => sessionFromRow(r.sessionId, r as SessionRow));
}

/**
 * One session's shape, identified directly by `session_id` (NOT project-joined —
 * a session is its own identity). Returns a zeroed projection if no rows match.
 */
export async function sessionDetail(db: DbClient, sessionId: string): Promise<SessionDetail> {
  const [row] = await db
    .select(sessionAggregateColumns)
    .from(events)
    .where(eq(events.sessionId, sessionId));
  // count(*) is 0 (not absent) for an unknown session — treat as "no session".
  if (!row || row.eventCount === 0) return sessionFromRow(sessionId, undefined);
  return sessionFromRow(sessionId, { sessionId, ...row } as SessionRow);
}

/**
 * Derived per-connector health (PRD §10.1.1, D8). Scoped to the user via the
 * `machines` join so UNATTRIBUTED events (e.g. Gemini hash sessions with no
 * workspace_keys row) are still counted — unlike the project rollups, which join
 * through workspace_keys and drop them. Clock-free: returns `lastEventAt`; the
 * "N seconds ago" framing is computed by the consumer.
 */
export async function connectorHealth(
  db: DbClient,
  userId: string,
): Promise<ConnectorHealthRow[]> {
  const rows = await db
    .select({
      sourceConnector: events.sourceConnector,
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      // Terminal calls only (completed+failed) — NOT `tool.call.%`, which would also count the
      // `tool.call.started` every connector emits per call, ~doubling the denominator and halving
      // the failure ratio that drives the M10 `connector.failing` alert (deriveAlerts in @420ai/shared).
      toolCalls: sql<number>`count(*) filter (where ${events.eventType} in ('tool.call.completed', 'tool.call.failed'))::int`,
      toolsFailed: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.failed')::int`,
      parserVersions: sql<string[]>`coalesce(array_agg(distinct ${events.parserVersion}), '{}')`,
      models: sql<string[]>`coalesce(array_agg(distinct ${events.model}) filter (where ${events.model} is not null), '{}')`,
    })
    .from(events)
    .innerJoin(machines, eq(events.machineId, machines.id))
    .where(eq(machines.userId, userId))
    .groupBy(events.sourceConnector)
    .orderBy(events.sourceConnector);
  return rows.map((r) => ({
    sourceConnector: r.sourceConnector,
    lastEventAt: r.lastEventAt ?? null,
    eventCount: r.eventCount,
    toolCalls: r.toolCalls,
    toolsFailed: r.toolsFailed,
    parserVersions: r.parserVersions ?? [],
    models: r.models ?? [],
  }));
}

/**
 * Distinct git fields already on a project's events + the project_path keys mapped
 * to it (Scope Decision 1 — projection only, no git-history capture, no inference).
 */
export async function projectGitMetadata(
  db: DbClient,
  projectId: string,
): Promise<ProjectGitMetadata> {
  const [row] = await db
    .select({
      branches: sql<string[]>`coalesce(array_agg(distinct ${events.gitBranch}) filter (where ${events.gitBranch} is not null), '{}')`,
      projectPaths: sql<string[]>`coalesce(array_agg(distinct ${events.projectPath}) filter (where ${events.projectPath} is not null), '{}')`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId));
  return { branches: row?.branches ?? [], projectPaths: row?.projectPaths ?? [] };
}
