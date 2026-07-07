import { and, asc, eq, inArray } from "drizzle-orm";
import {
  parseClaudeCodeSession,
  parseCodexSession,
  toRawRecordPayload,
  toEventPayload,
  CLAUDE_CODE_CONNECTOR,
  CODEX_CLI_CONNECTOR,
  GEMINI_CLI_CONNECTOR,
  type IngestBatch,
  type ModelPricing,
  type ParseResult,
} from "@420ai/shared";
import type { Db } from "../client.js";
import { decryptField } from "../crypto.js";
import { events, rawSourceRecords } from "../schema.js";
import { ingestBatch } from "./ingest.js";

/**
 * M13 13.3 — the archive re-parse engine (PRD §23 / 12.5b). Re-derives every
 * session's events from its SACRED raw records under the CURRENT parsers (which
 * live in @420ai/shared precisely so this engine runs the same code the
 * collector runs at capture time):
 *
 *   decrypt raw payloads → reassemble the parser's whole-file input → re-parse →
 *   `ingestBatch` upsert-by-fingerprint (re-stamps parser/catalog versions,
 *   re-prices under an active catalog) → orphan-event GC.
 *
 * The GC is the 12.7a debt: a parser bump can change an event's TYPE (Codex
 * 2.0.0 turns some `tool.call.completed` into `tool.call.failed`), and the type
 * is a fingerprint input — the fresh parse INSERTS the new fingerprint while the
 * stale-typed row lingers. `ingestBatch` never deletes, so after the upsert we
 * delete, per re-parsed raw record, every event fingerprint the fresh parse no
 * longer produces.
 *
 * Scope (D-M13-2): Claude Code + Codex only. Gemini raw records are per-message
 * re-serializations that cannot reconstruct the parser's whole-file input (the
 * session envelope startTime/lastUpdated/projectHash is not stored) — Gemini
 * sessions are SKIPPED and reported (`skipped.gemini`), never silently dropped.
 * Custom-connector sessions have no shared parser either → `skipped.other`.
 *
 * Batch discipline mirrors reprice: one `ingestBatch` transaction per session,
 * never one mega-transaction. Raw records stay immutable throughout (the
 * re-parsed raw upsert is `ON CONFLICT DO NOTHING` on the idempotency key).
 * Silent library (CLAUDE.md): a decrypt/key error throws loudly, never logs.
 */

export interface ReparseResult {
  /** Sessions actually re-parsed (per machine — raw is per-machine). */
  sessions: number;
  eventsUpserted: number;
  orphansDeleted: number;
  skipped: { gemini: number; other: number };
}

/** IN/NOT-IN list chunk size — bounds bound-param counts on big sessions. */
const CHUNK = 500;

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/**
 * Reassemble a Codex rollout's file text from its decrypted raw records. The
 * stored `sourceRecordId` is `"${sessionId}:${lineIndex}"` (verified format), so
 * each payload goes back to its ORIGINAL line index, with gaps left as empty
 * lines (originally blank/malformed lines were skipped but still consumed an
 * index). This makes the re-parse assign byte-identical rawRecordIds — and
 * therefore identical fingerprints — to unchanged events, and preserves the
 * turn_context model carry-forward order exactly.
 */
function reassembleCodex(rows: { sourceRecordId: string; plaintext: string }[]): string {
  const byIndex = new Map<number, string>();
  let maxIndex = -1;
  let parseable = true;
  for (const r of rows) {
    const suffix = r.sourceRecordId.slice(r.sourceRecordId.lastIndexOf(":") + 1);
    const lineIndex = Number(suffix);
    if (!Number.isInteger(lineIndex) || lineIndex < 0) {
      parseable = false;
      break;
    }
    byIndex.set(lineIndex, r.plaintext);
    if (lineIndex > maxIndex) maxIndex = lineIndex;
  }
  if (!parseable) {
    // Defensive: an unexpected id format falls back to stored order.
    return rows.map((r) => r.plaintext).join("\n");
  }
  const lines: string[] = new Array<string>(maxIndex + 1).fill("");
  for (const [i, text] of byIndex) lines[i] = text;
  return lines.join("\n");
}

/**
 * Reassemble a Claude session's file text. Claude raw records carry no line
 * index (their id is the record uuid), so order by each line's embedded
 * `timestamp` field, falling back to stored order (D: fingerprints are
 * order-independent for Claude — per-record uuids key them — so ordering only
 * bounds the synthetic session-start/end projections). Lines without a
 * timestamp inherit the previous line's sort key, so they stay adjacent to
 * their neighbors under the stable sort.
 */
