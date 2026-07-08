import { homedir } from "node:os";
import { toRawRecordPayload, toEventPayload } from "@420ai/shared";
import { QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore, type SyncOutcome } from "./queue/queue-store.js";
import { connectors as defaultConnectors } from "./connectors/connector.js";
import type { Connector, PollContext } from "./connectors/connector.js";
import { FileWatcher } from "./watcher/file-watcher.js";
import { syncOnce, runSyncLoop } from "./sync/sync-worker.js";
import { captureGitCommits } from "./discovery/git-capture.js";
import { postGit } from "./ingest-client.js";

/** Default git-sweep cadence: a SLOW background sweep (commits change far less often than sessions). */
const DEFAULT_GIT_INTERVAL_MS = 5 * 60_000;

/**
 * Hard cap on the best-effort shutdown drain (C.8 fix). On SIGINT the engine flushes what it can,
 * but must NEVER block exit draining a huge backlog or waiting on a stalled archive — the durable
 * queue keeps undelivered items for the next start, so leaving them is safe. Without this bound a
 * Ctrl-C on a large queue (e.g. ~200k pending) drained the WHOLE backlog before `queue.close()`,
 * hanging exit for minutes and holding the SQLite handle ("locks the database").
 */
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * Best-effort queue drain bounded by a wall-clock deadline. Drains while the archive keeps
 * accepting ("ok") and items remain, but STOPS at the deadline so shutdown can never hang on a
 * large backlog or a stalled archive (C.8). Undelivered items stay queued (durable, recovered on
 * next start). Pure with an injectable clock so it is unit-testable without infra.
 */
export async function drainBeforeExit(
  sync: (timeoutMs: number) => Promise<SyncOutcome>,
  pending: () => number,
  opts: { deadlineMs: number; now?: () => number },
): Promise<void> {
  const now = opts.now ?? ((): number => Date.now());
  const deadline = now() + opts.deadlineMs;
  // Give EACH call only the budget left until the deadline, so even one stalled call can't run past
  // it (its request times out at `remaining`). This HARD-bounds the whole drain to deadlineMs — a
  // between-calls deadline check alone allowed ~2× (a call starting just before the deadline could
  // still run its own full timeout).
  let remaining = opts.deadlineMs;
  let outcome = await sync(remaining);
  while (outcome === "ok" && pending() > 0 && (remaining = deadline - now()) > 0) {
    outcome = await sync(remaining);
  }
}

/**
 * The capture engine wires the proven primitives into the `collector watch`
 * daemon: identity → durable queue → connectors → poll watcher → sync worker.
 *
 * Library file — no direct stdout. It talks via the optional `logger` callback
 * (wired by cli.ts). On SIGINT (the injected AbortSignal aborts) it stops both
 * loops, does a best-effort final drain, and always closes the DB.
 */
export interface CaptureEngineOptions {
  creds: Credentials;
  signal: AbortSignal;
  queuePath?: string;
  home?: string;
  intervalMs?: number;
  connectors?: Connector[];
  logger?: (msg: string) => void;
  /** M9: collector version (read from package.json by cli.ts) — enables heartbeats. */
  collectorVersion?: string;
  /** M9: heartbeat cadence; default 30 s in the sync loop. */
  heartbeatIntervalMs?: number;
  /** M10: git-sweep cadence (default 5 min). Set to 0 to disable the background git sweep. */
  gitIntervalMs?: number;
  /** M13 13.1: called with an ISO timestamp after each successful sync drain (serve.ts wires this to the StatusBar's `lastSyncAt`). */
  onSyncSuccess?: (at: string) => void;
}

/**
 * An abortable sleep. The abort listener + timer are armed SYNCHRONOUSLY (before
 * any await elsewhere can interleave), so an abort during a sweep clears the timer
 * cleanly — no leaked timer (CLAUDE.md long-lived-resource rule).
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Slow background git-outcome sweep (M10). Best-effort: a git/network error NEVER
 * stops capture (caught + ignored). Runs an immediate sweep then repeats every
 * `intervalMs` until the signal aborts. POSTs commits directly (idempotent by SHA
 * server-side) — it does not enqueue, keeping the durable queue session-only.
 */
async function gitSweepLoop(
  opts: {
    connectors: Connector[];
    home: string;
    url: string;
    token: string;
    intervalMs: number;
    log: (msg: string) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const { commits } = await captureGitCommits({ connectors: opts.connectors, home: opts.home });
      if (commits.length > 0) {
        const res = await postGit(opts.url, opts.token, { commits });
        if (res.commitsInserted > 0) {
          opts.log(`git: captured ${res.commitsInserted} new commit(s)`);
        }
      }
    } catch {
      // Best-effort by contract: never let a git/network error stop session capture.
    }
    await abortableDelay(opts.intervalMs, signal);
  }
}

/**
 * M13 13.7: best-effort poll loop for a POLL-mode connector (Cursor). Mirrors
 * `gitSweepLoop`: an immediate pass then a repeat every `poll.intervalMs` until the
 * signal aborts, with a poll/store error NEVER stopping capture (caught + ignored). Each
 * pass sweeps the connector's store paths; the connector's `run` fetches detail + parses
 * only CHANGED units (via the persistent `queue.pollChanged` gate) and enqueues them onto
 * the SAME durable queue the watcher feeds, so the sync loop drains poll + watch uniformly.
 */
