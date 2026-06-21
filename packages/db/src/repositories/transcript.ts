import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import { events, rawSourceRecords } from "../schema.js";

/**
 * The session transcript decrypt-for-render read (M8, PRD §16.2/§18). This is the
 * FIRST repository that calls `decryptField` on a read path — M6 projections and M7
 * reports never decrypt. It reconstructs a session's user/assistant message
 * transcript from the verbatim raw records, ordered, deduped, and capped.
 *
 * Why raw records and not `events.payload` (spike 1): message text is NULL in
 * `events.payload` (the parsers attach payloads only to tool/file/context events).
 * The prompts/outputs live in the verbatim raw record — one per JSONL line —
 * reachable via `events.rawRecordId = raw_source_records.sourceRecordId` scoped by
 * `sessionId`. Selecting only `message.*` events excludes the attachment/tool-result
 * bulk (84% of a real session's bytes) with no connector re-parsing.
 *
 * Silent library (CLAUDE.md): throws on a decrypt/key error (the AES-GCM auth tag
 * fails loudly), never logs. Returns PLAINTEXT — the caller is CONTRACTUALLY
 * REQUIRED to run the `@420ai/shared` Redaction Pipeline over each entry BEFORE the
 * text is sent to a provider, logged, or stored (the §18 gate). This read does NOT
 * redact (redaction is the shared engine's job, exercised by the orchestrator).
 */

export interface TranscriptEntry {
  role: "user" | "assistant";
  /** Verbatim decrypted raw-record text (connector-native JSONL/JSON). PLAINTEXT. */
  text: string;
  ts: string; // ISO — events.ts is mode:"string"
  /** True if this entry was truncated to `maxCharsPerRecord`. */
  truncated: boolean;
}

export interface TranscriptCaps {
  maxRecords: number;
  maxCharsPerRecord: number;
  maxTotalChars: number;
}

/**
 * Defaults grounded by spike 1: real sessions reach multi-MB on disk, but the
 * actual conversation (user prompts + assistant text) is ~tens of KB. Selecting
 * message events (not raw bytes) plus these caps keeps the bundle compact and
 * high-signal.
 */
export const DEFAULT_TRANSCRIPT_CAPS: TranscriptCaps = {
  maxRecords: 200,
  maxCharsPerRecord: 4000,
  maxTotalChars: 48000,
};

const MESSAGE_TYPES = ["message.user", "message.assistant"] as const;

function roleOf(eventType: string): "user" | "assistant" {
  return eventType === "message.assistant" ? "assistant" : "user";
}

/**
 * Decrypt a session's message transcript: select `message.user`/`message.assistant`
 * events, inner-join their raw record (`sourceRecordId = rawRecordId AND sessionId =
 * sessionId`), decrypt the verbatim payload, order by `ts` then `eventIndex`, DEDUPE
 * by `rawRecordId` (one line spawns many events — first wins), per-record truncate
 * to `maxCharsPerRecord`, and stop at `maxRecords`/`maxTotalChars`. The result
 * `truncated` flag is set if any cap clipped content.
 */
export async function sessionTranscript(
  db: DbClient,
  sessionId: string,
  caps: TranscriptCaps = DEFAULT_TRANSCRIPT_CAPS,
): Promise<{ entries: TranscriptEntry[]; totalChars: number; truncated: boolean }> {
  const rows = await db
    .select({
      eventType: events.eventType,
      ts: events.ts, // mode:"string" — order by it directly, no Date coercion
      eventIndex: events.eventIndex,
      rawRecordId: events.rawRecordId,
      ciphertext: rawSourceRecords.payloadCiphertext,
      iv: rawSourceRecords.payloadIv,
      tag: rawSourceRecords.payloadTag,
    })
    .from(events)
    .innerJoin(
      rawSourceRecords,
      and(
        eq(rawSourceRecords.sourceRecordId, events.rawRecordId),
        eq(rawSourceRecords.sessionId, events.sessionId),
      ),
    )
    .where(and(eq(events.sessionId, sessionId), inArray(events.eventType, [...MESSAGE_TYPES])))
    .orderBy(asc(events.ts), asc(events.eventIndex));

  const entries: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let truncated = false;

  for (const row of rows) {
    // Dedupe by rawRecordId — a single line spawns many events (first wins).
    if (seen.has(row.rawRecordId)) continue;
    seen.add(row.rawRecordId);

    if (entries.length >= caps.maxRecords) {
      truncated = true;
      break;
    }

    // Decrypt the verbatim raw line. decryptField throws on a key/tag error — let it
    // propagate (silent library; a key misconfig becomes a server 500 upstream).
    const plaintext = decryptField({
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
    });

    let text = plaintext;
    let recordTruncated = false;
    if (text.length > caps.maxCharsPerRecord) {
      text = text.slice(0, caps.maxCharsPerRecord);
      recordTruncated = true;
      truncated = true;
    }

    // Global char cap: stop once the budget would be exceeded.
    if (totalChars + text.length > caps.maxTotalChars) {
      const remaining = caps.maxTotalChars - totalChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      text = text.slice(0, remaining);
      recordTruncated = true;
      truncated = true;
    }

    totalChars += text.length;
    entries.push({ role: roleOf(row.eventType), text, ts: row.ts, truncated: recordTruncated });
  }

  return { entries, totalChars, truncated };
}
