import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  classifyContextPath,
  emptyContextWastePaths,
  redact,
  zeroContextWasteCounts,
  zeroTokens,
  type ContextWasteClass,
  type FailedToolBreakdown,
  type FailureSeriesRow,
  type NormalizedTokens,
  type ToolModelComparisonRow,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import { events, workspaceKeys, workspaces } from "../schema.js";

/**
 * M13 13.2 report-projections: the four new aggregates the five new project
 * report types (PRD §15) read. `toolStatsByModel`/`failureSeries` are PLAINTEXT
 * aggregates mirroring `projections.ts`'s `tokenSum`/`costSum` fragments (same
 * Drizzle/SQL gotchas — CLAUDE.md); `failedToolBreakdown`/`contextPathSample` are
 * the two DECRYPT-BEARING projections (D-M13-1): they decrypt ONLY the matching
 * event types' own `events.payload_*` columns (no join to raw_source_records
 * needed — `ingestBatch` already stamps the event's own encrypted payload
 * directly on its row), classify/tally the decrypted values, and return ONLY
 * counts + `redact()`-ed strings. Silent library (CLAUDE.md): `decryptField`
 * throws loudly on a key/tag mismatch — let it propagate.
 */

// --- mirrored from projections.ts:31-74 (kept module-private there) --------

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the runtime `as const` array is the single source for the TokenField union below (used only via `typeof`)
const TOKEN_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

const tokenSum = (field: TokenField) =>
  sql<number>`coalesce(sum((${events.tokens} ->> ${field})::bigint) filter (where ${events.eventType} = 'usage.reported'), 0)::int`;

const costSum = sql<string>`coalesce(sum((${events.cost} ->> 'usd')::numeric) filter (where ${events.eventType} = 'cost.estimated'), 0)`;

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

function tokensFromRow(r: TokenRow | undefined): NormalizedTokens {
  const t = zeroTokens();
  t.input = r?.input ?? 0;
  t.output = r?.output ?? 0;
  t.cache_read = r?.cacheRead ?? 0;
  t.cache_write = r?.cacheWrite ?? 0;
  t.total = t.input + t.output + t.cache_read + t.cache_write;
  return t;
}

// --- plaintext aggregates ----------------------------------------------------

/** Event types that carry a model-scoped usage/cost/tool-call signal (see toolStatsByModel). */
const MODEL_SCOPED_EVENT_TYPES = [
  "usage.reported",
  "cost.estimated",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
] as const;

/**
 * Per-model tool/token/cost/session footprint on a project (PRD §14 "tool/model
 * comparison"). `toolCalls` counts TERMINAL outcomes only (completed+failed) —
 * NOT `tool.call.%`, which would also count `tool.call.started` and roughly
 * double the count (mirrors the `connectorHealth` precedent, projections.ts).
 * Restricted to the model-scoped event types so an unrelated message/file event
 * (which also inherits `model` from its parser record) never inflates
 * `sessions`/`firstSeen`/`lastSeen` for a model that did nothing measurable.
 */
export async function toolStatsByModel(
  db: DbClient,
  projectId: string,
): Promise<ToolModelComparisonRow[]> {
  const rows = await db
    .select({
      model: events.model,
      ...tokenColumns,
      costUsd: costSum,
      toolsCompleted: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.completed')::int`,
      toolsFailed: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.failed')::int`,
      sessions: sql<number>`count(distinct ${events.sessionId})::int`,
      firstSeen: sql<string | null>`min(${events.ts})`,
      lastSeen: sql<string | null>`max(${events.ts})`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        inArray(events.eventType, [...MODEL_SCOPED_EVENT_TYPES]),
      ),
    )
    .groupBy(events.model);
  return rows.map((r) => ({
    model: r.model,
    tokens: tokensFromRow(r),
    costUsd: Number(r.costUsd ?? 0),
    toolCalls: r.toolsCompleted + r.toolsFailed,
    toolsCompleted: r.toolsCompleted,
    toolsFailed: r.toolsFailed,
    sessions: r.sessions,
    // date_trunc-free min/max still return a driver Date/text — ISO-normalize (CLAUDE.md gotcha).
    firstSeen: r.firstSeen ? new Date(r.firstSeen).toISOString() : null,
    lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
  }));
}

/**
 * Per-bucket tool-call outcome counts (failed-tool-calls trend + trend-anomalies
 * input). Restricts the WHERE to the two terminal event types so a bucket only
 * appears when there was terminal tool-call activity (CLAUDE.md: an unfiltered
 * GROUP BY over the full event stream would collapse every OTHER event type's
 * rows into a noisy phantom bucket too — filtering avoids that, not just the
 * null-model case the existing gotcha note describes).
 */
export async function failureSeries(
  db: DbClient,
  projectId: string,
  bucket: "day" | "week",
): Promise<FailureSeriesRow[]> {
  const unit = bucket === "week" ? "week" : "day";
  // Inline as a raw literal from a guarded closed set (CLAUDE.md) — never a bound param.
  const bucketExpr = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${events.ts}::timestamptz)`;
  const rows = await db
    .select({
      bucket: bucketExpr,
      toolsCompleted: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.completed')::int`,
      toolsFailed: sql<number>`count(*) filter (where ${events.eventType} = 'tool.call.failed')::int`,
      sessions: sql<number>`count(distinct ${events.sessionId})::int`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        inArray(events.eventType, ["tool.call.completed", "tool.call.failed"]),
      ),
    )
    .groupBy(bucketExpr)
    .orderBy(bucketExpr);
  return rows.map((r) => ({
    bucket: new Date(r.bucket as unknown as string | Date).toISOString(),
    toolCalls: r.toolsCompleted + r.toolsFailed,
    toolsFailed: r.toolsFailed,
    sessions: r.sessions,
  }));
}

