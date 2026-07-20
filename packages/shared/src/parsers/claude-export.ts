import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE Claude chat-export parser (string → ParseResult) for M14 slice 14.5.
 *
 * Parses the official Claude web-app data export (`conversations.json`, obtained
 * via Settings → Privacy → Export data). UNLIKE the coding-tool connectors, a
 * chat export carries NO cwd/git and NO token counts — so chat events are
 * deliberately UNCOSTED (no `usage.reported`/`cost.estimated`, no `model`, no
 * `catalogVersion`) and attributed by a synthetic per-conversation topic key
 * rather than a repo path (the "non-repo attribution" design, D-M14-2).
 *
 * VERIFIED shape (Task-1 gate, 2026-07-20, real 71-conversation export):
 *   - Top-level: a FLAT ARRAY of conversation objects (one file, many sessions).
 *   - Conversation: `uuid` (stable id → sessionId + attribution key), `name`
 *     (title, may be ""), `created_at`/`updated_at` (ISO-8601 microseconds),
 *     `chat_messages: []`.
 *   - Message: `uuid` (stable, file-unique → rawRecordId), `sender`
 *     ("human"|"assistant"), `created_at` (ISO), `text`, `content[]` blocks.
 *   - No model, no tokens anywhere.
 *
 * SCOPE (Phase-0 gate): emits `session.started`/`message.user`/`message.assistant`/
 * `session.ended` only. The export DOES carry `tool_use`/`tool_result`/`thinking`
 * content blocks and `attachments`/`files`, but those block shapes were not
 * verified in the Task-1 pass, so tool-lifecycle + file-interaction events are a
 * declared knownGap (deferred, not guessed) — see the connector's `knownGaps`.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CLAUDE_EXPORT_CONNECTOR = "claude-export";

/** Parser version (new connector starts at 1.0.0). */
export const CLAUDE_EXPORT_PARSER_VERSION = "1.0.0";

/** A single message node within a conversation's `chat_messages`. */
interface ClaudeExportMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  created_at?: string;
  updated_at?: string;
}

/** A conversation object (one per session). */
interface ClaudeExportConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeExportMessage[];
}

/**
 * Normalize an export timestamp to canonical ISO. The export's `created_at` is
 * already ISO-8601 but with microsecond precision (`…623137Z`); re-emit through
 * `Date` so `ts` is always a valid, canonical millisecond ISO string. GUARDED:
 * an absent or unparseable value falls back to `ingestedAt` (never emits a
 * non-ISO `ts`, never throws). `ts` is NOT a fingerprint input, so the micros→
 * millis truncation cannot affect dedup.
 */
function normalizeTs(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

/**
 * Parse a Claude chat export — a SINGLE JSON file containing an array of
 * conversations. Read in `snapshot` capture mode (whole-file re-read).
 *
 * Tolerant: a malformed / mid-copy whole-file blob returns an empty ParseResult
 * with `skippedLines: 1` (never throws), so the watcher does NOT advance and
 * retries next tick. A well-formed-but-unusable conversation (no stable `uuid`)
 * is counted in `skippedLines` and its messages dropped — never keyed on array
 * position, which would churn fingerprints across re-imports.
 */
export function parseClaudeExport(fileText: string, opts?: { ingestedAt?: string }): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let conversations: unknown;
  try {
    conversations = JSON.parse(fileText);
  } catch {
    // Mid-copy / malformed read — treat the whole blob as one skipped record.
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  // The export is a flat array (VERIFIED); tolerate a `{conversations:[…]}`
  // wrapper defensively. Anything else valid-but-wrong-shaped → skippedLines.
  let list: ClaudeExportConversation[];
  if (Array.isArray(conversations)) {
    list = conversations as ClaudeExportConversation[];
  } else if (
    conversations &&
    typeof conversations === "object" &&
    Array.isArray((conversations as { conversations?: unknown }).conversations)
  ) {
    list = (conversations as { conversations: ClaudeExportConversation[] }).conversations;
  } else {
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  let skippedLines = 0;

  for (const conv of list) {
    if (!conv || typeof conv !== "object") {
      skippedLines++;
      continue;
    }
    // A conversation needs a stable id to fingerprint its session/messages
    // reproducibly; without one, skip it rather than key on array position.
    const sessionId = typeof conv.uuid === "string" && conv.uuid.length > 0 ? conv.uuid : undefined;
    if (!sessionId) {
      skippedLines++;
      continue;
    }

    const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    // An empty conversation is legitimate (observed 3/71), not malformed — emit
    // nothing (mirrors the Gemini precedent's `messages.length > 0` guard).
    if (messages.length === 0) continue;

    // Non-repo attribution: a synthetic, STABLE topic key the user can alias to a
    // workspace via `workspace_keys` (the same mechanism as Gemini's projectHash).
    const projectPath = `chat:claude:${sessionId}`;
    const title = typeof conv.name === "string" ? conv.name.trim() : "";

    const makeEvent = (
      rawRecordId: string,
      eventIndex: number,
      eventType: EventType,
      ts: string,
      extra: Partial<NormalizedEvent> = {},
    ): NormalizedEvent => ({
      fingerprint: eventFingerprint(CLAUDE_EXPORT_CONNECTOR, rawRecordId, eventIndex, eventType),
      sourceConnector: CLAUDE_EXPORT_CONNECTOR,
      parserVersion: CLAUDE_EXPORT_PARSER_VERSION,
      // No catalogVersion / model / tokens / cost — chat exports are uncosted.
      rawRecordId,
      eventIndex,
      eventType,
      sessionId,
      projectPath,
      ts,
      ...extra,
    });

    // --- session.started (carries the conversation title when present) ---
    const sessionRawId = `${sessionId}:session`;
    events.push(
      makeEvent(
        sessionRawId,
        0,
        "session.started",
        normalizeTs(conv.created_at, ingestedAt),
        title.length > 0 ? { payload: { title } } : {},
      ),
    );

    // --- one raw record + one message event per message (stable message uuid) ---
    messages.forEach((message, i) => {
      // rawRecordId keyed on the stable `message.uuid` (VERIFIED present + unique
      // on 100% of messages) so the fingerprint is invariant across whole-file
      // re-imports; the positional fallback is defensive only.
      const rawId =
        typeof message.uuid === "string" && message.uuid.length > 0
          ? message.uuid
          : `${sessionId}:msg:${i}`;
      rawRecords.push({
        id: rawId,
        sourceConnector: CLAUDE_EXPORT_CONNECTOR,
        sessionId,
        ingestedAt,
        payload: JSON.stringify(message),
      });

      const ts = normalizeTs(message.created_at, ingestedAt);
      const eventType: EventType | undefined =
        message.sender === "human"
          ? "message.user"
          : message.sender === "assistant"
            ? "message.assistant"
            : undefined;
      // An unrecognized sender keeps its raw record but emits no normalized event.
      if (eventType) events.push(makeEvent(rawId, 0, eventType, ts));
    });

    // --- session.ended ---
    events.push(
      makeEvent(
        sessionRawId,
        0,
        "session.ended",
        normalizeTs(conv.updated_at ?? conv.created_at, ingestedAt),
      ),
    );
  }

  return { rawRecords, events, skippedLines };
}
