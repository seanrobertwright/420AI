import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import { computeCost } from "../cost.js";
import { computeTotal, zeroTokens, type NormalizedTokens } from "../tokens.js";
import { PRICING_CATALOG_VERSION } from "../pricing.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE Gemini CLI session parser (string → ParseResult). Relocated from
 * `apps/collector` in 13.3 alongside the Claude/Codex parsers. NOTE: Gemini
 * sessions are NOT re-parseable from stored raw records (D-M13-2) — the stored
 * records are per-message re-serializations, not the parser's whole-file input
 * (the session envelope startTime/lastUpdated/projectHash is not stored). The
 * re-parse engine skips Gemini sessions; this parser moves for symmetry and for
 * the collector's capture path only.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const GEMINI_CLI_CONNECTOR = "gemini-cli";

/** Parser version (new connector starts at 1.0.0). */
export const GEMINI_CLI_PARSER_VERSION = "1.0.0";

/**
 * The Gemini per-message `tokens` block (the fields we map). VERIFIED arithmetic
 * (M4 D1): `total = input + output + thoughts` with `cached ⊂ input`. `thoughts`
 * (and `tool`) are ADDITIVE to the vendor total (unlike Codex, where reasoning is
 * already inside output) — so we fold them into normalized `output` to keep
 * `computeTotal` reproducing the vendor `total`.
 */
interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiToolCall {
  name?: string;
  status?: string;
}

interface GeminiMessage {
  id?: string;
  type?: string;
  model?: string;
  content?: string;
  tokens?: GeminiTokens;
  toolCalls?: GeminiToolCall[];
}

interface GeminiSession {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

/**
 * Map a Gemini per-message `tokens` block onto the normalized token shape
 * (M4 D1, VERIFIED):
 *   - `cached` ⊂ `input` → `cache_read := cached`, `input := input − cached`.
 *   - `thoughts`/`tool` are additive to the vendor total → fold into `output`
 *     (`output := output + thoughts + tool`); `reasoning`/`tool` carry the
 *     informational breakouts.
 *   - no cache-creation tier → `cache_write := 0`.
 * Result: `computeTotal` reproduces the vendor `total` exactly.
 */
function mapTokens(t: GeminiTokens): NormalizedTokens {
  const tokens = zeroTokens();
  const cached = t.cached ?? 0;
  const input = t.input ?? 0;
  const thoughts = t.thoughts ?? 0;
  const tool = t.tool ?? 0;
  tokens.input = Math.max(0, input - cached);
  tokens.cache_read = cached;
  tokens.cache_write = 0;
  tokens.output = (t.output ?? 0) + thoughts + tool;
  tokens.reasoning = thoughts;
  tokens.tool = tool;
  tokens.total = computeTotal(tokens);
  return tokens;
}

/**
 * Parse a Gemini CLI session — a SINGLE JSON file rewritten per turn (not
 * append-only). Read in `snapshot` capture mode (M4 D4).
 *
 * Tolerant: a malformed/mid-rewrite whole-file blob returns an empty
 * `ParseResult` with `skippedLines: 1` (never throws), so the watcher does NOT
 * advance the cursor and retries on the next tick.
 */
export function parseGeminiSession(fileText: string, opts?: { ingestedAt?: string }): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let session: GeminiSession;
  try {
    session = JSON.parse(fileText) as GeminiSession;
  } catch {
    // Mid-rewrite / malformed read — treat the whole blob as one skipped record.
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  const resolvedSession = session.sessionId ?? "unknown-session";
  // projectHash is a HASH, not a path (real path mapping is M5) — store as-is.
  const projectPath = session.projectHash;
  const messages = Array.isArray(session.messages) ? session.messages : [];

  const makeEvent = (
    rawRecordId: string,
    eventIndex: number,
    eventType: EventType,
    ts: string | undefined,
    model: string | undefined,
    extra: Partial<NormalizedEvent> = {},
  ): NormalizedEvent => ({
    fingerprint: eventFingerprint(GEMINI_CLI_CONNECTOR, rawRecordId, eventIndex, eventType),
    sourceConnector: GEMINI_CLI_CONNECTOR,
    parserVersion: GEMINI_CLI_PARSER_VERSION,
    catalogVersion: PRICING_CATALOG_VERSION,
    rawRecordId,
    eventIndex,
    eventType,
    sessionId: resolvedSession,
    projectPath,
    model,
    ts: ts ?? ingestedAt,
    ...extra,
  });

  // --- session.started ---
  if (messages.length > 0) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(makeEvent(sessionRawId, 0, "session.started", session.startTime, undefined));
  }

  // --- one raw record + events per message (stable index) ---
  messages.forEach((message, i) => {
    // rawRecordId keyed on the stable `message.id` (VERIFIED present on 100% of
    // messages) so the fingerprint is invariant across whole-file rewrites; the
    // positional fallback is defensive only.
    const rawId = message.id ?? `${resolvedSession}:msg:${i}`;
    rawRecords.push({
      id: rawId,
      sourceConnector: GEMINI_CLI_CONNECTOR,
      sessionId: resolvedSession,
      ingestedAt,
      payload: JSON.stringify(message),
    });

    const ts = session.lastUpdated;
    if (message.type === "user") {
      events.push(makeEvent(rawId, 0, "message.user", ts, message.model));
      return;
    }

    if (message.type === "gemini") {
      events.push(makeEvent(rawId, 0, "message.assistant", ts, message.model));
      if (message.tokens) {
        const tokens = mapTokens(message.tokens);
        events.push(makeEvent(rawId, 1, "usage.reported", ts, message.model, { tokens }));
        const cost = computeCost(message.model, tokens);
        events.push(makeEvent(rawId, 2, "cost.estimated", ts, message.model, { tokens, cost }));
      }
      // Tool calls: started + completion/failure by `status`. Both share the
      // `3 + toolIdx` index — safe because the eventType differs (fingerprint
      // hashes connector|rawId|index|eventType).
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      toolCalls.forEach((call, toolIdx) => {
        const idx = 3 + toolIdx;
        events.push(
          makeEvent(rawId, idx, "tool.call.started", ts, message.model, {
            payload: { name: call.name },
          }),
        );
        const eventType: EventType =
          call.status === "error" ? "tool.call.failed" : "tool.call.completed";
        events.push(
          makeEvent(rawId, idx, eventType, ts, message.model, {
            payload: { name: call.name },
          }),
        );
      });
      return;
    }
    // `info` and other message types carry no normalized event — raw is kept.
  });

  // --- session.ended ---
  if (messages.length > 0) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(makeEvent(sessionRawId, 0, "session.ended", session.lastUpdated, undefined));
  }

  return { rawRecords, events, skippedLines: 0, sessionId: session.sessionId };
}
