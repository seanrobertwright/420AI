import { glob } from "node:fs/promises";
import { join } from "node:path";
import {
  eventFingerprint,
  computeCost,
  computeTotal,
  zeroTokens,
  type EventType,
  type NormalizedEvent,
  type NormalizedTokens,
  type RawSourceRecord,
  type RootHint,
} from "@420ai/shared";
import type { Connector, ParseResult } from "./connector.js";
import { scanLines } from "../discovery/read-head.js";

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CODEX_CLI_CONNECTOR = "codex-cli";

/** Parser version (new connector starts at 1.0.0; bumping re-derives on replay). */
export const PARSER_VERSION = "1.0.0";

/**
 * The Codex `last_token_usage` / `total_token_usage` block (the fields we map;
 * the rest stays in the raw record). All counts are CUMULATIVE in
 * `total_token_usage` and per-turn DELTAS in `last_token_usage` — we map the
 * DELTA (M4 D2), since the deltas sum to the cumulative final total. Using the
 * cumulative figure per record would multiply session cost by the number of
 * token_count records.
 */
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/**
 * Codex records are a TWO-LEVEL envelope (cli 0.137.x, M4 D3):
 *   { timestamp, type, payload } where the meaningful sub-type is `payload.type`.
 * The spike doc predates this — trust the verified shapes here.
 */
interface CodexPayload {
  type?: string;
  // session_meta
  id?: string;
  cwd?: string;
  cli_version?: string;
  git?: { branch?: string };
  // turn_context
  model?: string;
  // user_message / agent_message / message
  message?: string;
  role?: string;
  // function_call / custom_tool_call
  name?: string;
  call_id?: string;
  // token_count
  info?: {
    total_token_usage?: CodexTokenUsage;
    last_token_usage?: CodexTokenUsage;
  };
  // patch_apply_end
  path?: string;
}

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: CodexPayload;
}

/**
 * Map a Codex per-turn `last_token_usage` delta onto the normalized token shape
 * (M4 D1, VERIFIED):
 *   - `cached_input_tokens` ⊂ `input_tokens` → `cache_read := cached`,
 *     `input := input_tokens − cached`.
 *   - `reasoning_output_tokens` ⊂ `output_tokens` → `output := output_tokens`
 *     (already includes reasoning), `reasoning` is an informational subset.
 *   - no cache-creation tier → `cache_write := 0`.
 * Result: `computeTotal` reproduces the vendor `total_tokens` exactly.
 */
function mapTokens(usage: CodexTokenUsage): NormalizedTokens {
  const tokens = zeroTokens();
  const cached = usage.cached_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  tokens.input = Math.max(0, input - cached);
  tokens.cache_read = cached;
  tokens.cache_write = 0;
  tokens.output = usage.output_tokens ?? 0;
  tokens.reasoning = usage.reasoning_output_tokens ?? 0;
  tokens.tool = 0;
  tokens.total = computeTotal(tokens);
  return tokens;
}

/**
 * Parse a Codex CLI rollout JSONL file into permanent raw records plus
 * normalized events.
 *
 * Tolerant: a malformed line is skipped and counted (`skippedLines`), never
 * throwing. Raw records are pushed verbatim before any normalization.
 */
