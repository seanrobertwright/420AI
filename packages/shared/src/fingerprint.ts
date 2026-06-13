import { createHash } from "node:crypto";

/**
 * Deterministic event fingerprint (PRD §12, SUMMARY §4).
 *
 *   fingerprint = sha256_hex(
 *     source_connector + "|" + raw_record_id + "|" + event_index_within_record + "|" + event_type
 *   )
 *
 * The same raw input always yields the same fingerprint regardless of parser
 * version. The `|` delimiter keeps fields from colliding. This single primitive
 * powers dedup / idempotent ingest and replay upsert — do NOT reorder fields or
 * change the delimiter, or dedup silently breaks across parser versions.
 */
export function eventFingerprint(
  sourceConnector: string,
  rawRecordId: string,
  eventIndex: number,
  eventType: string,
): string {
  return createHash("sha256")
    .update([sourceConnector, rawRecordId, String(eventIndex), eventType].join("|"))
    .digest("hex");
}
