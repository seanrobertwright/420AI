import type { NormalizedTokens } from "./tokens.js";
import type { CostResult } from "./cost.js";

/**
 * Normalized event taxonomy (subset of PRD §12).
 *
 * M1 shipped the session/message/usage/cost core plus `tool.call.started`. M4
 * correlates the tool-call lifecycle (`tool.call.completed`/`tool.call.failed`)
 * and adds the file-interaction + context-load events
 * (`file.read`/`file.modified`/`file.referenced`/`context.loaded`). These are
 * client-only additions — the server stores `event_type` as free text, so no
 * server change or migration is required.
 *
 * Full taxonomy lands in later milestones. Omitted-for-now event types include:
 *   "session.resumed", "message.system", "tool.result.received",
 *   "permission.requested", "permission.decided", "file.snapshot",
 *   "title.generated", "error.raised".
 *
 * The §12 git taxonomy ("git.commit.detected"/"git.diff.detected") is
 * intentionally NOT in this union. M10 materializes git outcomes as a DEDICATED
 * projection (the `git_commits`/`git_commit_files` tables + see `git.ts`), exactly
 * as M7 stores reports in `report_artifacts` rather than as `report.generated`
 * events (Scope Decision 2). No connector emits git outcomes as `NormalizedEvent`s,
 * so `/v1/ingest`, the `events` table, and the fingerprint stay untouched (D2).
 */
export type EventType =
  | "session.started"
  | "session.ended"
  | "message.user"
  | "message.assistant"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.call.failed"
  | "file.read"
  | "file.modified"
  | "file.referenced"
  | "context.loaded"
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
