import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE Claude LIVE-wire parser (string → ParseResult) for M14 slice 14.7.
 *
 * Parses the conversation JSON the browser extension reads from claude.ai's OWN
 * authenticated conversation API and pushes to the collector's `push` receiver —
 * near-real-time capture, in contrast to the days-stale official export the 14.5
 * `claude-export` connector parses (`parseClaudeExport`). This is a near-clone of
 * that parser: same tolerant JSON handling, same `chat:claude:<uuid>` attribution
 * (on PURPOSE — a conversation captured both ways groups under one session), same
 * `eventFingerprint` calls, same `session.started`/`session.ended` framing, same
 * UNCOSTED posture (no tokens/cost/catalogVersion).
 *
 * The ONE difference from the export: the wire carries a conversation-level `model`
 * (the export does not), so this parser STAMPS that model on `message.assistant`
 * events only. `message.user`/`session.*` events stay unmodeled.
 *
 * VERIFIED wire shape (live recon, 2026-07-20, real 70-conversation account):
 *   - `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
 *   - Conversation: `uuid` (stable id → sessionId + attribution key), `name`
 *     (title, may be ""), `model` (conversation-level string, may be absent/null),
 *     `created_at`/`updated_at` (ISO-8601 microseconds), `chat_messages: []`.
 *   - Message: `uuid` (stable, unique → rawRecordId), `sender`
 *     ("human"|"assistant"), `text`, `created_at`, `content[]` blocks.
 *   - Per-message `model`: ABSENT. Tokens/usage: ABSENT anywhere.
 *
 * SCOPE (Phase-0 gate): emits `session.started`/`message.user`/`message.assistant`/
 * `session.ended` only — the SAME scope as the export parser. The wire DOES carry
 * `thinking`/`tool_use`/`tool_result` content blocks, but those block shapes are a
 * declared knownGap — tool-lifecycle + file-interaction events are deferred, not
 * guessed (see the connector's `knownGaps`).
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CLAUDE_LIVE_CONNECTOR = "claude-live";

/** Parser version (new connector starts at 1.0.0). */
export const CLAUDE_WIRE_PARSER_VERSION = "1.0.0";

/** A single message node within a conversation's `chat_messages`. */
interface ClaudeWireMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  created_at?: string;
  updated_at?: string;
}

/** A conversation object (one per session). Note the extra `model` vs the export. */
interface ClaudeWireConversation {
  uuid?: string;
  name?: string;
  model?: string | null;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeWireMessage[];
}

/**
 * Normalize a wire timestamp to canonical ISO. The API's `created_at` is already
 * ISO-8601 but with microsecond precision (`…623137Z`); re-emit through `Date` so
 * `ts` is always a valid, canonical millisecond ISO string. GUARDED: an absent or
 * unparseable value falls back to `ingestedAt` (never emits a non-ISO `ts`, never
 * throws). `ts` is NOT a fingerprint input, so the micros→millis truncation cannot
 * affect dedup.
 */
function normalizeTs(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

/**
 * Parse pushed Claude conversations — a JSON ARRAY of conversation objects (the
 * extension `JSON.stringify`s its `conversations` array; the receiver forwards that
 * string verbatim to `connector.parse`).
 *
 * Tolerant: a malformed / mid-flight body returns an empty ParseResult with
 * `skippedLines: 1` (never throws), so the receiver responds 200 with zero counts
 * rather than 500. A single conversation object and a `{conversations:[…]}` wrapper
 * are both accepted defensively. A conversation without a stable `uuid` is counted
 * in `skippedLines` and dropped — never keyed on array position, which would churn
 * fingerprints across re-pushes.
 */
export function parseClaudeWire(text: string, opts?: { ingestedAt?: string }): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Mid-flight / malformed body — treat the whole blob as one skipped record.
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  // The wire is a flat array (VERIFIED); tolerate a single conversation object and a
  // `{conversations:[…]}` wrapper defensively. Anything else valid-but-wrong-shaped →
  // skippedLines.
  let list: ClaudeWireConversation[];
  if (Array.isArray(parsed)) {
    list = parsed as ClaudeWireConversation[];
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { conversations?: unknown }).conversations)
  ) {
    list = (parsed as { conversations: ClaudeWireConversation[] }).conversations;
  } else if (parsed && typeof parsed === "object") {
    // A bare single conversation object → wrap it.
    list = [parsed as ClaudeWireConversation];
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
    // An empty conversation is legitimate (a freshly-created thread), not malformed —
    // emit nothing (mirrors the export parser's `messages.length > 0` guard).
    if (messages.length === 0) continue;

    // Non-repo attribution: the SAME synthetic topic key the export parser emits, so a
    // live+export capture of one conversation groups under one session in the UI.
    const projectPath = `chat:claude:${sessionId}`;
    const title = typeof conv.name === "string" ? conv.name.trim() : "";
    // The wire's conversation-level model (the export lacks this) — stamped on assistant
    // events only. Non-string / empty / null → left unset (still uncosted, just unmodeled).
    const convModel =
      typeof conv.model === "string" && conv.model.length > 0 ? conv.model : undefined;

    const makeEvent = (
      rawRecordId: string,
      eventIndex: number,
      eventType: EventType,
      ts: string,
      extra: Partial<NormalizedEvent> = {},
    ): NormalizedEvent => ({
      fingerprint: eventFingerprint(CLAUDE_LIVE_CONNECTOR, rawRecordId, eventIndex, eventType),
      sourceConnector: CLAUDE_LIVE_CONNECTOR,
      parserVersion: CLAUDE_WIRE_PARSER_VERSION,
      // No catalogVersion / tokens / cost — chat wire is uncosted. `model` is stamped
      // on assistant events via `extra` (the one difference vs the export parser).
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
      // rawRecordId keyed on the stable `message.uuid` (VERIFIED present + unique) so
      // the fingerprint is invariant across re-pushes; the positional fallback is
      // defensive only.
      const rawId =
        typeof message.uuid === "string" && message.uuid.length > 0
          ? message.uuid
          : `${sessionId}:msg:${i}`;
      rawRecords.push({
        id: rawId,
        sourceConnector: CLAUDE_LIVE_CONNECTOR,
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
      if (eventType === "message.assistant") {
        events.push(makeEvent(rawId, 0, eventType, ts, convModel ? { model: convModel } : {}));
      } else if (eventType) {
        events.push(makeEvent(rawId, 0, eventType, ts));
      }
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
