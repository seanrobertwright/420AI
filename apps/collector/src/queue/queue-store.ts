import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable, disk-backed outbound queue + per-file capture cursors, using Node 24's
 * built-in `node:sqlite` (zero native build). A sibling of M1's `SqliteStore` —
 * same conventions: `new DatabaseSync(path)`, WAL pragma, `CREATE TABLE IF NOT
 * EXISTS`, prepared statements, synchronous single-threaded API, `close()`.
 *
 * Two tables:
 *   queue_items   — outbound raw/event payloads, deduped by (kind, dedup_key),
 *                   with a claim/ack/retry/backoff state machine.
 *   file_cursors  — per (connector_id, path) byte-offset + size, so a restart
 *                   resumes instead of re-sending.
 *
 * SINGLE-WRITER: one collector daemon owns this DB. `node:sqlite` is synchronous
 * and single-threaded, so claim (SELECT-then-UPDATE) has no interleaving window.
 *
 * The local queue is a transient OUTBOX, not an archive — the sacred raw copy
 * lives server-side. `ack` therefore DELETEs rows so the queue stays small.
 *
 * NOTE: `node:sqlite` is experimental in Node 24 and prints an ExperimentalWarning
 * on import. That is expected — do not suppress it in a way that breaks tests.
 */

const EPOCH = "1970-01-01T00:00:00.000Z";
const BACKOFF_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 1000;

export type QueueKind = "raw" | "event";
export type SyncOutcome = "ok" | "retry" | "stop";
export type EnqueueResult = "inserted" | "updated" | "noop";

/** A claimed queue row, ready to be grouped into an IngestBatch and POSTed. */
export interface QueueRow {
  id: number;
  kind: QueueKind;
  dedupKey: string;
  payloadJson: string;
  attempts: number;
}

export interface QueueStats {
  pending: number;
  inflight: number;
}

export interface FileCursor {
  byteOffset: number;
  size: number;
}

export class QueueStore {
  private db: DatabaseSync;

