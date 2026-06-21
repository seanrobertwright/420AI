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
 */
export interface FileWatcherDeps {
  connectors: Connector[];
  home: string;
  queue: QueueStore;
  /** Called with the parsing connector + the complete-line prefix when a file grew. */
  onChange: (connector: Connector, prefixText: string) => void | Promise<void>;
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
    }
    return found;
  }

  /** One discovery + growth-detect + capture pass. */
  async tickOnce(): Promise<void> {
    const files = await this.discover();
    for (const { connector, path } of files) {
      const cursor = this.deps.queue.getCursor(connector.id, path);

      if ((connector.captureMode ?? "tail") === "snapshot") {
        // Whole-file-rewrite source (e.g. Gemini): re-read on a size/mtime
        // change. The cursor columns are repurposed — `byteOffset := sizeBytes`,
        // `size := mtimeMs` (see snapshot.ts). Commit-point ordering preserved:
        // saveCursor runs only AFTER onChange succeeds.
        const prev =
          cursor !== undefined ? { sizeBytes: cursor.byteOffset, mtimeMs: cursor.size } : undefined;
        const snap = readSnapshot(path, prev);
        if (!snap.changed) continue;
        await this.deps.onChange(connector, snap.text);
        this.deps.queue.saveCursor(connector.id, path, snap.sizeBytes, snap.mtimeMs);
        continue;
      }

      // Default: append-only tail by byte offset.
      const fromOffset = cursor?.byteOffset ?? 0;
      const result = readGrownPrefix(path, fromOffset);
      // `reset` (truncation) restarts from 0 inside the tailer; both reset and
      // ordinary growth set grew=true with the whole-file prefix.
      if (!result.grew) continue;
      await this.deps.onChange(connector, result.text);
      // Commit the cursor only after onChange succeeded.
      this.deps.queue.saveCursor(connector.id, path, result.newOffset, result.newOffset);
    }
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
