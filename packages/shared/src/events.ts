import type { NormalizedTokens } from "./tokens.js";
import type { CostResult } from "./cost.js";

/**
 * Normalized event taxonomy (subset of PRD §12 sufficient for Milestone 1).
 *
 * Full taxonomy lands in later milestones. Omitted-for-now event types include:
 *   "session.resumed", "message.system", "tool.result.received",
 *   "permission.requested", "permission.decided", "file.snapshot",
 *   "title.generated", "error.raised".
 */
export type EventType =
  | "session.started"
  | "session.ended"
  | "message.user"
  | "message.assistant"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.call.failed"
  | "usage.reported"
  | "cost.estimated";

/**
 * A raw source record — the verbatim original connector record (raw is sacred,
 * never mutate; PRD §23 / SUMMARY §5). `payload` is the exact JSONL line text.
 */
export interface RawSourceRecord {
  id: string;
  sourceConnector: string;
  sessionId: string;
  ingestedAt: string;
  payload: string;
}

/**
 * A normalized event — the disposable, re-derivable projection of a raw record.
 * Identified by its deterministic `fingerprint` (see eventFingerprint).
 */
export interface NormalizedEvent {
  fingerprint: string;
  sourceConnector: string;
  parserVersion: string;
  rawRecordId: string;
  eventIndex: number;
  eventType: EventType;
  sessionId: string;
  projectPath?: string;
  gitBranch?: string;
  model?: string;
  ts: string;
  tokens?: NormalizedTokens;
  cost?: CostResult;
  payload?: unknown;
}