  constructor(
    path: string,
    private now: () => Date = () => new Date(),
  ) {
    // node:sqlite won't create missing parent dirs → "unable to open database file". Ensure the
    // collector home exists first (mirrors saveCredentials' mkdir), so a fresh `--home` works before
    // pairing. `:memory:` has no real dirname — skip it.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT '${EPOCH}',
        UNIQUE(kind, dedup_key)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_cursors (
        connector_id TEXT NOT NULL,
        path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connector_id, path)
      );
    `);
    // M13 13.7: per-key content memory for POLL-mode connectors (Cursor). Distinct from
    // file_cursors (byte offsets for tailed files) — this stores a content hash per polled
    // unit so an unchanged unit can skip its expensive detail fetch. Like file_cursors, it
    // survives `ack` (which DELETEs synced queue_items), so the skip persists across syncs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poll_state (
        connector_id TEXT NOT NULL,
        key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connector_id, key)
      );
    `);
  }

  /**
   * Insert-once for immutable raw; update-and-reset-pending only when content
   * changed. The `WHERE content_hash <> excluded.content_hash` makes an unchanged
   * re-enqueue a true no-op (no status reset, no re-send).
   */
  enqueue(kind: QueueKind, dedupKey: string, payload: unknown): EnqueueResult {
    const json = JSON.stringify(payload);
    const hash = createHash("sha256").update(json).digest("hex");
    const prev = this.db
      .prepare(`SELECT content_hash FROM queue_items WHERE kind = ? AND dedup_key = ?`)
      .get(kind, dedupKey) as { content_hash: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO queue_items (kind, dedup_key, content_hash, payload_json, status, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, 'pending', 0, '${EPOCH}')
         ON CONFLICT(kind, dedup_key) DO UPDATE SET
           content_hash = excluded.content_hash,
           payload_json = excluded.payload_json,
           status = 'pending',
           attempts = 0,
           next_attempt_at = '${EPOCH}'
         WHERE queue_items.content_hash <> excluded.content_hash`,
      )
      .run(kind, dedupKey, hash, json);
    if (!prev) return "inserted";
    return prev.content_hash === hash ? "noop" : "updated";
  }

  /**
   * Claim up to `limit` due-and-pending items, flipping them to `inflight` so a
   * concurrent/next claim does not re-fetch them. Backed-off items
   * (`next_attempt_at` in the future) are excluded until their time arrives.
   */
  claimBatch(limit: number): QueueRow[] {
    const now = this.now().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, kind, dedup_key AS dedupKey, payload_json AS payloadJson, attempts
         FROM queue_items
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(now, limit) as unknown as QueueRow[];
    if (rows.length === 0) return [];
    const flip = this.db.prepare(`UPDATE queue_items SET status = 'inflight' WHERE id = ?`);
    for (const r of rows) flip.run(r.id);
    return rows;
  }

  /** Acknowledge successfully-synced items by DELETING them (outbox stays small). */
  ack(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM queue_items WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  /** Network/5xx failure: back off with capped exponential delay, return to pending. */
  markFailed(id: number, attempts: number): void {
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
    const next = new Date(this.now().getTime() + delay).toISOString();
    this.db
      .prepare(
        `UPDATE queue_items SET status = 'pending', attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`,
      )
      .run(next, id);
  }

  /** 401 path: return inflight items to pending WITHOUT bumping attempts (no backoff). */
  releaseInflight(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE queue_items SET status = 'pending' WHERE id = ? AND status = 'inflight'`,
    );
    for (const id of ids) stmt.run(id);
  }

  /** Boot recovery: any item left `inflight` by a crash mid-send returns to pending. */
  recoverInflight(): void {
    this.db.exec(`UPDATE queue_items SET status = 'pending' WHERE status = 'inflight'`);
  }

  getCursor(connectorId: string, path: string): FileCursor | undefined {
    const row = this.db
      .prepare(
        `SELECT byte_offset AS byteOffset, size FROM file_cursors WHERE connector_id = ? AND path = ?`,
      )
      .get(connectorId, path) as FileCursor | undefined;
    return row;
  }

  saveCursor(connectorId: string, path: string, byteOffset: number, size: number): void {
    this.db
      .prepare(
        `INSERT INTO file_cursors (connector_id, path, byte_offset, size, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connector_id, path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           size = excluded.size,
           updated_at = excluded.updated_at`,
      )
      .run(connectorId, path, byteOffset, size, this.now().toISOString());
  }

  /**
   * Persistent change memory for POLL-mode connectors (M13 13.7). A poll connector re-observes
   * its whole store each tick; `poll_state` records the last-seen content hash per unit (e.g. a
   * Cursor composer) so an UNCHANGED unit can skip the expensive detail fetch + parse. Unlike
   * `queue_items`, it survives `ack` (which DELETEs synced rows), so the skip holds across syncs —
   * not just before the unit's first sync.
   *
   * `pollChanged`/`pollCommit` are SPLIT (not one `observe`) to preserve the FileWatcher's
   * commit-point ordering (file-watcher.ts): the caller records the observation via `pollCommit`
   * ONLY AFTER the enqueue succeeds, so a transient failure between the check and the enqueue
   * leaves the unit un-committed and it is retried next tick (recording on the read would strand
   * the unit until its content changed again — a data-completeness bug).
   */
  pollChanged(connectorId: string, key: string, content: string): boolean {
    const hash = createHash("sha256").update(content).digest("hex");
    const prev = this.db
      .prepare(`SELECT content_hash FROM poll_state WHERE connector_id = ? AND key = ?`)
      .get(connectorId, key) as { content_hash: string } | undefined;
    return prev?.content_hash !== hash;
  }

  /** Record `content`'s hash as the last-seen observation for `(connectorId, key)` (see `pollChanged`). */
  pollCommit(connectorId: string, key: string, content: string): void {
    const hash = createHash("sha256").update(content).digest("hex");
    this.db
      .prepare(
        `INSERT INTO poll_state (connector_id, key, content_hash, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connector_id, key) DO UPDATE SET
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(connectorId, key, hash, this.now().toISOString());
  }

  stats(): QueueStats {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'pending'), 0) AS pending,
           COALESCE(SUM(status = 'inflight'), 0) AS inflight
         FROM queue_items`,
      )
      .get() as { pending: number; inflight: number };
    return { pending: Number(row.pending), inflight: Number(row.inflight) };
  }

  close(): void {
    this.db.close();
  }
}
