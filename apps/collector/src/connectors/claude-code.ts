import {
  eventFingerprint,
  computeCost,
  computeTotal,
  zeroTokens,
  type EventType,
  type NormalizedEvent,
  type NormalizedTokens,
  type RawSourceRecord,
} from "@420ai/shared";

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CLAUDE_CODE_CONNECTOR = "claude-code";

/**
 * Parser version. Bumping this re-derives events on replay; because fingerprints
 * are independent of parser version, re-ingest upserts in place (PRD §23).
 */
export const PARSER_VERSION = "1.0.0";

export interface ParseResult {
  rawRecords: RawSourceRecord[];
  events: NormalizedEvent[];
  /** Count of JSONL lines that failed to parse (tolerant parsing). */
  skippedLines: number;
  sessionId?: string;
}

/** The Claude `usage` block (only the fields we map; the rest stays in raw). */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeContentBlock {
  type?: string;
  name?: string;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: ClaudeMessage;
}

/** Map a Claude `usage` block onto the normalized token shape (PRD §10.3). */
function mapTokens(usage: ClaudeUsage): NormalizedTokens {
  const tokens = zeroTokens();
  tokens.input = usage.input_tokens ?? 0;
  tokens.output = usage.output_tokens ?? 0;
  tokens.cache_read = usage.cache_read_input_tokens ?? 0;
  // V1 collapses the 1h + 5m ephemeral cache-creation tiers into cache_write.
  tokens.cache_write = usage.cache_creation_input_tokens ?? 0;
  // reasoning/tool stay 0 for Claude (thinking folds into output_tokens;
  // server_tool_use reports request counts, not tokens).
  tokens.total = computeTotal(tokens);
  return tokens;
}

/**
 * Parse a Claude Code session JSONL file into permanent raw records plus
 * normalized events.
 *
 * Tolerant: a malformed line is skipped and counted (`skippedLines`), never
 * throwing the whole parse. Never throws on a single bad record.
 */
export function parseClaudeCodeSession(
  fileText: string,
  opts?: { ingestedAt?: string },
): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];
  let skippedLines = 0;

  const lines = fileText.split(/\r?\n/);
  const parsed: { record: ClaudeRecord; rawId: string }[] = [];
  let sessionId: string | undefined;

  // --- Pass 1: parse lines into raw records (tolerant) ---
  lines.forEach((line, lineIndex) => {
    if (line.trim() === "") return;
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line) as ClaudeRecord;
    } catch {
      skippedLines += 1;
      return;
    }
    const recSession = record.sessionId ?? sessionId ?? "unknown-session";
    if (!sessionId && record.sessionId) sessionId = record.sessionId;
    const rawId = record.uuid ?? `${recSession}:${lineIndex}`;
    rawRecords.push({
      id: rawId,
      sourceConnector: CLAUDE_CODE_CONNECTOR,
      sessionId: recSession,
      ingestedAt,
      payload: line,
    });
    parsed.push({ record, rawId });
  });

  const resolvedSession = sessionId ?? "unknown-session";

  // Helper to build a normalized event with a deterministic fingerprint.
  const makeEvent = (
    rawRecordId: string,
    eventIndex: number,
    eventType: EventType,
    base: ClaudeRecord,
    extra: Partial<NormalizedEvent> = {},
  ): NormalizedEvent => ({
    fingerprint: eventFingerprint(CLAUDE_CODE_CONNECTOR, rawRecordId, eventIndex, eventType),
    sourceConnector: CLAUDE_CODE_CONNECTOR,
    parserVersion: PARSER_VERSION,
    rawRecordId,
    eventIndex,
    eventType,
    sessionId: base.sessionId ?? resolvedSession,
    projectPath: base.cwd,
    gitBranch: base.gitBranch,
    model: base.message?.model,
    ts: base.timestamp ?? ingestedAt,
    ...extra,
  });

  // --- session.started (earliest timestamp), if there is any record ---
  const timestamps = parsed
    .map((p) => p.record.timestamp)
    .filter((t): t is string => typeof t === "string")
    .sort();
  const firstRecord = parsed[0]?.record;
  if (firstRecord) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(
      makeEvent(sessionRawId, 0, "session.started", firstRecord, {
        ts: timestamps[0] ?? firstRecord.timestamp ?? ingestedAt,
        model: undefined,
      }),
    );
  }

  // --- Pass 2: per-record events ---
  for (const { record, rawId } of parsed) {
    if (record.type === "user") {
      events.push(makeEvent(rawId, 0, "message.user", record));
      continue;
    }

    if (record.type === "assistant") {
      events.push(makeEvent(rawId, 0, "message.assistant", record));

      const usage = record.message?.usage;
      if (usage) {
        const tokens = mapTokens(usage);
        events.push(makeEvent(rawId, 1, "usage.reported", record, { tokens }));
        const cost = computeCost(record.message?.model, tokens);
        events.push(
          makeEvent(rawId, 2, "cost.estimated", record, { tokens, cost }),
        );
      }

      // Tool calls: one tool.call.started per tool_use block. No completion
      // correlation in this slice (full lifecycle is a later milestone).
      const content = record.message?.content;
      if (Array.isArray(content)) {
        let toolIdx = 0;
        for (const block of content) {
          if (block?.type === "tool_use") {
            events.push(
              makeEvent(rawId, 3 + toolIdx, "tool.call.started", record, {
                payload: { name: block.name },
              }),
            );
            toolIdx += 1;
          }
        }
      }
    }
    // Other record types (mode, permission-mode, system, etc.) carry no
    // normalized events in V1 — but their raw records are still preserved.
  }

  // --- session.ended (latest timestamp) ---
  if (firstRecord) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(
      makeEvent(sessionRawId, 0, "session.ended", firstRecord, {
        ts: timestamps[timestamps.length - 1] ?? firstRecord.timestamp ?? ingestedAt,
        model: undefined,
      }),
    );
  }

  return { rawRecords, events, skippedLines, sessionId };
}
