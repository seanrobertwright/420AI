import { glob } from "node:fs/promises";
import { join } from "node:path";
import {
  eventFingerprint,
  computeCost,
  computeTotal,
  zeroTokens,
  PRICING_CATALOG_VERSION,
  type EventType,
  type NormalizedEvent,
  type NormalizedTokens,
  type RawSourceRecord,
  type RootHint,
} from "@420ai/shared";
import type { Connector, ParseResult } from "./connector.js";
import { scanLines } from "../discovery/read-head.js";

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CLAUDE_CODE_CONNECTOR = "claude-code";

/**
 * Parser version. Bumping this re-derives events on replay; because fingerprints
 * are independent of parser version, re-ingest upserts in place (PRD §23).
 */
export const PARSER_VERSION = "2.0.0";

/** The Claude `usage` block (only the fields we map; the rest stays in raw). */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeContentBlock {
  type?: string;
  /** tool_use: tool name (e.g. "Read", "Edit"). */
  name?: string;
  /** tool_use: the tool-call id correlated to a later tool_result. */
  id?: string;
  /** tool_use: arguments; `file_path` drives file.read/file.modified (D6). */
  input?: { file_path?: string };
  /** tool_result: the tool_use id this result completes. */
  tool_use_id?: string;
  /** tool_result: present + boolean — true ⇒ tool.call.failed (D6). */
  is_error?: boolean;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
}

/** A `deferred_tools_delta`/context attachment payload (drives context.loaded). */
interface ClaudeAttachment {
  type?: string;
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: ClaudeMessage;
  /** Present on `attachment` records (PRD §10.3 context loads). */
  attachment?: ClaudeAttachment;
}

/** Tool names that read a file vs. modify one (D6 — VERIFIED input key `file_path`). */
const FILE_READ_TOOLS = new Set(["Read"]);
const FILE_MODIFY_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

  // Correlate the tool-call lifecycle (D6): assistant `tool_use` blocks carry
  // the tool name keyed by id; the NEXT user record carries matching
  // `tool_result` blocks (`tool_use_id` + boolean `is_error`). We emit
  // completion/failure ON THE RESULT record (its rawId) so the fingerprint is
  // stable, and look the tool name back up from this map.
  const toolNameById = new Map<string, string>();
  for (const { record } of parsed) {
    if (record.type !== "assistant") continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block.id) {
        toolNameById.set(block.id, block.name ?? "unknown");
      }
    }
  }

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
    catalogVersion: PRICING_CATALOG_VERSION,
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

      // Tool lifecycle completion: a user record's `tool_result` blocks close
      // out earlier tool_use calls. Emit completed/failed by `is_error` (D6).
      // eventIndex `1 + resultIdx` is unique per result block within this record.
      const content = record.message?.content;
      if (Array.isArray(content)) {
        let resultIdx = 0;
        for (const block of content) {
          if (block?.type === "tool_result" && block.tool_use_id) {
            const eventType: EventType = block.is_error
              ? "tool.call.failed"
              : "tool.call.completed";
            events.push(
              makeEvent(rawId, 1 + resultIdx, eventType, record, {
                payload: {
                  name: toolNameById.get(block.tool_use_id),
                  tool_use_id: block.tool_use_id,
                },
              }),
            );
            resultIdx += 1;
          }
        }
      }
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

      // Tool calls + file events: one per tool_use block. `tool.call.started`
      // keeps its M1 index (`3 + toolIdx`) so its fingerprint is unchanged and
      // upserts in place across the PARSER_VERSION bump (D5). A Read/Edit/Write
      // block ALSO emits a file event; it reuses the SAME `3 + toolIdx` index —
      // safe because the eventType differs, so the fingerprint differs (the
      // fingerprint hashes connector|rawId|index|eventType).
      const content = record.message?.content;
      if (Array.isArray(content)) {
        let toolIdx = 0;
        for (const block of content) {
          if (block?.type === "tool_use") {
            const idx = 3 + toolIdx;
            events.push(
              makeEvent(rawId, idx, "tool.call.started", record, {
                payload: { name: block.name },
              }),
            );
            const name = block.name ?? "";
            if (FILE_READ_TOOLS.has(name)) {
              events.push(
                makeEvent(rawId, idx, "file.read", record, {
                  payload: { path: block.input?.file_path },
                }),
              );
            } else if (FILE_MODIFY_TOOLS.has(name)) {
              events.push(
                makeEvent(rawId, idx, "file.modified", record, {
                  payload: { path: block.input?.file_path },
                }),
              );
            }
            toolIdx += 1;
          }
        }
      }
      continue;
    }

    if (record.type === "attachment") {
      // Context loads: each attachment record (e.g. deferred_tools_delta) is a
      // context.loaded event (D6). `system` compaction markers are deferred.
      events.push(
        makeEvent(rawId, 0, "context.loaded", record, {
          payload: { attachmentType: record.attachment?.type },
        }),
      );
      continue;
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

/**
 * Read the FIRST `cwd` (+ gitBranch) from a Claude session file (M5 discovery,
 * D2). The cwd is on the session's opening record(s); we stop at the first hit
 * rather than full-parsing — discovery is a cheap metadata sweep. The returned
 * `cwd` is the RAW verbatim string the parser stamps on `event.projectPath`, so
 * the discovery key matches the capture key byte-for-byte (the join invariant).
 */
function firstClaudeCwd(filePath: string): { cwd: string; gitBranch?: string } | undefined {
  return scanLines(filePath, (line) => {
    if (line.trim() === "") return undefined;
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line) as ClaudeRecord;
    } catch {
      return undefined;
    }
    if (typeof record.cwd === "string" && record.cwd !== "") {
      return { cwd: record.cwd, gitBranch: record.gitBranch };
    }
    return undefined;
  });
}