// --- decrypt-bearing aggregates (D-M13-1) -----------------------------------

/** The shape every `tool.call.failed` payload MAY carry (connector-dependent — see module doc). */
interface FailedToolPayload {
  name?: string;
  failureClass?: string;
  call_id?: string;
  tool_use_id?: string;
}

/**
 * Decrypt + classify every `tool.call.failed` payload on a project (D-M13-1: the
 * ONE decrypt-bearing orchestrator input for the failed-tool-calls report).
 * `failureClass` is Codex-only today (absent → "unclassified" — Claude does not
 * emit one; "label honestly"); `name` is Claude-only (Codex's failed payload
 * carries `call_id`, not a tool name) — absent names fall back to "(unknown)".
 * Reads directly off `events.payload_*` (no raw_source_records join): the
 * event's own encrypted payload already IS the per-call JSON the connector
 * emitted (`ingestBatch` stamps it at write time), so there is nothing to
 * reassemble from the raw JSONL line here.
 */
export async function failedToolBreakdown(
  db: DbClient,
  projectId: string,
): Promise<FailedToolBreakdown> {
  const rows = await db
    .select({
      ciphertext: events.payloadCiphertext,
      iv: events.payloadIv,
      tag: events.payloadTag,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        eq(events.eventType, "tool.call.failed"),
        isNotNull(events.payloadCiphertext),
      ),
    );

  const byClass: Record<string, number> = {};
  const byToolCounts = new Map<string, number>();
  let classified = 0;

  for (const row of rows) {
    const plaintext = decryptField({
      ciphertext: row.ciphertext!,
      iv: row.iv!,
      tag: row.tag!,
    });
    const payload = JSON.parse(plaintext) as FailedToolPayload;

    const failureClass = payload.failureClass ?? "unclassified";
    byClass[failureClass] = (byClass[failureClass] ?? 0) + 1;
    if (payload.failureClass) classified += 1;

    const tool = redact(payload.name ?? "(unknown)").redacted;
    byToolCounts.set(tool, (byToolCounts.get(tool) ?? 0) + 1);
  }

  const byTool = [...byToolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  return { byClass, byTool, coverage: { classified, total: rows.length } };
}

export interface ContextWasteSample {
  byClass: Record<ContextWasteClass, number>;
  topPaths: Record<ContextWasteClass, string[]>;
  /** Per-connector, per-event-type counts — the honest coverage table (D-M13-2). */
  coverage: { sourceConnector: string; eventType: string; count: number }[];
}

const CONTEXT_PATH_EVENT_TYPES = ["file.read", "file.modified"] as const;
const CONTEXT_COVERAGE_EVENT_TYPES = ["file.read", "file.modified", "context.loaded"] as const;
const TOP_PATHS_PER_CLASS = 10;

/**
 * Decrypt + classify `file.read`/`file.modified` payloads into the §17 waste
 * taxonomy, plus an honest per-connector coverage count for ALL THREE
 * context-relevant event types. `context.loaded`'s payload is `{attachmentType}`
 * — it carries NO path (Claude-only; see events.ts/claude-code.ts), so it
 * contributes to `coverage` only, never to `byClass`/`topPaths` ("label
 * honestly" — D-M13-2). Coverage itself never decrypts (sourceConnector/
 * eventType are plaintext columns); only the path-bearing payloads are decrypted.
 */
export async function contextPathSample(
  db: DbClient,
  projectId: string,
): Promise<ContextWasteSample> {
  const coverageRows = await db
    .select({
      sourceConnector: events.sourceConnector,
      eventType: events.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        inArray(events.eventType, [...CONTEXT_COVERAGE_EVENT_TYPES]),
      ),
    )
    .groupBy(events.sourceConnector, events.eventType)
    .orderBy(events.sourceConnector, events.eventType);

  const pathRows = await db
    .select({
      ciphertext: events.payloadCiphertext,
      iv: events.payloadIv,
      tag: events.payloadTag,
    })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(
      and(
        eq(workspaces.projectId, projectId),
        inArray(events.eventType, [...CONTEXT_PATH_EVENT_TYPES]),
        isNotNull(events.payloadCiphertext),
      ),
    );

  const byClass = zeroContextWasteCounts();
  const topPaths = emptyContextWastePaths();

  for (const row of pathRows) {
    const plaintext = decryptField({
      ciphertext: row.ciphertext!,
      iv: row.iv!,
      tag: row.tag!,
    });
    const payload = JSON.parse(plaintext) as { path?: string };
    if (!payload.path) continue;
    const cls = classifyContextPath(payload.path);
    if (!cls) continue;

    byClass[cls] += 1;
    const redactedPath = redact(payload.path).redacted;
    if (topPaths[cls].length < TOP_PATHS_PER_CLASS && !topPaths[cls].includes(redactedPath)) {
      topPaths[cls].push(redactedPath);
    }
  }

  return { byClass, topPaths, coverage: coverageRows };
}
