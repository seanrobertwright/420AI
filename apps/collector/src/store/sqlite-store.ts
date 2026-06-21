import { DatabaseSync } from "node:sqlite";
import type { NormalizedEvent, NormalizedTokens, CostResult } from "@420ai/shared";

/**
 * Local SQLite store using Node 24's built-in `node:sqlite` (zero native build).
 *
 * Schema is a deliberate mirror of the future Postgres/JSONB archive:
 * relational columns for what the report queries now (session_id, model, ts),
 * JSON columns for token/cost/payload that get promoted to real columns in
 * later milestones. Raw records are sacred — stored verbatim, never mutated.
 *
 * Events upsert by `fingerprint` so re-ingesting the same data is idempotent
 * (PRD §23).
 *
 * NOTE: `node:sqlite` is experimental in Node 24 and prints an
 * ExperimentalWarning on import. That is expected — do not suppress it in a way
 * that breaks tests. The API is synchronous.
 */
export class SqliteStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_source_records (
        id TEXT PRIMARY KEY,
        source_connector TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        fingerprint TEXT PRIMARY KEY,
        source_connector TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        raw_record_id TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_path TEXT,
        git_branch TEXT,
        model TEXT,
        ts TEXT NOT NULL,
        tokens_json TEXT,
        cost_json TEXT,
        payload_json TEXT
      );
    `);
  }

  /** Insert raw records, ignoring any whose id already exists (raw is immutable). */
  insertRawRecords(
    records: readonly {
      id: string;
      sourceConnector: string;
      sessionId: string;
      ingestedAt: string;
      payload: string;
    }[],
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO raw_source_records
        (id, source_connector, session_id, ingested_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const r of records) {
      stmt.run(r.id, r.sourceConnector, r.sessionId, r.ingestedAt, r.payload);
    }
  }

  /** Upsert events by fingerprint — idempotent re-ingest (PRD §23). */
  upsertEvents(events: readonly NormalizedEvent[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO events
        (fingerprint, source_connector, parser_version, raw_record_id, event_index,
         event_type, session_id, project_path, git_branch, model, ts,
         tokens_json, cost_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        parser_version = excluded.parser_version,
        tokens_json    = excluded.tokens_json,
        cost_json      = excluded.cost_json,
        payload_json   = excluded.payload_json
    `);
    for (const e of events) {
      stmt.run(
        e.fingerprint,
        e.sourceConnector,
        e.parserVersion,
        e.rawRecordId,
        e.eventIndex,
        e.eventType,
        e.sessionId,
        e.projectPath ?? null,
        e.gitBranch ?? null,
        e.model ?? null,
        e.ts,
        e.tokens ? JSON.stringify(e.tokens) : null,
        e.cost ? JSON.stringify(e.cost) : null,
        e.payload !== undefined ? JSON.stringify(e.payload) : null,
      );
    }
  }

  /** Fetch all events for a session, ordered by ts, JSON columns rehydrated. */
  getSessionEvents(sessionId: string): NormalizedEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY ts, event_index`)
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEvent(row));
  }

  /** Summary of stored sessions for CLI help. */
  listSessions(): { sessionId: string; model: string | null; eventCount: number }[] {
    const rows = this.db
      .prepare(
        `
        SELECT session_id AS sessionId,
               MAX(model) AS model,
               COUNT(*) AS eventCount
        FROM events
        GROUP BY session_id
        ORDER BY MIN(ts)
      `,
      )
      .all() as { sessionId: string; model: string | null; eventCount: number }[];
    return rows;
  }

  close(): void {
    this.db.close();
  }

  private rowToEvent(row: Record<string, unknown>): NormalizedEvent {
    const tokensJson = row["tokens_json"] as string | null;
    const costJson = row["cost_json"] as string | null;
    const payloadJson = row["payload_json"] as string | null;
    return {
      fingerprint: row["fingerprint"] as string,
      sourceConnector: row["source_connector"] as string,
      parserVersion: row["parser_version"] as string,
      rawRecordId: row["raw_record_id"] as string,
      eventIndex: row["event_index"] as number,
      eventType: row["event_type"] as NormalizedEvent["eventType"],
      sessionId: row["session_id"] as string,
      projectPath: (row["project_path"] as string | null) ?? undefined,
      gitBranch: (row["git_branch"] as string | null) ?? undefined,
      model: (row["model"] as string | null) ?? undefined,
      ts: row["ts"] as string,
      tokens: tokensJson ? (JSON.parse(tokensJson) as NormalizedTokens) : undefined,
      cost: costJson ? (JSON.parse(costJson) as CostResult) : undefined,
      payload: payloadJson ? JSON.parse(payloadJson) : undefined,
    };
  }
}