export async function pollLoop(
  opts: {
    connector: Connector;
    home: string;
    queue: QueueStore;
    log: (msg: string) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  const poll = opts.connector.poll;
  if (!poll) return;
  const ctx: PollContext = {
    changed: (key, content) => opts.queue.pollChanged(opts.connector.id, key, content),
    enqueue: (result) => {
      for (const r of result.rawRecords) {
        opts.queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
      }
      for (const e of result.events) {
        opts.queue.enqueue("event", e.fingerprint, toEventPayload(e));
      }
    },
    commit: (key, content) => opts.queue.pollCommit(opts.connector.id, key, content),
  };
  while (!signal.aborted) {
    try {
      for (const path of poll.sources(opts.home)) {
        if (signal.aborted) break;
        const outcome = poll.run(path, ctx);
        if (outcome.changed > 0) {
          opts.log(
            `${opts.connector.id}: ${outcome.changed}/${outcome.swept} session(s) changed → ` +
              `${outcome.rawRecords} record(s), ${outcome.events} event(s)`,
          );
        }
      }
    } catch {
      // Best-effort by contract: never let a poll/store error stop session capture.
    }
    await abortableDelay(poll.intervalMs, signal);
  }
}

export async function runCaptureEngine(opts: CaptureEngineOptions): Promise<void> {
  const log = opts.logger ?? (() => {});
  const queue = new QueueStore(opts.queuePath ?? QUEUE_PATH);
  const home = opts.home ?? homedir();
  const connectors = opts.connectors ?? defaultConnectors;

  // Boot recovery: re-send anything a crash left mid-flight.
  queue.recoverInflight();

  const onChange = (connector: Connector, text: string): void => {
    const parsed = connector.parse(text);
    for (const r of parsed.rawRecords) {
      queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
    }
    for (const e of parsed.events) {
      queue.enqueue("event", e.fingerprint, toEventPayload(e));
    }
  };

  const watcher = new FileWatcher({ connectors, home, queue, onChange });

  log(`watching ${connectors.length} connector(s) under ${home}; syncing to ${opts.creds.url}`);

  try {
    // Run watcher + sync loops concurrently. A fatal 401 ("stop") or SIGINT ends
    // one; we abort the other so both unwind. Use an internal controller chained
    // to the external signal so a 401 can also stop the watcher.
    const internal = new AbortController();
    const onExternalAbort = () => internal.abort();
    opts.signal.addEventListener("abort", onExternalAbort, { once: true });

    const watcherLoop = watcher.runLoop(internal.signal, opts.intervalMs);
    const syncLoop = runSyncLoop(
      {
        queue,
        url: opts.creds.url,
        token: opts.creds.token,
        // M9: pass the version through so the sync loop sends heartbeats (best-effort).
        collectorVersion: opts.collectorVersion,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
        onSync: opts.onSyncSuccess,
        onStop: () => {
          log(
            "ingest returned 401 — token revoked. Re-pair needed: `collector pair <code>`. Stopping sync.",
          );
          internal.abort();
        },
      },
      internal.signal,
    );

    // M10: best-effort slow git sweep alongside the watcher/sync loops. NOT part of
    // the race (it is infinite + best-effort) — it unwinds when internal aborts.
    const gitIntervalMs = opts.gitIntervalMs ?? DEFAULT_GIT_INTERVAL_MS;
    const gitLoop =
      gitIntervalMs > 0
        ? gitSweepLoop(
            {
              connectors,
              home,
              url: opts.creds.url,
              token: opts.creds.token,
              intervalMs: gitIntervalMs,
              log,
            },
            internal.signal,
          )
        : Promise.resolve();

    // M13 13.7: a best-effort poll loop per POLL-mode connector (Cursor). Like the git
    // sweep, these are NOT part of the race (infinite + best-effort) — they unwind when
    // `internal` aborts. Absent any poll connector (the default until Cursor is approved),
    // this is an empty array and the behavior is byte-identical to before.
    const pollLoops = connectors
      .filter((c) => c.poll)
      .map((c) => pollLoop({ connector: c, home, queue, log }, internal.signal));

    await Promise.race([watcherLoop, syncLoop]);
    internal.abort(); // ensure the other loops unwind too
    await Promise.allSettled([watcherLoop, syncLoop, gitLoop, ...pollLoops]);
    opts.signal.removeEventListener("abort", onExternalAbort);

    // Best-effort final drain of anything captured but not yet sent — bounded by SHUTDOWN_DRAIN_MS
    // so a huge backlog or a stalled archive can never hang exit (C.8). Leftover items stay queued.
    log("draining queue before exit…");
    await drainBeforeExit(
      // Each drain POST is bounded by the budget REMAINING until the deadline, so even a single
      // stalled archive connection can't outlast it (the between-calls check alone can't interrupt a
      // hung fetch — C.8).
      (timeoutMs) =>
        syncOnce({
          queue,
          url: opts.creds.url,
          token: opts.creds.token,
          timeoutMs,
        }),
      () => queue.stats().pending,
      { deadlineMs: SHUTDOWN_DRAIN_MS },
    );
    const remaining = queue.stats().pending;
    log(remaining === 0 ? "queue drained." : `stopped with ${remaining} item(s) still queued.`);
  } finally {
    queue.close();
  }
}
