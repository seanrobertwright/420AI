import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE ChatGPT chat-export parser (string → ParseResult) for M14 slice 14.6.
 *
 * Parses the official OpenAI ChatGPT data export (`conversations.json`, obtained
 * via Settings → Data controls → Export data). Mirrors the shipped
 * `claude-export` parser (14.5): chat exports carry NO cwd/git and NO token
 * counts, so events are deliberately UNCOSTED (no `usage.reported`/
 * `cost.estimated`, no `tokens`/`cost`, no `catalogVersion`) and attributed by a
 * synthetic per-conversation topic key rather than a repo path (non-repo
 * attribution, D-M14-2). UNLIKE Claude/Gemini, the ChatGPT export DOES carry a
 * model (`metadata.model_slug` / `default_model_slug`), so `model` IS stamped —
 * but there are still no token counts, hence uncosted.
 *
 * VERIFIED shape (real 63-conversation export, structure-only inspection 2026-07-21):
 *   - Top-level: a FLAT ARRAY of conversation objects (one file, many sessions).
 *   - Conversation: `conversation_id` (stable id → sessionId + attribution key),
 *     `title` (100% present), `create_time`/`update_time` (Unix EPOCH SECONDS as
 *     float, e.g. 1763306665.654753), `default_model_slug`, `mapping` (the message
 *     store keyed by node id).
 *   - `mapping` node: `{id, message, parent}` — `children[]` is empty/absent on
 *     100% of nodes, so DO NOT tree-walk; order messages by `message.create_time`
 *     (present on 100% of messages). Each conversation has exactly one null-`message`
 *     root node — skip nodes with no message.
 *   - Message: `id` (unique → rawRecordId), `author.role` (only `user`/`assistant`),
 *     `create_time` (epoch seconds), `content:{content_type, parts[]}`,
 *     `metadata.model_slug`.
 *   - content_types: `text` / `thoughts` / `reasoning_recap` / `multimodal_text`.
 *
 * SCOPE: emits `session.started`/`message.user`/`message.assistant`/`session.ended`.
 * Only `text` + `multimodal_text` messages become `message.*` events; `thoughts` /
 * `reasoning_recap` reasoning nodes are the model's internal reasoning (parity with
 * `claude-export` deferring thinking blocks) — kept as raw records (raw is sacred)
 * but emit NO normalized event. See the connector's `knownGaps`.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CHATGPT_EXPORT_CONNECTOR = "chatgpt-export";

/** Parser version (new connector starts at 1.0.0). */
export const CHATGPT_EXPORT_PARSER_VERSION = "1.0.0";

/** A message within a conversation's `mapping` node. */
interface ChatgptExportMessage {
  id?: string;
  author?: { role?: string };
  create_time?: number;
  content?: { content_type?: string };
  metadata?: { model_slug?: string };
}

/** A `mapping` node: `{id, message, parent}`. `children[]` is empty/absent (verified). */
interface ChatgptExportNode {
  id?: string;
  message?: ChatgptExportMessage | null;
  parent?: string | null;
}

/** A conversation object (one per session). */
interface ChatgptExportConversation {
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  default_model_slug?: string;
  mapping?: Record<string, ChatgptExportNode>;
}

/**
 * ChatGPT `create_time`/`update_time` are Unix EPOCH SECONDS as float (VERIFIED,
 * e.g. 1763306665.654753). Convert to canonical millisecond ISO; guard NaN/missing
 * → fallback. `ts` is NOT a fingerprint input, so the sub-ms truncation cannot
 * affect dedup — but a raw `new Date(sec)` would emit 1970 timestamps, hence ×1000.
 */
function epochToIso(sec: number | undefined, fallback: string): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return fallback;
  return new Date(sec * 1000).toISOString();
}

/**
 * Parse a ChatGPT chat export — a SINGLE JSON file containing an array of
 * conversations. Read in `snapshot` capture mode (whole-file re-read).
 *
 * Tolerant: a malformed / mid-copy whole-file blob returns an empty ParseResult
 * with `skippedLines: 1` (never throws), so the watcher does NOT advance and
 * retries next tick. A conversation without a stable `conversation_id` is counted
 * in `skippedLines` and dropped — never keyed on array position, which would churn
 * fingerprints across re-imports.
 */
