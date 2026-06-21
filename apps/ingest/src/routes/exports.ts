import type { FastifyInstance, FastifyReply } from "fastify";
import {
  exportEvents,
  findUserIdByEmail,
  getReportArtifact,
  sessionTranscript,
  type EventExportRow,
} from "@420ai/db";
import {
  redact,
  redactJson,
  toCsv,
  toJsonl,
  REDACTION_VERSION,
  type ExportFormat,
  type ExportManifest,
  type RedactionFinding,
} from "@420ai/shared";
import { adminAuthorized, isUuid } from "../auth.js";
import { eventsToParquetBuffer } from "../exports-parquet.js";
import {
  exportEventsQuerySchema,
  exportReportQuerySchema,
  exportTranscriptQuerySchema,
} from "../schemas.js";

/**
 * M10 export surface (PRD §22): three admin-gated read routes that serialize scoped
 * archive data into the V1 portable formats (MD/JSON/JSONL/CSV; Parquet deferred).
 *
 * §18 GATE — "redaction applies before external export": EVERY payload passes through
 * `redactJson()`/`redact()` before the bytes leave the archive. The events and report
 * routes never decrypt (they read plaintext columns / an already-rendered artifact);
 * ONLY the transcript route decrypts (via `sessionTranscript`) and it redacts each
 * entry immediately, exactly like the M8 AI-interpretation path. The route owns the
 * clock (`exportedAt`) and emits a self-describing manifest + `X-Export-*` headers so
 * a truncation is never silent (CLAUDE.md "no silent caps"). No streaming in v1: the
 * `EXPORT_MAX_ROWS` cap + honest `truncated` flag bound memory, and staying on the
 * normal reply path keeps the global error handler active (a hijacked reply bypasses
 * it — monitor.ts accepts that only because SSE needs it).
 */

const CONTENT_TYPE: Record<ExportFormat, string> = {
  md: "text/markdown",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  parquet: "application/vnd.apache.parquet", // binary, events-only
};

/** Flatten the jsonb token/cost objects into scalar CSV columns (CSV is row-flat). */
const EVENT_CSV_COLUMNS = [
  "fingerprint",
  "ts",
  "sourceConnector",
  "sessionId",
  "projectPath",
  "gitBranch",
  "eventType",
  "model",
  "tokens_input",
  "tokens_output",
  "tokens_cache_read",
  "tokens_cache_write",
  "tokens_total",
  "cost_usd",
  "cost_confidence",
  "parserVersion",
  "catalogVersion",
] as const;

function flattenEventRow(r: EventExportRow): Record<string, unknown> {
  return {
    fingerprint: r.fingerprint,
    ts: r.ts,
    sourceConnector: r.sourceConnector,
    sessionId: r.sessionId,
    projectPath: r.projectPath,
    gitBranch: r.gitBranch,
    eventType: r.eventType,
    model: r.model,
    tokens_input: r.tokens?.input ?? null,
    tokens_output: r.tokens?.output ?? null,
    tokens_cache_read: r.tokens?.cache_read ?? null,
    tokens_cache_write: r.tokens?.cache_write ?? null,
    tokens_total: r.tokens?.total ?? null,
    cost_usd: r.cost?.usd ?? null,
    cost_confidence: r.cost?.confidence ?? null,
    parserVersion: r.parserVersion,
    catalogVersion: r.catalogVersion,
  };
}

