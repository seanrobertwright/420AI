import { postIngest, isUnauthorized } from "../ingest-client.js";
import type { QueueStore, SyncOutcome } from "../queue/queue-store.js";
import { maybeSendHeartbeat, newHeartbeatState } from "../heartbeat.js";
import type { IngestBatch, RawRecordPayload, EventPayload } from "@420ai/shared";

/**
 * Sync worker: drains the durable queue to the M2 Ingest API. Library file —
 * returns outcomes, never logs/exits (the engine/cli surfaces them).
 *
 *   claim -> group raw+events into one IngestBatch -> postIngest
 *     2xx           -> ack (delete) the items
 *     401           -> releaseInflight + return "stop" (token revoked; re-pair)
 *     5xx / network -> markFailed each (capped backoff) + return "retry"
 *
 * Acks only AFTER the server confirms, so data captured offline lands exactly
 * once the archive is reachable; a crash mid-send is recovered via
 * `recoverInflight` on boot (never dropped, never double-fired — server
 * idempotency from M2/PRD §23 dedups any re-send).
 */
export interface SyncDeps {
  queue: QueueStore;
  url: string;
  token: string;
  batchSize?: number;
  /** Injectable for tests; defaults to the real fetch-based client. */
  post?: typeof postIngest;
  /**
   * External abort (SIGINT) — cancels the in-flight ingest POST so shutdown is prompt (C.8). Without
   * it a stalled archive connection would block `Promise.allSettled` in the engine forever.
   */
  signal?: AbortSignal;
  /** Per-request timeout override (ms); used to bound the shutdown drain to its deadline (C.8). */
  timeoutMs?: number;
  /**
   * M16 16.6 (F1): observe how many queue items the archive actually ACCEPTED on this drain —
   * called only after a 2xx `ack`, never for an empty (no-POST) drain.
   *
   * `syncOnce`'s outcome cannot answer "did anything reach the archive?": an empty queue returns
   * "ok" without making a single request. That ambiguity is what let a fault self-resolve on a
   * quiet machine that had never re-contacted the archive at all.
   */
  onDelivered?: (count: number) => void;
}

/**
 * True for a fetch cancelled by SIGINT (`AbortError`) or by our request timeout (`TimeoutError`).
 * That is a shutdown signal, NOT a delivery failure — the item should be released (claim returned,
 * no attempt bump), not backed off, so a graceful stop doesn't penalize the next start.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export async function syncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  const items = deps.queue.claimBatch(deps.batchSize ?? 500);
  if (items.length === 0) return "ok";

  const records: RawRecordPayload[] = [];
  const events: EventPayload[] = [];
  for (const item of items) {
    if (item.kind === "raw") records.push(JSON.parse(item.payloadJson) as RawRecordPayload);
    else events.push(JSON.parse(item.payloadJson) as EventPayload);
  }
  const batch: IngestBatch = { records, events };

  try {
    await (deps.post ?? postIngest)(deps.url, deps.token, batch, {
      signal: deps.signal,
      timeoutMs: deps.timeoutMs,
    });
    deps.queue.ack(items.map((i) => i.id));
    deps.onDelivered?.(items.length);
    return "ok";
  } catch (err) {
    if (isUnauthorized(err)) {
      // Token revoked — surface, do not spin. Leave items pending for re-pair.
      deps.queue.releaseInflight(items.map((i) => i.id));
      return "stop";
    }
    if (isAbortError(err) || deps.signal?.aborted === true) {
      // SIGINT or the request timeout cancelled the in-flight POST — not a delivery failure. Release
      // the claim with NO attempt bump (mirrors the 401 path) so a graceful shutdown doesn't back
      // these items off on the next start; the caller's loop sees the abort and unwinds.
      deps.queue.releaseInflight(items.map((i) => i.id));
      return "retry";
    }
    // Network / 5xx — back each off and retry on the next loop.
    for (const item of items) deps.queue.markFailed(item.id, item.attempts);
    return "retry";
  }
}

/** A delay that resolves early when the signal aborts (so SIGINT stops promptly). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SyncLoopDeps extends SyncDeps {
  /** Idle delay between empty drains. */
  idleMs?: number;
  /** Short delay after a retry (backoff itself lives in next_attempt_at). */
  retryMs?: number;
  /** Called once when the loop stops on a 401 so the engine/cli can surface it. */
  onStop?: () => void;
  /**
   * M13 13.1: called with an ISO timestamp after each successful drain (`syncOnce` outcome
   * "ok" — including a no-op empty-queue drain) so the engine/cli can surface a live
   * "last sync" time (mirrors how `consecutiveSyncFailures` already feeds the heartbeat).
   *
   * M16 16.6 (F1): `delivered` is how many items the archive ACCEPTED on that drain — **0 for the
   * empty-queue drain**, which is the common case on an idle machine (every ~2 s). A caller
   * treating "we are alive" as the signal keeps using the timestamp alone; a caller deciding
   * whether the collector has actually re-reached the archive (clearing the durable fault record)
   * MUST require `delivered > 0`, or a quiet machine clears its fault without sending a byte.
   */
  onSync?: (at: string, delivered: number) => void;
  /**
   * M9 heartbeat (opt-in): when `collectorVersion` is set, the loop sends a throttled,
   * best-effort liveness ping each iteration (queue backlog + version). Omitting it
   * disables heartbeats — existing callers/tests are unaffected.
   */
  collectorVersion?: string;
  /** Heartbeat cadence; default 30 s. */
  heartbeatIntervalMs?: number;
  /** Injectable clock for the heartbeat throttle (tests); defaults to wall-clock. */
  now?: () => Date;
  /** Injectable heartbeat client (tests); defaults to the real fetch-based client. */
  postHeartbeat?: typeof import("../ingest-client.js").postHeartbeat;
  /**
   * M16 16.3: the DECLARED connector inventory, read at each send (a thunk — see `HeartbeatDeps`).
   * Threaded straight through; the loop makes no decision about it.
   */
  connectorReports?: () => import("@420ai/shared").MachineConnectorReport[];
  /** M16 16.3: observe a swallowed heartbeat failure (D-16.3-6). The swallow itself stays. */
  onHeartbeatError?: (e: unknown) => void;
}

