import type { NormalizedTokens } from "./tokens.js";
import type { CostConfidence } from "./cost.js";

/**
 * M6 deterministic-projection result shapes (PRD §16.1). These are the contract
 * the M6 read endpoints return and that M7 (reporting) + a future dashboard
 * consume. Pure types, no behavior — `@420ai/shared` stays dependency-free.
 *
 * Every projection is computed read-time over the PLAINTEXT event columns
 * (`ts`/`event_type`/`model`/`tokens`/`cost`/`project_path`/`git_branch`/
 * `source_connector`/`session_id`/`parser_version`); none ever decrypts a payload.
 * Timestamps are ISO strings because `events.ts` is `mode:"string"` (no Date coercion).
 */

/** One tool-native session, reconstructed from its events (PRD §15 autopsy precursor). */
export interface SessionProjection {
  sessionId: string;
  sourceConnector: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[]; // distinct, nulls dropped
  startedAt: string | null; // min(ts) — ISO string
  endedAt: string | null; // max(ts)
  eventCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number; // event_type LIKE 'tool.call.%'
  toolsCompleted: number;
  toolsFailed: number;
  filesRead: number;
  filesModified: number;
  tokens: NormalizedTokens; // summed over usage.reported (subtypes; total recomputed)
  costUsd: number; // summed over cost.estimated
  costConfidence: CostConfidence; // lowest-wins across the session's cost events
}

/** Per-project (or per-session) token + cost totals. */
export interface UsageTotals {
  tokens: NormalizedTokens;
  costUsd: number;
  costConfidence: CostConfidence;
  eventCount: number;
}

/** One row of the per-model usage breakdown (tool/model comparison input, PRD §14). */
export interface UsageByModelRow {
  model: string | null;
  tokens: NormalizedTokens;
  costUsd: number;
}

/** One time bucket of usage (cost-over-time, PRD §14). `bucket` is an ISO string. */
export interface UsageOverTimeRow {
  bucket: string;
  tokens: NormalizedTokens;
  costUsd: number;
}

/** Derived per-connector health (PRD §10.1.1) — no collector heartbeat (M9). */
export interface ConnectorHealthRow {
  sourceConnector: string;
  lastEventAt: string | null; // max(ts); "N seconds ago" is computed by the consumer
  eventCount: number;
  toolsFailed: number;
  parserVersions: string[];
  models: string[];
}

/** Distinct git fields already on a project's events (Scope Decision 1 — no capture). */
export interface ProjectGitMetadata {
  branches: string[]; // distinct git_branch on the project's events
  projectPaths: string[]; // distinct project_path keys mapped to the project
}

/** M6 = same shape as the list row; M7 may extend with per-tool breakdowns. */
export type SessionDetail = SessionProjection;
