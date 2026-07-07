import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import { computeCost } from "../cost.js";
import { computeTotal, zeroTokens, type NormalizedTokens } from "../tokens.js";
import { PRICING_CATALOG_VERSION } from "../pricing.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE Codex CLI rollout parser (string → ParseResult). Relocated from
 * `apps/collector` in 13.3 so the server-side re-parse engine (12.5b) runs the
 * exact same code the collector runs at capture time. Discovery/watch code
 * (globs, root scans, the Connector object) stays in the collector.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CODEX_CLI_CONNECTOR = "codex-cli";

/**
 * Parser version (bumping re-derives on replay). 2.0.0 (12.7a): tool-output
 * failure classification — a tool call that was `tool.call.completed` under 1.0.0
 * can now be `tool.call.failed`, which is a fingerprint input, so its fingerprint
 * changes. Going-forward ingest is correct; the stale-typed-event GC on re-parse
 * is owned by the 12.5b replay engine (`reparseAll`, 13.3).
 */
export const CODEX_CLI_PARSER_VERSION = "2.0.0";

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
  // function_call_output / custom_tool_call_output — the tool-output string
  // (often a JSON envelope `{"output":"…","metadata":{"exit_code":N}}`).
  output?: string;
  // patch_apply_end — defensive failure outcome (does not occur in real rollouts;
  // apply_patch failures arrive via custom_tool_call_output text instead).
  success?: boolean;
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

/** PRD §14 failure classes detectable from Codex tool output (subset — see knownGaps). */
export type CodexFailureClass = "environment" | "state-mismatch" | "tool-runtime";

/**
 * Classify a Codex tool-output payload (`function_call_output` / `custom_tool_call_output`).
 * Two spike-verified signals (112 real rollouts): a JSON envelope `{output, metadata:{exit_code}}`,
 * else bare-string failure phrases. No signal / non-string ⇒ not failed (completed). Never throws.
 */
export function classifyCodexOutput(output: unknown): {
  failed: boolean;
  failureClass?: CodexFailureClass;
  exitCode?: number;
} {
  if (typeof output !== "string") return { failed: false };
  // 1. Structured: the output string is itself a JSON envelope carrying metadata.exit_code.
  let exitCode: number | undefined;
  try {
    const parsed = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
    if (parsed && typeof parsed === "object" && typeof parsed.metadata?.exit_code === "number") {
      exitCode = parsed.metadata.exit_code;
    }
  } catch {
    // not a JSON envelope — fall through to plain-text signals
  }
  if (exitCode !== undefined) {
    if (exitCode === 0) return { failed: false, exitCode };
    const failureClass: CodexFailureClass =
      exitCode === 124 || exitCode === 127 ? "environment" : "tool-runtime";
    return { failed: true, failureClass, exitCode };
  }
  // 2. Plain-text signals (no structured exit code).
  if (output.startsWith("apply_patch verification failed")) {
    return { failed: true, failureClass: "state-mismatch" };
  }
  if (/command timed out after/i.test(output)) {
    return { failed: true, failureClass: "environment" };
  }
  return { failed: false };
}

/**
 * Parse a Codex CLI rollout JSONL file into permanent raw records plus
 * normalized events.
 *
 * Tolerant: a malformed line is skipped and counted (`skippedLines`), never
 * throwing. Raw records are pushed verbatim before any normalization.
 */
export function parseCodexSession(fileText: string, opts?: { ingestedAt?: string }): ParseResult {
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
    parserVersion: CODEX_CLI_PARSER_VERSION,
    catalogVersion: PRICING_CATALOG_VERSION,
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
    events.push(makeEvent(sessionRawId, 0, "session.started", timestamps[0], undefined));
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
        // DEFENSIVE (12.7a): real rollouts never emit patch_apply_end; apply_patch
        // failures arrive via custom_tool_call_output text. Handle a structured
        // `success: false` as a state-mismatch failure, else the existing modify.
        if (payload.success === false) {
          events.push(
            makeEvent(rawId, 0, "tool.call.failed", ts, currentModel, {
              payload: { failureClass: "state-mismatch" },
            }),
          );
        } else {
          events.push(
            makeEvent(rawId, 0, "file.modified", ts, currentModel, {
              payload: { path: payload.path },
            }),
          );
        }
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
      } else if (subType === "function_call_output" || subType === "custom_tool_call_output") {
        // 12.7a (VERIFIED, 112 real rollouts): outputs DO carry failure signals —
        // a JSON envelope `metadata.exit_code` or bare-string failure phrases.
        // Classify and emit `failed` (with §14 class + exit code) or `completed`.
        const outcome = classifyCodexOutput(payload.output);
        if (outcome.failed) {
          events.push(
            makeEvent(rawId, 0, "tool.call.failed", ts, currentModel, {
              payload: {
                call_id: payload.call_id,
                failureClass: outcome.failureClass,
                ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
              },
            }),
          );
        } else {
          events.push(
            makeEvent(rawId, 0, "tool.call.completed", ts, currentModel, {
              payload: { call_id: payload.call_id },
            }),
          );
        }
      } else if (subType === "message") {
        const eventType: EventType = payload.role === "user" ? "message.user" : "message.assistant";
        events.push(makeEvent(rawId, 0, eventType, ts, currentModel));
      }
      continue;
    }
  }

  // --- session.ended (latest timestamp) ---
  if (parsed.length > 0) {
    const sessionRawId = `${resolvedSession}:session`;
    events.push(
      makeEvent(sessionRawId, 0, "session.ended", timestamps[timestamps.length - 1], undefined),
    );
  }

  return { rawRecords, events, skippedLines, sessionId };
}
