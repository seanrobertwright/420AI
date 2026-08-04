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

/** M16 16.3 — the latest capture failure for one connector (collector-owned, D-16.3-7). */
export interface ConnectorErrorRecord {
  message: string;
  at: string; // ISO
  count: number;
}

/** Mirrors the ingest heartbeat schema's `lastErrorMessage` bound, so nothing is dropped in transit. */
const CONNECTOR_ERROR_MAX_LENGTH = 500;

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
    // M16 16.3: the LATEST capture error per connector, and a monotonic count. The collector is the
    // SOLE source of truth for these (D-16.3-7) — it rides the heartbeat to the archive, which
    // overwrites its copy wholesale and never accumulates its own, because two counters would
    // diverge across re-pairs and restarts and the operator would not know which to believe.
    // Latest-only, not a log: this is a health signal, and the durable evidence is the queue itself.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_errors (
        connector_id TEXT PRIMARY KEY,
        message      TEXT NOT NULL,
        at           TEXT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 1
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

  /**
   * Record a connector's capture failure (M16 16.3, F-16.3-2's reporting half). Upsert: the newest
   * message and timestamp win, `count` increments.
   *
   * THE MESSAGE IS TRUNCATED, and it may legitimately contain a FILE PATH — that path is usually
   * the whole diagnostic ("EACCES … open 'C:\\…\\session.jsonl'"), so it is kept deliberately. It
   * therefore travels to the archive on the heartbeat, which is recorded in
   * `docs/guide/data-boundary.md` as part of what a heartbeat carries. The bound mirrors the ingest
   * body schema's `maxLength: 500`, so a message that fits here is never silently dropped there.
   */
  recordConnectorError(connectorId: string, message: string, atIso?: string): void {
    const bounded =
      message.length > CONNECTOR_ERROR_MAX_LENGTH
        ? `${message.slice(0, CONNECTOR_ERROR_MAX_LENGTH - 1)}…`
        : message;
    this.db
      .prepare(
        `INSERT INTO connector_errors (connector_id, message, at, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(connector_id) DO UPDATE SET
           message = excluded.message,
           at = excluded.at,
           count = connector_errors.count + 1`,
      )
      .run(connectorId, bounded, atIso ?? this.now().toISOString());
  }

  /**
   * Clear a connector's error after a SUCCESSFUL capture (M16 16.3, PR #77 review).
   *
   * WITHOUT THIS, ONE TRANSIENT ERROR IS PERMANENT, and the mechanism is worth stating because it is
   * not obvious. `classifyDeclared` decides `erroring` by `lastErrorAt >= lastEventAt` — but those
   * are two DIFFERENT clocks: `lastErrorAt` is the collector's wall clock, while `lastEventAt` is
   * `max(events.ts)`, the CONTENT timestamp. For the export connectors that content is the original
   * conversation date, routinely weeks old. So after a single EACCES, every subsequent SUCCESSFUL
   * import still lands events dated before the error, the predicate stays true forever, and the
   * connector reads "Needs attention" for good — unfixable without hand-editing `queue.sqlite`.
   * A scorecard that cannot clear a resolved fault trains the operator to ignore red, which is the
   * same "cry wolf" failure D-16.3-4 avoids for `silent`.
   *
   * Deletes rather than zeroing: `errorCount` is a count of the CURRENT fault, not a lifetime
   * tally, and D-16.3-7 makes the collector its only source of truth. The archive's copy is
   * overwritten wholesale on the next heartbeat, so the row disappears there too.
   */
  clearConnectorError(connectorId: string): void {
    this.db.prepare(`DELETE FROM connector_errors WHERE connector_id = ?`).run(connectorId);
  }

  /** The latest error per connector, keyed by connector id. Empty when nothing has ever failed. */
  connectorErrors(): Map<string, ConnectorErrorRecord> {
    const rows = this.db
      .prepare(`SELECT connector_id, message, at, count FROM connector_errors`)
      .all() as { connector_id: string; message: string; at: string; count: number }[];
    return new Map(
      rows.map((r) => [r.connector_id, { message: r.message, at: r.at, count: r.count }]),
    );
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