export function parseChatgptExport(fileText: string, opts?: { ingestedAt?: string }): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    // Mid-copy / malformed read — treat the whole blob as one skipped record.
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  // The export is a flat array (VERIFIED); tolerate a `{conversations:[…]}`
  // wrapper defensively. Anything else valid-but-wrong-shaped → skippedLines.
  let list: ChatgptExportConversation[];
  if (Array.isArray(parsed)) {
    list = parsed as ChatgptExportConversation[];
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { conversations?: unknown }).conversations)
  ) {
    list = (parsed as { conversations: ChatgptExportConversation[] }).conversations;
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
    const sessionId =
      typeof conv.conversation_id === "string" && conv.conversation_id.length > 0
        ? conv.conversation_id
        : undefined;
    if (!sessionId) {
      skippedLines++;
      continue;
    }

    // Collect the message-bearing nodes and order them by create_time. The
    // `children[]` links are empty on 100% of nodes, so a parent-walk is
    // impossible; `create_time` (present on every message) is the reliable order.
    const mapping = conv.mapping && typeof conv.mapping === "object" ? conv.mapping : {};
    const messageNodes = Object.values(mapping)
      .filter((n): n is ChatgptExportNode & { message: ChatgptExportMessage } =>
        Boolean(n && typeof n === "object" && n.message),
      )
      .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));

    // A conversation with only a root node (no messages) is legitimate, not
    // malformed — emit nothing (mirrors claude-export's empty-conversation guard).
    if (messageNodes.length === 0) continue;

    // Non-repo attribution: a synthetic, STABLE topic key the user can alias to a
    // workspace via `workspace_keys`.
    const projectPath = `chat:chatgpt:${sessionId}`;
    const title = typeof conv.title === "string" ? conv.title.trim() : "";

    const makeEvent = (
      rawRecordId: string,
      eventIndex: number,
      eventType: EventType,
      ts: string,
      extra: Partial<NormalizedEvent> = {},
    ): NormalizedEvent => ({
      fingerprint: eventFingerprint(CHATGPT_EXPORT_CONNECTOR, rawRecordId, eventIndex, eventType),
      sourceConnector: CHATGPT_EXPORT_CONNECTOR,
      parserVersion: CHATGPT_EXPORT_PARSER_VERSION,
      // No catalogVersion / tokens / cost — the export carries no token counts.
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
        epochToIso(conv.create_time, ingestedAt),
        title.length > 0 ? { payload: { title } } : {},
      ),
    );

    // --- one raw record per message node; a message event only for text/multimodal ---
    messageNodes.forEach((node, i) => {
      const message = node.message;
      // rawRecordId keyed on the stable `message.id` (VERIFIED unique + present on
      // 100% of messages) so the fingerprint is invariant across whole-file
      // re-imports; the positional fallback is defensive only.
      const rawId =
        typeof message.id === "string" && message.id.length > 0
          ? message.id
          : `${sessionId}:msg:${i}`;
      // Raw is sacred: EVERY message node is stored verbatim, including the
      // thoughts/reasoning_recap reasoning nodes that emit no normalized event.
      rawRecords.push({
        id: rawId,
        sourceConnector: CHATGPT_EXPORT_CONNECTOR,
        sessionId,
        ingestedAt,
        payload: JSON.stringify(message),
      });

      const contentType = message.content?.content_type;
      // Only delivered message bodies become events; `thoughts`/`reasoning_recap`
      // (internal reasoning) are raw-kept-but-not-evented (knownGap).
      if (contentType !== "text" && contentType !== "multimodal_text") return;

      const role = message.author?.role;
      const eventType: EventType | undefined =
        role === "user" ? "message.user" : role === "assistant" ? "message.assistant" : undefined;
      // An unrecognized role keeps its raw record but emits no normalized event.
      if (!eventType) return;

      // The ChatGPT export DOES carry a model — stamp it (per-message slug wins,
      // else the conversation default). Still uncosted (no token counts).
      const model = message.metadata?.model_slug ?? conv.default_model_slug;
      events.push(
        makeEvent(rawId, 0, eventType, epochToIso(message.create_time, ingestedAt), { model }),
      );
    });

    // --- session.ended ---
    events.push(
      makeEvent(
        sessionRawId,
        0,
        "session.ended",
        epochToIso(conv.update_time ?? conv.create_time, ingestedAt),
      ),
    );
  }

  return { rawRecords, events, skippedLines };
}
