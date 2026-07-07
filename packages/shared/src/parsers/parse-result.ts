import type { NormalizedEvent, RawSourceRecord } from "../events.js";

/**
 * The result of parsing a complete-line file prefix (tail) or a whole file
 * (snapshot): permanent raw records plus the disposable normalized events
 * re-derived from them.
 *
 * Relocated from the collector's connector contract in 13.3 (12.5b): the pure
 * parsers live in @420ai/shared so the SERVER-side re-parse engine can run the
 * exact same code the collector runs at capture time. The collector's
 * `connector.ts` re-exports this type, so its importers are unchanged.
 */
export interface ParseResult {
  rawRecords: RawSourceRecord[];
  events: NormalizedEvent[];
  /** Count of JSONL lines / whole-file blobs that failed to parse (tolerant parsing). */
  skippedLines: number;
  sessionId?: string;
}
