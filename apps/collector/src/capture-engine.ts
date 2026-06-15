import { homedir } from "node:os";
import { toRawRecordPayload, toEventPayload } from "@420ai/shared";
import { QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore } from "./queue/queue-store.js";
import { connectors as defaultConnectors } from "./connectors/connector.js";
import type { Connector } from "./connectors/connector.js";
import { FileWatcher } from "./watcher/file-watcher.js";
import { syncOnce, runSyncLoop } from "./sync/sync-worker.js";

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

    await Promise.race([watcherLoop, syncLoop]);
    internal.abort(); // ensure the other loop unwinds too
    await Promise.allSettled([watcherLoop, syncLoop]);
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