/**
 * Enumerate distinct Claude project roots from the `~/.claude/projects` session
 * files, deduped by `cwd` (== the real path == `event.projectPath`). M5 discovery.
 */
export async function discoverClaudeRoots(home: string): Promise<RootHint[]> {
  const byCwd = new Map<string, RootHint>();
  for (const pattern of claudeWatchGlobs(home)) {
    for await (const match of glob(pattern.replace(/\\/g, "/"))) {
      const meta = firstClaudeCwd(String(match));
      if (!meta) continue;
      const existing = byCwd.get(meta.cwd);
      if (existing) {
        existing.sessionCount = (existing.sessionCount ?? 0) + 1;
      } else {
        byCwd.set(meta.cwd, {
          projectKey: meta.cwd,
          rootPath: meta.cwd,
          gitBranch: meta.gitBranch,
          sessionCount: 1,
        });
      }
    }
  }
  return [...byCwd.values()];
}

/** Glob patterns for Claude session files (shared by watch + discovery). */
function claudeWatchGlobs(home: string): string[] {
  return [join(home, ".claude", "projects", "*", "*.jsonl")];
}

/**
 * The Claude Code connector — wraps the unchanged whole-file parser above in the
 * M3 `Connector` contract. Session files live at
 * `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` (append-only JSONL, one per
 * session) — verified in docs/research/connector-capture-spike.md.
 */
export const claudeCodeConnector: Connector = {
  id: CLAUDE_CODE_CONNECTOR,
  captureMode: "tail",
  fidelity: {
    status: "stable",
    captureMethod: "tail-jsonl",
    liveness: "streaming",
    tokens: "exact",
    cost: "computed",
    knownGaps: [
      "file.referenced not emitted — no single reliable structured signal in the store (M5+)",
      "session.ended ts settles only when the file stops growing",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => claudeWatchGlobs(home),
  parse: (text) => parseClaudeCodeSession(text),
  discoverRoots: (home) => discoverClaudeRoots(home),
};