/** Combine per-entry findings into one entry per kind (counts summed) for the manifest. */
function mergeFindings(findings: RedactionFinding[]): RedactionFinding[] {
  const byKind = new Map<string, RedactionFinding>();
  for (const f of findings) {
    const existing = byKind.get(f.kind);
    if (existing) existing.count += f.count;
    else byKind.set(f.kind, { ...f });
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Keep a scope value safe for a `Content-Disposition` filename. */
function safeScopeKey(value: string | undefined): string {
  if (!value) return "all";
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/**
 * Set the download headers and send the serialized body. `exportedAt` colons are
 * stripped for the filename (invalid on some filesystems); the manifest keeps the
 * full ISO timestamp.
 */
function sendExport(
  reply: FastifyReply,
  opts: {
    format: ExportFormat;
    subject: ExportManifest["subject"];
    scopeKey: string;
    exportedAt: string;
    rowCount: number;
    truncated: boolean;
    body: string | Buffer;
  },
): FastifyReply {
  const stamp = opts.exportedAt.replace(/:/g, "-");
  const filename = `420ai-${opts.subject}-${opts.scopeKey}-${stamp}.${opts.format}`;
  reply.header("content-disposition", `attachment; filename="${filename}"`);
  reply.header("x-export-row-count", String(opts.rowCount));
  reply.header("x-export-truncated", String(opts.truncated));
  reply.header("x-export-redaction-version", REDACTION_VERSION);
  return reply.type(CONTENT_TYPE[opts.format]).send(opts.body);
}

export default async function exportRoutes(app: FastifyInstance): Promise<void> {
  // 1. Scoped, redacted event-stream export → json | jsonl | csv. Never decrypts.
  app.get<{
    Querystring: {
      format: ExportFormat;
      projectId?: string;
      sessionId?: string;
      connector?: string;
      start?: string;
      end?: string;
    };
  }>(
    "/v1/exports/events",
    { schema: { querystring: exportEventsQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const { format, projectId, sessionId, connector } = request.query;
      // Malformed project id → 404 (a well-formed-unknown id yields an empty export,
      // matching the M6 read semantics); malformed never reaches a Postgres cast 500.
      if (projectId !== undefined && !isUuid(projectId)) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Normalize ISO bounds (the gte/lte compare is lexicographic — needs canonical ISO).
      let start = request.query.start;
      let end = request.query.end;
      try {
        if (start !== undefined) start = new Date(start).toISOString();
        if (end !== undefined) end = new Date(end).toISOString();
      } catch {
        return reply.code(400).send({ error: "invalid time range" });
      }

      const userId = await findUserIdByEmail(app.db, app.adminEmail);
      let rows: EventExportRow[] = [];
      let truncated = false;
      // A project scope is user-scoped through the workspace join (no userId needed);
      // the unscoped/owner path needs the resolved owner id. With neither, the export
      // is empty (no owner exists yet) rather than a 500.
      if (projectId !== undefined || userId) {
        const res = await exportEvents(app.db, userId ?? "", {
          projectId,
          sessionId,
          connector,
          start,
          end,
        });
        rows = res.rows;
        truncated = res.truncated;
      }

      // §18 gate: redact every string in every row before it leaves the archive.
      const { value: redacted, findings } = redactJson(rows);
      const exportedAt = new Date().toISOString();
      const manifest: ExportManifest = {
        exportedAt,
        subject: "events",
        format,
        scope: { projectId, sessionId, connector, start, end },
        redactionVersion: REDACTION_VERSION,
        rowCount: redacted.length,
        truncated,
        redactionFindings: findings,
      };

      let body: string | Buffer;
      if (format === "json") {
        body = JSON.stringify({ manifest, rows: redacted });
      } else if (format === "jsonl") {
        body = toJsonl(redacted);
      } else if (format === "csv") {
        body = toCsv(redacted.map(flattenEventRow), EVENT_CSV_COLUMNS);
      } else {
        // parquet (events-only): same flat tabular schema as CSV, columnar binary.
        body = eventsToParquetBuffer(redacted.map(flattenEventRow), EVENT_CSV_COLUMNS);
      }

      return sendExport(reply, {
        format,
        subject: "events",
        scopeKey: safeScopeKey(projectId ?? sessionId ?? connector),
        exportedAt,
        rowCount: redacted.length,
        truncated,
        body,
      });
    },
  );

  // 2. Single report-artifact export → md | json. Already-rendered; never decrypts.
  app.get<{ Params: { id: string }; Querystring: { format: "md" | "json" } }>(
    "/v1/reports/:id/export",
    { schema: { querystring: exportReportQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "report not found" });
      }
      const row = await getReportArtifact(app.db, request.params.id);
      if (!row) return reply.code(404).send({ error: "report not found" });

      const { format } = request.query;
      // §18 gate: redact the artifact (markdown + metrics + params) before export.
      const { value: report, findings } = redactJson({
        id: row.id,
        reportType: row.reportType,
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        version: row.version,
        reportVersion: row.reportVersion,
        catalogVersion: row.catalogVersion,
        analysisVersion: row.analysisVersion,
        params: row.params,
        metrics: row.metrics,
        markdown: row.markdown,
        generatedAt:
          row.generatedAt instanceof Date ? row.generatedAt.toISOString() : String(row.generatedAt),
      });
      const exportedAt = new Date().toISOString();
      const manifest: ExportManifest = {
        exportedAt,
        subject: "report",
        format,
        scope: { id: row.id, reportType: row.reportType, scopeId: row.scopeId },
        redactionVersion: REDACTION_VERSION,
        rowCount: 1,
        truncated: false,
        redactionFindings: findings,
      };

      const body = format === "md" ? report.markdown : JSON.stringify({ manifest, report });

      return sendExport(reply, {
        format,
        subject: "report",
        scopeKey: safeScopeKey(row.id),
        exportedAt,
        rowCount: 1,
        truncated: false,
        body,
      });
    },
  );

  // 3. Session transcript export (decrypt-for-render) → md | json | jsonl. The ONLY
  //    route that decrypts; it redacts each entry immediately (the M8 §18 pattern).
  app.get<{
    Params: { sessionId: string };
    Querystring: { format: "md" | "json" | "jsonl" };
  }>(
    "/v1/sessions/:sessionId/transcript/export",
    { schema: { querystring: exportTranscriptQuerySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      // sessionId is a connector text id (NOT a uuid) — ungated; unknown → empty transcript.
      const { sessionId } = request.params;
      const { format } = request.query;
      const { entries, truncated } = await sessionTranscript(app.db, sessionId);

      // §18 gate: redact each DECRYPTED entry before it is serialized (same call M8 uses).
      const findings: RedactionFinding[] = [];
      const redactedEntries = entries.map((e) => {
        const r = redact(e.text);
        findings.push(...r.findings);
        // sessionTranscript's `ts` comes from a mode:"string" column (pg text form); normalize
        // to canonical ISO so the exported transcript matches the manifest + the rest of the API.
        return {
          role: e.role,
          text: r.redacted,
          ts: new Date(e.ts).toISOString(),
          truncated: e.truncated,
        };
      });
      const exportedAt = new Date().toISOString();
      const manifest: ExportManifest = {
        exportedAt,
        subject: "transcript",
        format,
        scope: { sessionId },
        redactionVersion: REDACTION_VERSION,
        rowCount: redactedEntries.length,
        truncated,
        redactionFindings: mergeFindings(findings),
      };

      let body: string;
      if (format === "json") {
        body = JSON.stringify({ manifest, entries: redactedEntries });
      } else if (format === "jsonl") {
        body = toJsonl(redactedEntries);
      } else {
        body = redactedEntries.map((e) => `**${e.role}** (${e.ts}):\n\n${e.text}`).join("\n\n");
      }

      return sendExport(reply, {
        format,
        subject: "transcript",
        scopeKey: safeScopeKey(sessionId),
        exportedAt,
        rowCount: redactedEntries.length,
        truncated,
        body,
      });
    },
  );
}
