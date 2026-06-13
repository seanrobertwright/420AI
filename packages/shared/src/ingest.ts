import type { EventType, NormalizedEvent } from "./events.js";
import type { NormalizedTokens } from "./tokens.js";
import type { CostResult } from "./cost.js";

/**
 * Ingest wire contract (PRD §8.3) — the payloads the collector POSTs to the
 * Ingest API. Pure types, no behavior. These travel as PLAINTEXT over the wire
 * (TLS + bearer-token in prod); the SERVER encrypts sensitive fields before
 * writing (§18.1 is encryption-at-rest, not in-transit).
 *
 * Token counts and costs stay plaintext end-to-end (they are queryable metrics,
 * not secrets). The fingerprint is carried verbatim and is the server's upsert
 * key (§23) — do not recompute it server-side.
 */

/** A raw source record: the verbatim connector line, sacred and never mutated. */
export interface RawRecordPayload {
  sourceConnector: string;
  sessionId: string;
  sourceRecordId: string;
  payload: string;
  ingestedAt?: string;
}

/** A normalized event carried verbatim from the collector's parser. */
export interface EventPayload {
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

/** One POST /v1/ingest body: raw records + their derived events. */
export interface IngestBatch {
  records: RawRecordPayload[];
  events: EventPayload[];
}

export interface PairRequest {
  code: string;
  machine: { name: string; os?: string; hostname?: string };
}

export interface PairResponse {
  token: string;
  machineId: string;
}

export interface IngestResponse {
  recordsInserted: number;
  eventsUpserted: number;
}

/**
 * Map an internal NormalizedEvent onto the wire EventPayload. Currently a
 * structural pass-through, but the explicit boundary keeps the collector thin
 * and lets the wire shape evolve independently of the internal event model.
 */
export function toEventPayload(e: NormalizedEvent): EventPayload {
  return {
    fingerprint: e.fingerprint,
    sourceConnector: e.sourceConnector,
    parserVersion: e.parserVersion,
    rawRecordId: e.rawRecordId,
    eventIndex: e.eventIndex,
    eventType: e.eventType,
    sessionId: e.sessionId,
    projectPath: e.projectPath,
    gitBranch: e.gitBranch,
    model: e.model,
    ts: e.ts,
    tokens: e.tokens,
    cost: e.cost,
    payload: e.payload,
  };
}
