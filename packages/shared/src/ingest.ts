import type { EventType, NormalizedEvent, RawSourceRecord } from "./events.js";
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
  catalogVersion?: string; // pricing-catalog version (PRD §23); NOT a fingerprint input
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
 * Collector liveness ping (M9, PRD §20). ADDITIVE to the M2 wire contract — a
 * sibling of `IngestBatch`, not a change to it. The collector POSTs this to the
 * machine-authed `POST /v1/heartbeat` on a throttled cadence so the server can
 * see the (machine-local) sync backlog and tell an idle-but-alive collector from
 * an offline one (`lastSeenAt` only refreshes on activity, so it can't).
 */
export interface HeartbeatRequest {
  queuePending: number; // QueueStore.stats().pending
  queueInflight: number; // QueueStore.stats().inflight
  collectorVersion: string; // from the collector package.json, read at the entrypoint
}

export interface HeartbeatResponse {
  ok: true;
}

/**
 * Map an internal RawSourceRecord onto the wire RawRecordPayload. The machine-
 * local record `id` becomes the wire `sourceRecordId`. Symmetric with
 * `toEventPayload` — keeps the collector's wire boundary in one place.
 */
export function toRawRecordPayload(r: RawSourceRecord): RawRecordPayload {
  return {
    sourceConnector: r.sourceConnector,
    sessionId: r.sessionId,
    sourceRecordId: r.id,
    payload: r.payload,
    ingestedAt: r.ingestedAt,
  };
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
    catalogVersion: e.catalogVersion,
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
