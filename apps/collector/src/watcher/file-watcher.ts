import { glob } from "node:fs/promises";
import type { Connector } from "../connectors/connector.js";
import type { QueueStore } from "../queue/queue-store.js";
import { readGrownPrefix } from "./tailer.js";
import { readSnapshot } from "./snapshot.js";

/**
 * Poll-based session-file watcher (V1 — see plan Decisions).
 *
 * `fs.watch` fires on Windows but leaves a libuv teardown hazard on abrupt exit;
 * stat-based polling is deterministic, trivially unit-testable (`tickOnce`),
 * portable, and dependency-free. Each tick:
 *   1. glob-discover every connector's session files (picks up NEW files),
 *   2. for each file: read the complete-line prefix that appeared since the
 *      saved byte-offset cursor,
 *   3. on growth, hand the connector + prefix to `onChange`, THEN persist the
 *      cursor — so `onChange` (enqueue) is the commit point: if it throws, the
 *      cursor is not advanced and the lines are retried next tick.
 *
 * ERROR ISOLATION IS PER FILE, AND THE MECHANISM IS THE `try/catch` INSIDE `tickOnce`'s LOOP
 * (M16 16.3, F-16.3-2). Until that fix, step 3's promise above was a lie of exactly the 15.5 kind:
 * a throw from `onChange`/`readGrownPrefix` rejected the tick, rejected `runLoop`, and rejected the
 * `Promise.race([watcherLoop, syncLoop])` in `capture-engine.ts`, so there WAS no next tick — one
 * connector's bad file killed capture for every connector. The catch must stay per FILE and not
 * around the loop or `tickOnce`: a loop-level catch skips every remaining file in that tick, which
 * is the same outage one file smaller. `discover()` is wrapped per CONNECTOR for the same reason
 * (a glob over an unreadable directory throws), attributing the failure to the connector whose
 * pattern was being globbed. Both routes through `report()`, which guards the REPORTER — an
 * `onError` that throws would otherwise re-arm the exact unwind this fix removes.
 *
 * THE TRADE, STATED HONESTLY: a permanently failing file now retries forever instead of crashing
 * loudly. That is the right trade only BECAUSE the error is now reported — it reaches
 * `connector_errors` in the local queue, rides the heartbeat, and renders as `erroring` on the
 * capture health scorecard, which is strictly more visible than a dead process. It is a trade, not
 * a free win.
 */
export interface FileWatcherDeps {
  connectors: Connector[];
  home: string;
  queue: QueueStore;
  /** Called with the parsing connector + the complete-line prefix when a file grew. */
  onChange: (connector: Connector, prefixText: string) => void | Promise<void>;
  /**
   * Called instead of throwing when one connector's file (or glob) fails. Optional so existing
   * callers are unaffected; the capture engine wires it to the local `connector_errors` store.
   */
  onError?: (connector: Connector, err: unknown) => void;
}

export interface DiscoveredFile {
  connector: Connector;
  path: string;
}

export class FileWatcher {
  constructor(private deps: FileWatcherDeps) {}

  /** Glob every connector's watch patterns; return each matched file + its connector. */
  async discover(): Promise<DiscoveredFile[]> {
    const found: DiscoveredFile[] = [];
    const seen = new Set<string>();
    for (const connector of this.deps.connectors) {
      // Per CONNECTOR, so an unreadable directory under one connector's patterns does not hide
      // every other connector's files — and the error is attributed to the right connector.
      try {
        for (const pattern of connector.watchGlobs(this.deps.home)) {
          // glob is minimatch-style: use forward slashes even on Windows.
          const normalized = pattern.replace(/\\/g, "/");
          for await (const match of glob(normalized)) {
            const path = String(match);
            const key = `${connector.id} ${path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ connector, path });
          }
        }
      } catch (err) {
        this.report(connector, err);
      }
    }
    return found;
  }

  /**
   * Report a capture failure WITHOUT letting the reporter become one.
   *
   * `onError` is wired to a `queue.sqlite` write (`recordConnectorError` in capture-engine.ts), and
   * a sqlite write is not infallible — a locked or full database, or a handle closed during
   * shutdown, throws. An unguarded call here would reject `tickOnce`, reject `runLoop`, and reject
   * `Promise.race([watcherLoop, syncLoop])`: F-16.3-2 restored, reachable exactly when a connector
   * is ALREADY failing, i.e. the moment the scorecard is supposed to start working. `heartbeat.ts`
   * carries this same guard for the same reason.
   */
  private report(connector: Connector, err: unknown): void {
    try {
      this.deps.onError?.(connector, err);
    } catch {
      /* an error reporter that throws must not become the outage it was reporting */
    }
  }

  /** One discovery + growth-detect + capture pass. */
  async tickOnce(): Promise<void> {
    const files = await this.discover();
    for (const { connector, path } of files) {
      // PER FILE (F-16.3-2) — see the header. Not around this loop, and not around `tickOnce`.
      try {
        await this.captureFile(connector, path);
      } catch (err) {
        this.report(connector, err);
        // The cursor was NOT committed (it is written only after `onChange` resolves), so these
        // lines genuinely retry on the next tick — and there now IS a next tick.
      }
    }
  }

  /** Capture one discovered file. Throws on failure; `tickOnce` is what isolates it. */
  private async captureFile(connector: Connector, path: string): Promise<void> {
    const cursor = this.deps.queue.getCursor(connector.id, path);

    if ((connector.captureMode ?? "tail") === "snapshot") {
      // Whole-file-rewrite source (e.g. Gemini): re-read on a size/mtime
      // change. The cursor columns are repurposed — `byteOffset := sizeBytes`,
      // `size := mtimeMs` (see snapshot.ts). Commit-point ordering preserved:
      // saveCursor runs only AFTER onChange succeeds.
      const prev =
        cursor !== undefined ? { sizeBytes: cursor.byteOffset, mtimeMs: cursor.size } : undefined;
      const snap = readSnapshot(path, prev);
      if (!snap.changed) return;
      await this.deps.onChange(connector, snap.text);
      this.deps.queue.saveCursor(connector.id, path, snap.sizeBytes, snap.mtimeMs);
      return;
    }

    // Default: append-only tail by byte offset.
    const fromOffset = cursor?.byteOffset ?? 0;
    const result = readGrownPrefix(path, fromOffset);
    // `reset` (truncation) restarts from 0 inside the tailer; both reset and
    // ordinary growth set grew=true with the whole-file prefix.
    if (!result.grew) return;
    await this.deps.onChange(connector, result.text);
    // Commit the cursor only after onChange succeeded.
    this.deps.queue.saveCursor(connector.id, path, result.newOffset, result.newOffset);
  }

  /** Poll forever until `signal` aborts. */
  async runLoop(signal: AbortSignal, intervalMs = 1500): Promise<void> {
    while (!signal.aborted) {
      await this.tickOnce();
      if (signal.aborted) break;
      await this.delay(intervalMs, signal);
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
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
}
