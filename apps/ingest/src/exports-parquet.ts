import { parquetWriteBuffer } from "hyparquet-writer";

/**
 * Serialize flat export rows to a SNAPPY-compressed Parquet buffer (PRD §22). Column-oriented:
 * one column per `columns` entry, values pulled in row order (missing/undefined → null so the
 * column stays nullable). Pure + deterministic (the route owns redaction + the clock); the binary
 * is self-describing via its own schema, and the export manifest rides the X-Export-* headers
 * (as it does for CSV). Mirrors the `@420ai/shared` no-IO invariant — but lives HERE, not in
 * shared, because shared is dependency-free.
 *
 * `parquetWriteBuffer` returns an `ArrayBuffer` (SNAPPY, schema auto-inferred); we wrap it in a
 * Node `Buffer` so Fastify sends the bytes as-is under the binary content-type.
 */
export function eventsToParquetBuffer(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): Buffer {
  const columnData = columns.map((name) => ({
    name,
    data: rows.map((r) => r[name] ?? null),
  }));
  const ab = parquetWriteBuffer({ columnData });
  return Buffer.from(ab);
}
