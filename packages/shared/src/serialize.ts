/**
 * Pure export serializers (PRD §22 "Export And Backup"). Dependency-free string
 * builders for the row-shaped V1 export formats — JSON Lines (NDJSON) and CSV
 * (RFC 4180) — plus the self-describing `ExportManifest` every export bundle
 * carries. Markdown export is just the already-rendered artifact text, so it needs
 * no serializer here.
 *
 * `@420ai/shared` invariants (mirrors `redaction.ts`/`cost.ts`): no I/O, no
 * `new Date()`, no deps. The route owns the clock and supplies `exportedAt`; these
 * functions are deterministic given their inputs.
 */

import type { RedactionFinding } from "./redaction.js";

/** The V1 export formats (PRD §22). Parquet is events-only (the flat tabular subject). */
export type ExportFormat = "md" | "json" | "jsonl" | "csv" | "parquet";

/**
 * Self-describing export header attached to every bundle: what it is, when it was
 * produced, the scope it covers, the redaction-ruleset identity it passed through,
 * the row count, a NON-silent truncation flag, and the merged redaction findings
 * (metadata only — never raw secret values; the §18 guarantee `redact()` upholds).
 */
export interface ExportManifest {
  /** ISO timestamp the route stamped (route owns the clock). */
  exportedAt: string;
  subject: "events" | "report" | "transcript";
  format: ExportFormat;
  /** The filters/identifiers that scoped this export (undefined entries omitted at the route). */
  scope: Record<string, string | undefined>;
  /** REDACTION_VERSION the payload was redacted under. */
  redactionVersion: string;
  rowCount: number;
  /** True if a cap clipped the result — surfaced here AND as an X-Export-Truncated header. */
  truncated: boolean;
  /** Merged per-kind redaction findings (metadata only). */
  redactionFindings: RedactionFinding[];
}

/**
 * Serialize rows as JSON Lines (NDJSON): one compact `JSON.stringify` per row,
 * newline-separated, with a trailing newline when non-empty. An empty array yields
 * `""`. Each line is independently `JSON.parse`-able (do NOT pretty-print).
 */
export function toJsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** True if a CSV field must be quoted: contains a comma, a double-quote, CR, or LF. */
function needsQuoting(field: string): boolean {
  return field.includes(",") || field.includes('"') || field.includes("\r") || field.includes("\n");
}

/** Render one cell value to its RFC-4180 string form (unquoted). null/undefined → "". */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Quote a field per RFC 4180: wrap in `"…"` and double inner `"` iff it needs quoting. */
function quoteField(value: unknown): string {
  const s = cellToString(value);
  if (!needsQuoting(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialize records as RFC-4180 CSV. The header row is `columns` (in order); each
 * record contributes one row reading `columns` in order. A column missing from a
 * record → empty field; a record key not in `columns` → omitted. `null`/`undefined`
 * → empty; numbers/bools → their string form; objects → compact JSON. Fields
 * containing `,` `"` CR or LF are quoted (inner `"` doubled). Rows are terminated
 * by CRLF (RFC 4180). Always emits the header, even for an empty record list.
 */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): string {
  const lines: string[] = [columns.map(quoteField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => quoteField(row[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
