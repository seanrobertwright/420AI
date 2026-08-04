import type { MachineConnectorReport } from "@420ai/shared";
import { postHeartbeat } from "./ingest-client.js";
import type { QueueStore } from "./queue/queue-store.js";

/**
 * M9 collector heartbeat sender (PRD §20). A throttled, BEST-EFFORT liveness ping
 * sent from the sync loop: it carries the machine-local sync backlog (`queue.stats()`)
 * + collector version to `POST /v1/heartbeat` so the server can tell an idle-but-alive
 * collector from an offline one.
 *
 * Library file (CLAUDE.md): pure-ish + silent — no stdout, no process concerns. The
 * clock (`now`) and the `post` fn are injected so the throttle + failure paths are
 * deterministically unit-testable. Best-effort by contract (residual risk e): a send
 * failure is SWALLOWED — it never throws, never queues/retries, never stalls the loop.
 */

export interface HeartbeatState {
  /** ms-epoch of the last attempted send; 0 = never sent (so the first call sends). */
  lastSentMs: number;
}

export interface HeartbeatDeps {
  url: string;
  token: string;
  queue: QueueStore;
  collectorVersion: string;
  intervalMs: number;
  now: () => Date;
  /** M12 12.6 archive.unreachable signal — consecutive sync failures the loop has seen
   * (default 0 when the loop doesn't track it / older callers). */
  consecutiveSyncFailures?: number;
  /**
   * M16 16.3 — the DECLARED connector inventory (§7 P0.1). A THUNK, not a value: the inventory
   * carries live error counts from `queue.sqlite`, so it must be read at SEND time and not at
   * loop-construction time, or every heartbeat would report the state the collector had at boot.
   * Absent ⇒ the `connectors` field is omitted entirely, which the server reads as "this collector
   * does not report" and leaves its rows alone (distinct from an empty array, which prunes).
   */
  connectorReports?: () => MachineConnectorReport[];
  /**
   * M16 16.3 — observe a swallowed send failure (D-16.3-6). The swallow itself STAYS (a heartbeat
   * failure must never stall the sync loop, residual risk e); this only makes it visible. Without
   * it a rejected heartbeat is completely silent, and the machine simply goes `offline` in the Live
   * Monitor with no error anywhere — a silent capture-health failure inside the slice whose whole
   * purpose is to end those.
   */
  onError?: (e: unknown) => void;
  /** Injectable for tests; defaults to the real fetch-based client. */
  post?: typeof postHeartbeat;
}

/** Fresh throttle state (never sent). */
export function newHeartbeatState(): HeartbeatState {
  return { lastSentMs: 0 };
}

/**
 * Send a heartbeat IFF at least `intervalMs` has elapsed since the last attempt.
 * Mutates `state.lastSentMs` to the attempt time (BEFORE awaiting the send) so a slow
 * or failing request never bunches up duplicate sends on the next tick.
 */
export async function maybeSendHeartbeat(
  deps: HeartbeatDeps,
  state: HeartbeatState,
): Promise<void> {
  const nowMs = deps.now().getTime();
  if (nowMs - state.lastSentMs < deps.intervalMs) return; // throttle to the cadence
  state.lastSentMs = nowMs;
  const { pending, inflight } = deps.queue.stats();
  // Read the inventory HERE, at send time — see `connectorReports`. Omitted entirely when no thunk
  // is wired, because `undefined` and `[]` are different facts to the server (D-16.3-2).
  const connectors = deps.connectorReports?.();
  try {
    await (deps.post ?? postHeartbeat)(deps.url, deps.token, {
      queuePending: pending,
      queueInflight: inflight,
      collectorVersion: deps.collectorVersion,
      consecutiveSyncFailures: deps.consecutiveSyncFailures ?? 0,
      ...(connectors !== undefined ? { connectors } : {}),
    });
  } catch (e) {
    // The swallow STAYS (residual risk e) — `onError` only makes it observable, and must itself
    // never throw, or it would reintroduce exactly the stall the swallow exists to prevent.
    try {
      deps.onError?.(e);
    } catch {
      /* an observer that throws must not become the failure it was reporting */
    }
  }
}