export function parseCodexSession(
  fileText: string,
  opts?: { ingestedAt?: string },
): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];
  let skippedLines = 0;

  const lines = fileText.split(/\r?\n/);
  const parsed: { record: CodexRecord; rawId: string; lineIndex: number }[] = [];
  let sessionId: string | undefined;
  let projectPath: string | undefined;
  let gitBranch: string | undefined;

  // --- Pass 1: parse lines into raw records (tolerant) + resolve session meta ---
  lines.forEach((line, lineIndex) => {
    if (line.trim() === "") return;
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      skippedLines += 1;
      return;
    }
    const payload = record.payload;
    // session_meta carries the session id, cwd, and git branch (D3).
    if (record.type === "session_meta" && payload) {
      if (!sessionId && payload.id) sessionId = payload.id;
      if (!projectPath && payload.cwd) projectPath = payload.cwd;
      if (!gitBranch && payload.git?.branch) gitBranch = payload.git.branch;
    }
    parsed.push({ record, rawId: "", lineIndex });
  });

  const resolvedSession = sessionId ?? "unknown-session";
  // Codex lines have NO per-record uuid → use the `${session}:${lineIndex}`
  // fallback for a stable rawRecordId (mirrors Claude, D3 VERIFIED).
  for (const p of parsed) {
    p.rawId = `${resolvedSession}:${p.lineIndex}`;
    rawRecords.push({
      id: p.rawId,
      sourceConnector: CODEX_CLI_CONNECTOR,
      sessionId: resolvedSession,
      ingestedAt,
      payload: lines[p.lineIndex]!,
    });
  }

  // Helper to build a normalized event with a deterministic fingerprint. `model`
  // is passed per-call because Codex carries it forward from turn_context (D3).
  const makeEvent = (
    rawRecordId: string,
    eventIndex: number,
    eventType: EventType,
    ts: string | undefined,
    model: string | undefined,
    extra: Partial<NormalizedEvent> = {},
  ): NormalizedEvent => ({
    fingerprint: eventFingerprint(CODEX_CLI_CONNECTOR, rawRecordId, eventIndex, eventType),
    sourceConnector: CODEX_CLI_CONNECTOR,
    parserVersion: PARSER_VERSION,
    rawRecordId,
    eventIndex,
    eventType,
    sessionId: resolvedSession,
    projectPath,
    gitBranch,
    model,
    ts: ts ?? ingestedAt,
    ...extra,
  });

  // --- session.started (earliest timestamp) ---
  const timestamps = parsed
    .map((p) => p.record.timestamp)
    .filter((t): t is string => typeof t === "string")
    .sort();
  if (parsed.length > 0) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(
      makeEvent(sessionRawId, 0, "session.started", timestamps[0], undefined),
    );
  }

  // --- Pass 2: per-record events (carry model forward from turn_context) ---
  let currentModel: string | undefined;
  for (const { record, rawId } of parsed) {
    const payload = record.payload;
    if (!payload) continue;
    const ts = record.timestamp;
    const subType = payload.type;

    if (record.type === "turn_context") {
      if (payload.model) currentModel = payload.model;
      continue;
    }

    if (record.type === "event_msg") {
      if (subType === "user_message") {
        events.push(makeEvent(rawId, 0, "message.user", ts, currentModel));
      } else if (subType === "agent_message") {
        events.push(makeEvent(rawId, 0, "message.assistant", ts, currentModel));
      } else if (subType === "token_count") {
        // VERIFIED (D2): emit per-turn DELTA from `last_token_usage`, NEVER the
        // cumulative `total_token_usage` (which would double-count session cost).
        const last = payload.info?.last_token_usage;
        if (last) {
          const tokens = mapTokens(last);
          events.push(makeEvent(rawId, 0, "usage.reported", ts, currentModel, { tokens }));
          const cost = computeCost(currentModel, tokens);
          events.push(makeEvent(rawId, 1, "cost.estimated", ts, currentModel, { tokens, cost }));
        }
      } else if (subType === "patch_apply_end") {
        events.push(
          makeEvent(rawId, 0, "file.modified", ts, currentModel, {
            payload: { path: payload.path },
          }),
        );
      }
      continue;
    }

    if (record.type === "response_item") {
      if (subType === "function_call" || subType === "custom_tool_call") {
        events.push(
          makeEvent(rawId, 0, "tool.call.started", ts, currentModel, {
            payload: { name: payload.name, call_id: payload.call_id },
          }),
        );
      } else if (
        subType === "function_call_output" ||
        subType === "custom_tool_call_output"
      ) {
        // VERIFIED (D3): outputs are plain strings with no structured is_error
        // signal, so emit `completed` for every output and DEFER failure
        // classification (see knownGaps).
        events.push(
          makeEvent(rawId, 0, "tool.call.completed", ts, currentModel, {
            payload: { call_id: payload.call_id },
          }),
        );
      } else if (subType === "message") {
        const eventType: EventType =
          payload.role === "user" ? "message.user" : "message.assistant";
        events.push(makeEvent(rawId, 0, eventType, ts, currentModel));
      }
      continue;
    }
  }

  // --- session.ended (latest timestamp) ---
  if (parsed.length > 0) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(
      makeEvent(
        sessionRawId,
        0,
        "session.ended",
        timestamps[timestamps.length - 1],
        undefined,
      ),
    );
  }

  return { rawRecords, events, skippedLines, sessionId };
}

/**
 * Read the `cwd` (+ git.branch) from a Codex rollout's first `session_meta` line
 * (M5 discovery, D2). Stops at the meta line rather than full-parsing. The `cwd`
 * is the RAW verbatim string the parser stamps on `event.projectPath` — so the
 * discovery key matches the capture key byte-for-byte (the join invariant).
 */
function firstCodexCwd(filePath: string): { cwd: string; gitBranch?: string } | undefined {
  return scanLines(filePath, (line) => {
    if (line.trim() === "") return undefined;
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      return undefined;
    }
    if (record.type === "session_meta" && record.payload?.cwd) {
      return { cwd: record.payload.cwd, gitBranch: record.payload.git?.branch };
    }
    return undefined;
  });
}

/**
 * Enumerate distinct Codex project roots from the rollout store, deduped by `cwd`
 * (== the real path == `event.projectPath`). M5 discovery.
 */
export async function discoverCodexRoots(home: string): Promise<RootHint[]> {
  const byCwd = new Map<string, RootHint>();
  for (const pattern of codexWatchGlobs(home)) {
    for await (const match of glob(pattern.replace(/\\/g, "/"))) {
      const meta = firstCodexCwd(String(match));
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

/** Glob patterns for Codex rollout files (shared by watch + discovery). */
function codexWatchGlobs(home: string): string[] {
  return [join(home, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl")];
}

/**
 * The OpenAI Codex CLI connector. Session files are append-only JSONL rollouts at
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` — same `tail` capture path
 * as Claude (M4 D3, VERIFIED against cli 0.137.x).
 */
export const codexCliConnector: Connector = {
  id: CODEX_CLI_CONNECTOR,
  captureMode: "tail",
  fidelity: {
    status: "stable",
    captureMethod: "tail-jsonl",
    liveness: "streaming",
    tokens: "exact",
    cost: "computed",
    knownGaps: [
      "tool-call failure classification deferred — outputs carry no structured is_error",
    ],
    testedVersions: ["0.137.x"],
  },
  watchGlobs: (home) => codexWatchGlobs(home),
  parse: (text) => parseCodexSession(text),
  discoverRoots: (home) => discoverCodexRoots(home),
};
