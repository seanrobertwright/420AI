import { postIngest, isUnauthorized, IngestHttpError } from "../ingest-client.js";
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
  /**
   * M16 16.7 — the archive RESPONDED and REFUSED this batch: a clean non-401 4xx (400 malformed,
   * 413 too large, 422 unprocessable). Called after the items are backed off, before the "retry".
   *
   * IT EXISTS TO KEEP "UNREACHABLE" HONEST. `syncOnce` collapses every non-401 failure into
   * "retry", so the sync loop could not tell "I could not complete a request" from "the archive
   * answered me and said no" — and the loop's `consecutiveSyncFailures` is the ONLY input to
   * `ARCHIVE_UNREACHABLE_MIN_FAILURES`, on both the server-side `archive.unreachable` alert and
   * (since 16.7) the collector's own `archive_unreachable` fault record. A batch the archive will
   * never accept retries forever — the queue has no dead-letter path — so without this it would
   * grow the streak without bound and report a REACHABLE archive as unreachable, permanently.
   *
   * Reported through a callback rather than a fourth `SyncOutcome` for the reason `onDelivered`
   * above already establishes: the outcome answers "what should the loop do next" (back off and
   * retry — identical either way), and the loop's other question needs a separate channel.
   *
   * A clean HTTP status is POSITIVE PROOF the archive is reachable, so the loop resets the streak
   * on it exactly as it does on `delivered > 0`. Same evidence standard, second source.
   *
   * RESIDUAL AMBIGUITY, stated rather than papered over: a body over the ingest server's 16 MiB
   * `bodyLimit` is rejected MID-STREAM and reaches the client as an opaque `ECONNRESET` with the
   * server still up (CLAUDE.md, UAT C.6) — not a clean 413. That case is indistinguishable from a
   * transport failure HERE and still grows the streak, which is the honest reading at this layer:
   * the request did not complete. The real defect in that scenario is that `claimBatch` bounds the
   * batch by ITEM COUNT (500) and not by bytes, so the fix belongs there, not in this predicate.
   */
  onRefused?: (status: number) => void;
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
    // Network / 5xx / a refused 4xx — back each off and retry on the next loop.
    for (const item of items) deps.queue.markFailed(item.id, item.attempts);
    // M16 16.7: the archive ANSWERED. 401 already returned "stop" above, so any remaining 4xx is a
    // deliberate refusal of this batch's CONTENT — the archive is demonstrably reachable, and
    // retrying will not change its mind. Report it so the loop does not count it as an outage.
    // 5xx stays uncounted-as-refusal on purpose: a 502/503 is the archive being down, which is
    // exactly what `archive.unreachable` means.
    if (err instanceof IngestHttpError && err.status >= 400 && err.status < 500) {
      deps.onRefused?.(err.status);
    }
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
   * M16 16.7: called after each FAILED drain with the running consecutive-failure count (1, 2, 3…),
   * reset to 0 by the next `"ok"`. The mirror of `onSync`, and the reason it exists is that
   * `consecutiveSyncFailures` was previously reported ONLY through the heartbeat — the one channel
   * that cannot arrive when the archive is what is down.
   *
   * The loop makes no decision from it: it does not throttle, does not write a file and does not
   * stop. The engine applies the threshold and the re-stamp policy, because those are POLICY and
   * this is a loop.
   *
   * NOT called for a `"stop"` (401) outcome — that is the fatal path, which has `onStop`.
   *
   * NOR for a drain the archive ANSWERED and refused (a clean non-401 4xx) — that is
   * `onSyncRefused`, and the split is what keeps "unreachable" meaning unreachable.
   */
  onSyncFailure?: (consecutive: number) => void;
  /**
   * M16 16.7: called when the archive answered with a clean non-401 4xx — it is up, and it refused
   * this batch's content. The counterpart to `onSyncFailure`, and the reason that one can still be
   * trusted to mean "the archive is unreachable". See `SyncDeps.onRefused` for the full argument
   * and for the one case (an over-limit body reset mid-stream) that this cannot distinguish.
   *
   * The loop makes no decision from it beyond resetting the failure streak: it does not stop, does
   * not dead-letter the batch, and does not write anything. The entrypoint surfaces it.
   */
  onSyncRefused?: (status: number) => void;
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
    // M16 16.7: set when the archive ANSWERED and refused this batch — see `onRefused`. Reset per
    // iteration, exactly like `delivered`, so it always describes THIS drain.
    let refusedStatus: number | undefined;
    const outcome = await syncOnce({
      ...deps,
      signal,
      onDelivered: (n) => {
        delivered = n;
        deps.onDelivered?.(n);
      },
      onRefused: (s) => {
        refusedStatus = s;
        deps.onRefused?.(s);
      },
    });
    if (outcome === "stop") {
      deps.onStop?.();
      return "stop";
    }
    if (signal.aborted) break;
    if (outcome === "ok") {
      // M16 16.7 — RESET ONLY ON A DRAIN THAT ACTUALLY DELIVERED. This read
      // `consecutiveSyncFailures = 0` on every "ok", and that made the counter unable to count.
      //
      // `syncOnce` returns "ok" for an empty claim WITHOUT posting anything, and a FAILED item is
      // backed off exponentially (1 s → 2 s → … → 30 s, `queue-store.ts`) while `retryMs` stays at
      // 1 s. So from the second failure onward the next claim finds nothing due, returns "ok", and
      // zeroed the streak. Measured, not theorised: a loop against a permanently-503 archive
      // produced the sequence 1, 1, 1, … forever instead of 1, 2, 3.
      //
      // The consequence was not subtle. `ARCHIVE_UNREACHABLE_MIN_FAILURES` is 3, and this counter
      // is the ONLY input to it — via the heartbeat for the server-side `archive.unreachable`
      // alert, and (since 16.7) via `onSyncFailure` for the collector's own durable fault record.
      // A threshold of 3 against a value that oscillates between 0 and 1 is a detector that cannot
      // fire, so a sustained outage was undetectable by BOTH surfaces.
      //
      // This is 16.6's F1 lesson applied one layer up. `cli.ts` already refuses to CLEAR the fault
      // record on `delivered === 0` for exactly this reason ("only bytes the archive accepted prove
      // it is reachable"); the counter that OPENS the record was still treating a no-op drain as
      // proof. Both halves now use the same evidence.
      //
      // THE COUNTER MEANS "consecutive drains that could not COMPLETE a request", which is what
      // `archive.unreachable` claims. Two distinct things therefore reset it, and both are positive
      // proof the archive is reachable rather than an absence of evidence: a drain that DELIVERED
      // (here) and a drain the archive ANSWERED and refused (the `else` branch below). A no-op
      // empty drain is neither and resets nothing.
      if (delivered > 0) consecutiveSyncFailures = 0;
      deps.onSync?.((deps.now ?? (() => new Date()))().toISOString(), delivered);
      // Empty/clean drain — idle. (A non-empty 2xx returns "ok" too; we still
      // idle briefly, then the next claim pulls any remaining batch.)
      await delay(idleMs, signal);
    } else if (refusedStatus !== undefined) {
      // M16 16.7 — REACHED AND REFUSED. The archive answered with a clean non-401 4xx, so it is
      // demonstrably up and this is a bad BATCH, not an outage. Counting it would make the streak
      // grow without bound (the queue has no dead-letter path, so a batch the archive will never
      // accept is retried forever) and report a running archive as unreachable, permanently, on
      // both the server-side alert and the local fault record.
      //
      // The answer is proof of reachability, so it RESETS the streak for the same reason
      // `delivered > 0` does — same evidence standard, second source.
      consecutiveSyncFailures = 0;
      // Not silent: a batch that can never be delivered is its own problem and the operator has to
      // hear about it, even though 16.7 deliberately adds no alert code for it. Guarded like every
      // other reporter here (F-16.3-2).
      try {
        deps.onSyncRefused?.(refusedStatus);
      } catch {
        /* a failure reporter that throws must not become the outage it was reporting */
      }
      await delay(retryMs, signal);
    } else {
      // The request did not COMPLETE — network error, timeout, or a 5xx (the archive being down is
      // precisely what `archive.unreachable` means).
      consecutiveSyncFailures += 1;
      // M16 16.7: report the streak so the engine can write a DURABLE record of an unreachable
      // archive. GUARDED for the reason `capture-engine.ts` guards `onFatal` and `heartbeat.ts`
      // guards `onError` (the F-16.3-2 shape): the callback writes a file, and a throw here would
      // unwind the whole sync loop through a rejected promise — turning "the archive is down" into
      // "capture stopped", in the component whose job is to keep queueing until it comes back.
      try {
        deps.onSyncFailure?.(consecutiveSyncFailures);
      } catch {
        /* a failure reporter that throws must not become the outage it was reporting */
      }
      // retry — short delay; due-time enforced by next_attempt_at.
      await delay(retryMs, signal);
    }
  }
  return "aborted";
}
