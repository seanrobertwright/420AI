import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { CostResult, NormalizedTokens } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { events, machines, workspaceKeys, workspaces } from "../schema.js";

/**
 * Scoped event-stream export read (PRD §22). The additive read backing
 * `GET /v1/exports/events`: selects ONLY the plaintext event columns — it NEVER
 * decrypts (no `payload_ciphertext/iv/tag`); decrypt-for-render is the transcript
 * read's job (§18). Mirrors the M6 projection scoping (`projections.ts`): a project
 * scope joins through `workspace_keys → workspaces` (inherently user-scoped through
 * the project), otherwise scopes via the `machines.userId` join. Silent library
 * (CLAUDE.md): throws, never logs.
 *
 * §18: "Redaction applies before AI analysis or external export." This read returns
 * raw plaintext columns (incl. `projectPath` home paths); the CALLER (the export
 * route) is contractually required to pass every row through `redactJson()` before
 * the bytes leave the archive.
 */

/** A generous, NON-silent row bound — truncation is surfaced in the manifest + header. */
export const EXPORT_MAX_ROWS = 100_000;

/** Scope filters; any combination may be supplied. `start`/`end` are ISO strings. */
export interface EventExportFilters {
  projectId?: string;
  sessionId?: string;
  connector?: string;
  start?: string;
  end?: string;
}

/** One exported event row — plaintext columns only (no ciphertext triple). */
export interface EventExportRow {
  fingerprint: string;
  ts: string; // canonical ISO 8601 (normalized from the pg mode:"string" text form)
  sourceConnector: string;
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  eventType: string;
  model: string | null;
  tokens: NormalizedTokens | null; // jsonb → already-parsed object
  cost: CostResult | null; // jsonb → already-parsed object
  parserVersion: string;
  catalogVersion: string | null;
}

/**
 * Select scoped event rows for export, ordered by (ts, eventIndex). Fetches one row
 * past `cap` to detect truncation honestly: returns at most `cap` rows and a
 * `truncated` flag. When `projectId` is given, joins through workspace_keys (drops
 * nothing the project owns); otherwise joins through `machines` and scopes to
 * `userId` — which, like `connectorHealth`, drops events with a NULL `machineId`
 * (converged events keep only the most-recent machine, so this is acceptable for an
 * owner-scoped export). The `gte`/`lte` ts bounds compare against a TIMESTAMPTZ column,
 * so Postgres casts each bound to a timestamptz (a true temporal compare, not text); the
 * route normalizes the bound to canonical ISO before binding. NOTE: a plain `mode:"string"`
 * column select returns the pg text form ("2026-06-14 00:00:00+00"), NOT ISO — the returned
 * `ts` is normalized to ISO below (CLAUDE.md mode:"string" gotcha; M5/M9 recurrence).
 */
export async function exportEvents(
  db: DbClient,
  orgId: string,
  userId: string,
  filters: EventExportFilters,
  cap = EXPORT_MAX_ROWS,
): Promise<{ rows: EventExportRow[]; truncated: boolean }> {
  const columns = {
    fingerprint: events.fingerprint,
    ts: events.ts,
    sourceConnector: events.sourceConnector,
    sessionId: events.sessionId,
    projectPath: events.projectPath,
    gitBranch: events.gitBranch,
    eventType: events.eventType,
    model: events.model,
    tokens: events.tokens,
    cost: events.cost,
    parserVersion: events.parserVersion,
    catalogVersion: events.catalogVersion,
  };

  // M15 15.2: the org predicate applies to BOTH branches, and it is not optional on either.
  // `sessionId` and `projectPath` are connector-supplied, globally-scoped strings.
  const conditions = [eq(events.orgId, orgId)];
  if (filters.sessionId) conditions.push(eq(events.sessionId, filters.sessionId));
  if (filters.connector) conditions.push(eq(events.sourceConnector, filters.connector));
  if (filters.start) conditions.push(gte(events.ts, filters.start));
  if (filters.end) conditions.push(lte(events.ts, filters.end));

  // Project scope → workspace_keys join (mirrors usageTotals); else → machines join scoped
  // to the owner (mirrors connectorHealth).
  //
  // M15 15.2: the project branch needs `eq(workspaceKeys.orgId, orgId)` ON TOP of the
  // `events.org_id` predicate above, for the same reason usageTotals does — the first gives
  // ISOLATION (you never see another org's events), the second gives OWNERSHIP (you cannot
  // export through another org's project mapping at all). Before both, two orgs whose machines
  // used the same path shared `project_key` rows, and this endpoint serialised BOTH tenants'
  // event rows straight out as json/jsonl/csv/parquet. Redaction does not mitigate that:
  // `redactJson` strips PII patterns, not other tenants' records.
  const base = db.select(columns).from(events);
  const scoped = filters.projectId
    ? base
        .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
        .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
        .where(
          and(
            eq(workspaces.projectId, filters.projectId),
            eq(workspaceKeys.orgId, orgId),
            ...conditions,
          ),
        )
    : base
        .innerJoin(machines, eq(events.machineId, machines.id))
        .where(and(eq(machines.userId, userId), ...conditions));

  const fetched = await scoped.orderBy(asc(events.ts), asc(events.eventIndex)).limit(cap + 1);

  const truncated = fetched.length > cap;
  const page = truncated ? fetched.slice(0, cap) : fetched;
  // Normalize the pg text timestamp to canonical ISO so the export matches the manifest
  // and every other API surface (see the mode:"string" note above).
  const rows: EventExportRow[] = page.map((r) => ({
    ...r,
    ts: new Date(r.ts).toISOString(),
  }));
  return { rows, truncated };
}
