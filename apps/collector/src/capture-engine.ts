import { homedir } from "node:os";
import { toRawRecordPayload, toEventPayload } from "@420ai/shared";
import { QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore } from "./queue/queue-store.js";
import { connectors as defaultConnectors } from "./connectors/connector.js";
import type { Connector } from "./connectors/connector.js";
import { FileWatcher } from "./watcher/file-watcher.js";
import { syncOnce, runSyncLoop } from "./sync/sync-worker.js";
import { captureGitCommits } from "./discovery/git-capture.js";
import { postGit } from "./ingest-client.js";

/** Default git-sweep cadence: a SLOW background sweep (commits change far less often than sessions). */
const DEFAULT_GIT_INTERVAL_MS = 5 * 60_000;

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

  log(
    `watching ${connectors.length} connector(s) under ${home}; syncing to ${opts.creds.url}`,
  );

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
        onStop: () => {
          log("ingest returned 401 — token revoked. Re-pair needed: `collector pair <code>`. Stopping sync.");
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

    await Promise.race([watcherLoop, syncLoop]);
    internal.abort(); // ensure the other loops unwind too
    await Promise.allSettled([watcherLoop, syncLoop, gitLoop]);
    opts.signal.removeEventListener("abort", onExternalAbort);

    // Best-effort final drain of anything captured but not yet sent.
    log("draining queue before exit…");
    let outcome = await syncOnce({ queue, url: opts.creds.url, token: opts.creds.token });
    while (outcome === "ok" && queue.stats().pending > 0) {
      outcome = await syncOnce({ queue, url: opts.creds.url, token: opts.creds.token });
    }
    const remaining = queue.stats().pending;
    log(remaining === 0 ? "queue drained." : `stopped with ${remaining} item(s) still queued.`);
  } finally {
    queue.close();
  }
}