function reassembleClaude(rows: { plaintext: string }[]): string {
  let carry = "";
  const keyed = rows.map((r) => {
    let ts: string | undefined;
    try {
      const rec = JSON.parse(r.plaintext) as { timestamp?: string };
      if (typeof rec.timestamp === "string") ts = rec.timestamp;
    } catch {
      // unparseable line (should not happen for a stored raw record) → carry
    }
    if (ts) carry = ts;
    return { key: carry, plaintext: r.plaintext };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.plaintext).join("\n");
}

/**
 * Re-parse the archive (or one session with `opts.sessionId`) under the current
 * parsers. When `opts.repricing` carries the ACTIVE pricing catalog, the upsert
 * re-prices cost-bearing events under it (the same path going-forward ingest
 * uses). Returns honest counts — including what was skipped and why.
 */
export async function reparseAll(
  db: Db,
  opts?: {
    sessionId?: string;
    repricing?: { version: string; rates: Record<string, ModelPricing> };
  },
): Promise<ReparseResult> {
  const tuples = await db
    .selectDistinct({
      sessionId: rawSourceRecords.sessionId,
      sourceConnector: rawSourceRecords.sourceConnector,
      machineId: rawSourceRecords.machineId,
    })
    .from(rawSourceRecords)
    .where(opts?.sessionId ? eq(rawSourceRecords.sessionId, opts.sessionId) : undefined)
    .orderBy(asc(rawSourceRecords.sessionId));

  const result: ReparseResult = {
    sessions: 0,
    eventsUpserted: 0,
    orphansDeleted: 0,
    skipped: { gemini: 0, other: 0 },
  };

  for (const t of tuples) {
    if (t.sourceConnector === GEMINI_CLI_CONNECTOR) {
      result.skipped.gemini += 1;
      continue;
    }
    if (t.sourceConnector !== CLAUDE_CODE_CONNECTOR && t.sourceConnector !== CODEX_CLI_CONNECTOR) {
      result.skipped.other += 1;
      continue;
    }

    // Read + decrypt this session's sacred raw records (per machine).
    const rawRows = await db
      .select({
        sourceRecordId: rawSourceRecords.sourceRecordId,
        ciphertext: rawSourceRecords.payloadCiphertext,
        iv: rawSourceRecords.payloadIv,
        tag: rawSourceRecords.payloadTag,
        ingestedAt: rawSourceRecords.ingestedAt,
      })
      .from(rawSourceRecords)
      .where(
        and(
          eq(rawSourceRecords.sessionId, t.sessionId),
          eq(rawSourceRecords.sourceConnector, t.sourceConnector),
          eq(rawSourceRecords.machineId, t.machineId),
        ),
      )
      .orderBy(asc(rawSourceRecords.ingestedAt));
    if (rawRows.length === 0) continue;

    const decrypted = rawRows.map((r) => ({
      sourceRecordId: r.sourceRecordId,
      // decryptField throws on a key/tag error — let it propagate (silent library).
      plaintext: decryptField({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag }),
    }));

    // Deterministic ingestedAt for the parse's fallbacks: the session's earliest
    // stored ingest time — a re-parse must not stamp "now" on old events.
    const ingestedAt = rawRows[0]!.ingestedAt.toISOString();

    const fileText =
      t.sourceConnector === CODEX_CLI_CONNECTOR
        ? reassembleCodex(decrypted)
        : reassembleClaude(decrypted);
    const parsed: ParseResult =
      t.sourceConnector === CODEX_CLI_CONNECTOR
        ? parseCodexSession(fileText, { ingestedAt })
        : parseClaudeCodeSession(fileText, { ingestedAt });

    // Upsert-by-fingerprint (re-stamps parserVersion/catalogVersion, re-prices
    // under the active catalog). Raw upsert is DO NOTHING — raw stays sacred.
    const batch: IngestBatch = {
      records: parsed.rawRecords.map(toRawRecordPayload),
      events: parsed.events.map(toEventPayload),
    };
    const upserted = await ingestBatch(db, t.machineId, batch, opts?.repricing);
    result.eventsUpserted += upserted.eventsUpserted;

    // Orphan GC: per re-parsed raw record, delete every fingerprint the fresh
    // parse no longer produces (e.g. the stale `tool.call.completed` a 2.0.0
    // parser now classifies as `tool.call.failed`). Scoped to THIS machine's
    // re-parsed raw ids so another machine's longer capture of the same session
    // is never touched.
    const freshFingerprints = new Set(parsed.events.map((e) => e.fingerprint));
    const reparsedRawIds = [
      ...new Set([
        ...decrypted.map((r) => r.sourceRecordId),
        ...parsed.events.map((e) => e.rawRecordId),
      ]),
    ];
    const orphans: string[] = [];
    for (const idChunk of chunks(reparsedRawIds, CHUNK)) {
      const existing = await db
        .select({ fingerprint: events.fingerprint })
        .from(events)
        .where(
          and(
            eq(events.sessionId, t.sessionId),
            eq(events.sourceConnector, t.sourceConnector),
            inArray(events.rawRecordId, idChunk),
          ),
        );
      for (const e of existing) {
        if (!freshFingerprints.has(e.fingerprint)) orphans.push(e.fingerprint);
      }
    }
    for (const fpChunk of chunks(orphans, CHUNK)) {
      await db.delete(events).where(inArray(events.fingerprint, fpChunk));
    }
    result.orphansDeleted += orphans.length;
    result.sessions += 1;
  }

  return result;
}