/**
 * Drain the queue continuously until `signal` aborts. Returns the reason it
 * ended: "aborted" (SIGINT) or "stop" (401 — re-pair needed).
 */
export async function runSyncLoop(
  deps: SyncLoopDeps,
  signal: AbortSignal,
): Promise<"aborted" | "stop"> {
  const idleMs = deps.idleMs ?? 2000;
  const retryMs = deps.retryMs ?? 1000;
  // M9: one throttle state per loop; heartbeats are sent only when collectorVersion is set.
  const heartbeatState = newHeartbeatState();
  // M12 12.6: consecutive collector→archive sync failures — reset on "ok", ++ on "retry".
  // The heartbeat reports the latest accumulated count so the server can derive archive.unreachable.
  let consecutiveSyncFailures = 0;
  const sendHeartbeat = async (count: number): Promise<void> => {
    if (!deps.collectorVersion) return; // heartbeat disabled (no version wired)
    await maybeSendHeartbeat(
      {
        url: deps.url,
        token: deps.token,
        queue: deps.queue,
        collectorVersion: deps.collectorVersion,
        intervalMs: deps.heartbeatIntervalMs ?? 30000,
        now: deps.now ?? (() => new Date()),
        consecutiveSyncFailures: count,
        connectorReports: deps.connectorReports,
        onError: deps.onHeartbeatError,
        post: deps.postHeartbeat,
      },
      heartbeatState,
    );
  };
  while (!signal.aborted) {
    // Best-effort liveness ping (throttled) before each drain — reports the count accumulated
    // by prior iterations. A failure is swallowed inside maybeSendHeartbeat and never affects
    // the sync outcome or the counter (residual risk e).
    await sendHeartbeat(consecutiveSyncFailures);
    // Thread the loop's abort signal into the POST so SIGINT cancels an in-flight sync immediately
    // (C.8) — otherwise a stalled archive connection blocks the engine's shutdown await forever.
    // M16 16.6 (F1): count what this drain actually delivered. Reset per iteration, and set only
    // by `syncOnce` after a 2xx ack — an empty drain leaves it 0.
    let delivered = 0;
    const outcome = await syncOnce({
      ...deps,
      signal,
      onDelivered: (n) => {
        delivered = n;
        deps.onDelivered?.(n);
      },
    });
    if (outcome === "stop") {
      deps.onStop?.();
      return "stop";
    }
    if (signal.aborted) break;
    if (outcome === "ok") {
      consecutiveSyncFailures = 0; // archive reachable — clear the failure streak
      deps.onSync?.((deps.now ?? (() => new Date()))().toISOString(), delivered);
      // Empty/clean drain — idle. (A non-empty 2xx returns "ok" too; we still
      // idle briefly, then the next claim pulls any remaining batch.)
      await delay(idleMs, signal);
    } else {
      consecutiveSyncFailures += 1; // network/5xx — couldn't reach the archive
      // retry — short delay; due-time enforced by next_attempt_at.
      await delay(retryMs, signal);
    }
  }
  return "aborted";
}
