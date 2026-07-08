import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * The Cursor store read layer (M13 13.7). Cursor persists its agent conversations in
 * a SQLite database at `%APPDATA%\Cursor\User\globalStorage\state.vscdb`, in the
 * `cursorDiskKV` key/value table:
 *   - `composerData:<composerId>`     → one row per conversation ("composer")
 *   - `bubbleId:<composerId>:<bubbleId>` → one row per message ("bubble")
 *
 * Facts below were proven against the LIVE store during planning (2026-07-07):
 *   - a read-only open succeeds WHILE Cursor is running (WAL);
 *   - the composer sweep is cheap (383 rows / 14.3 MB total, max single 2.61 MB) —
 *     fine to run every poll;
 *   - the bubble corpus is NOT (195.9 MB total) — bubbles MUST be fetched per changed
 *     composer only, never swept whole;
 *   - 26 of 22368 bubble values are NULL — filtered out here (a composer may own 0);
 *   - the bubble key format is `bubbleId:<composerId>:<bubbleId>`, so a per-composer
 *     prefix fetch is exact.
 *
 * SECURITY: this layer reads `cursorDiskKV` ONLY. The sibling `ItemTable` holds ~43
 * secret-ish keys (aiSettings, tokens) and is NEVER queried — enforced by construction
 * (no function here references it). `node:sqlite` is the queue's engine already, so this
 * adds ZERO native dependencies.
 *
 * Library file (CLAUDE.md process boundaries): it never logs or exits. `openCursorStore`
 * throws if the DB can't be opened (absent/locked); the poll loop catches it and reports
 * the source as unavailable connector health, never a crash.
 */

/** A composer row: `id` is the `composerData:` key stripped of its prefix; `value` is the JSON blob. */
export interface CursorComposerRow {
  id: string;
  value: string;
}

/** A bubble row: the full `bubbleId:<composerId>:<bubbleId>` key + its JSON blob value. */
export interface CursorBubbleRow {
  key: string;
  value: string;
}

/** The read handle the poll capability drives. Close it when the pass is done. */
export interface CursorStoreReader {
  /** Sweep every composer (cheap top-level scan). */
  listComposers(): CursorComposerRow[];
  /** Fetch the bubbles for ONE composer (prefix match; NULL values filtered; may be empty). */
  bubblesFor(composerId: string): CursorBubbleRow[];
  close(): void;
}

const COMPOSER_PREFIX = "composerData:";

/** Default vscdb path — Windows-only store (Cursor keeps it under `%APPDATA%`). */
export function defaultCursorStorePath(): string {
  return join(process.env.APPDATA ?? "", "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * Coerce a `cursorDiskKV.value` cell to text. `node:sqlite` returns a BLOB column as a
 * `Uint8Array` (Cursor stores the JSON as a BLOB) and a TEXT column as a `string`; handle
 * both so a real store (BLOB) and a test fixture (either) read identically. NULLs are
 * excluded by the SQL, so a nullish cell here is defensive only.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

/**
 * Open the Cursor store read-only (proven safe while Cursor runs). Throws if the file is
 * absent or the open fails — the caller (the poll loop) wraps this in try/catch and treats
 * a failure as an unavailable source, not a fatal error.
 */
export function openCursorStore(path: string): CursorStoreReader {
  const db = new DatabaseSync(path, { readOnly: true });
  const composerStmt = db.prepare(
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE '${COMPOSER_PREFIX}%' AND value IS NOT NULL`,
  );
  // Per-composer bubble fetch (prefix match). `|| ? ||` binds the composerId into the LIKE
  // pattern, so the prefix is exact and never sweeps the whole 195.9 MB bubble corpus.
  const bubbleStmt = db.prepare(
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:' || ? || ':%' AND value IS NOT NULL`,
  );
  return {
    listComposers(): CursorComposerRow[] {
      const rows = composerStmt.all() as { key: string; value: unknown }[];
      return rows.map((r) => ({ id: r.key.slice(COMPOSER_PREFIX.length), value: asText(r.value) }));
    },
    bubblesFor(composerId: string): CursorBubbleRow[] {
      const rows = bubbleStmt.all(composerId) as { key: string; value: unknown }[];
      return rows.map((r) => ({ key: r.key, value: asText(r.value) }));
    },
    close(): void {
      db.close();
    },
  };
}
