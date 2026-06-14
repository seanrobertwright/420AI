import { statSync, readFileSync } from "node:fs";

/**
 * Whole-file snapshot reader (PURE — the `captureMode: "snapshot"` sibling of
 * the byte-offset `readGrownPrefix` tailer).
 *
 * Some sources (Gemini CLI) REWRITE a single JSON file in place every turn
 * rather than appending, so the byte-offset tailer cannot read them correctly.
 * This reads the WHOLE file when its size or mtime changed since the last read,
 * and skips the read (cheap stat-only) when neither changed.
 *
 * Change detection repurposes the existing `file_cursors` columns (no schema
 * change): the watcher stores `byteOffset := sizeBytes` and `size := mtimeMs`.
 * The mtime/size gate is only an OPTIMIZATION — correctness comes from the
 * queue's content-hash dedup + the server's fingerprint upsert (M4 D4), so even
 * a missed gate re-sends idempotently.
 */
export interface SnapshotPrev {
  /** The file size (bytes) recorded at the last successful read. */
  sizeBytes: number;
  /** The file mtime (ms) recorded at the last successful read. */
  mtimeMs: number;
}

export interface SnapshotResult {
  /** Whole-file text when `changed`, otherwise "" (no read was performed). */
  text: string;
  /** Current file size in bytes (persist as the next cursor `byteOffset`). */
  sizeBytes: number;
  /** Current file mtime in ms, floored (persist as the next cursor `size`). */
  mtimeMs: number;
  /** True when size or mtime differs from `prev` (or `prev` is absent). */
  changed: boolean;
}

export function readSnapshot(path: string, prev?: SnapshotPrev): SnapshotResult {
  const stat = statSync(path);
  const sizeBytes = stat.size;
  // Floor mtime so the round-trip through the integer `size` cursor column is
  // lossless (sub-ms precision would never match on the next tick otherwise).
  const mtimeMs = Math.floor(stat.mtimeMs);

  if (prev && prev.sizeBytes === sizeBytes && Math.floor(prev.mtimeMs) === mtimeMs) {
    return { text: "", sizeBytes, mtimeMs, changed: false };
  }

  const text = readFileSync(path, "utf8");
  return { text, sizeBytes, mtimeMs, changed: true };
}
