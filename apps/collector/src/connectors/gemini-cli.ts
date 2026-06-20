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
import { scanGeminiProjectRoots } from "../discovery/gemini-roots.js";

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const GEMINI_CLI_CONNECTOR = "gemini-cli";

/** Parser version (new connector starts at 1.0.0). */
export const PARSER_VERSION = "1.0.0";

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
export function parseGeminiSession(
  fileText: string,
  opts?: { ingestedAt?: string },
): ParseResult {
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
    parserVersion: PARSER_VERSION,
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

/** Glob patterns for Gemini session files (shared by watch + discovery). */
function geminiWatchGlobs(home: string): string[] {
  return [join(home, ".gemini", "tmp", "*", "chats", "session-*.json")];
}

/**
 * Extract the `<dirName>` (== projectHash == event.projectPath) from a Gemini
 * session path `.../.gemini/tmp/<dirName>/chats/session-*.json`. Anchored on
 * `.gemini` (then `tmp` is the next segment, the dir the one after) so a project
 * dir that happens to be named "tmp" can't mis-resolve it.
 */
function geminiDirName(sessionPath: string): string | undefined {
  const parts = sessionPath.replace(/\\/g, "/").split("/");
  const g = parts.indexOf(".gemini");
  // expect parts[g+1] === "tmp", parts[g+2] === <dirName>
  if (g >= 0 && parts[g + 1] === "tmp" && g + 2 < parts.length) {
    return parts[g + 2];
  }
  return undefined;
}

/**
 * Enumerate Gemini project roots from `~/.gemini/tmp/*` (M5 discovery, D3). For
 * each tmp dir that has session files: if it has a `.project_root` sidecar, the
 * hint carries the resolved `rootPath`; otherwise `rootPath` is undefined (a
 * legacy hash-only dir — unresolvable, counted as a discovery gap by the engine,
 * NOT a hash-crack attempt). `projectKey` is the dir name == `event.projectPath`.
 */
export async function discoverGeminiRoots(home: string): Promise<RootHint[]> {
  const sidecars = scanGeminiProjectRoots(home); // dirName -> realPath
  const counts = new Map<string, number>();
  for (const pattern of geminiWatchGlobs(home)) {
    for await (const match of glob(pattern.replace(/\\/g, "/"))) {
      const dirName = geminiDirName(String(match));
      if (dirName) counts.set(dirName, (counts.get(dirName) ?? 0) + 1);
    }
  }
  const hints: RootHint[] = [];
  for (const [dirName, sessionCount] of counts) {
    hints.push({ projectKey: dirName, rootPath: sidecars.get(dirName), sessionCount });
  }
  return hints;
}

/**
 * The Gemini CLI connector. Session files are a single JSON blob REWRITTEN per
 * turn at `~/.gemini/tmp/<project>/chats/session-*.json` — read in `snapshot`
 * capture mode (whole-file re-read on size/mtime change), NOT the byte-offset
 * tail path (M4 D4).
 */
export const geminiCliConnector: Connector = {
  id: GEMINI_CLI_CONNECTOR,
  captureMode: "snapshot",
  fidelity: {
    status: "stable",
    captureMethod: "watch-diff-json",
    liveness: "near-real-time",
    tokens: "exact",
    cost: "computed",
    knownGaps: [
      "M5 maps projectHash→real path via the .project_root sidecar; legacy hash-only sessions (no sidecar) stay unattributed",
      "tool>0 token additivity unobserved on disk — folded into output defensively",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => geminiWatchGlobs(home),
  parse: (text) => parseGeminiSession(text),
  discoverRoots: (home) => discoverGeminiRoots(home),
};
