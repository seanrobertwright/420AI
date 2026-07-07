import { glob } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexSession, CODEX_CLI_CONNECTOR, type RootHint } from "@420ai/shared";
import type { Connector } from "./connector.js";
import { scanLines } from "../discovery/read-head.js";

/**
 * The OpenAI Codex CLI connector: discovery/watch wiring around the PURE parser,
 * which lives in `@420ai/shared` (relocated in 13.3 so the server-side re-parse
 * engine runs the exact same code). Re-exported here so existing importers
 * (tests) are unchanged.
 */
export { parseCodexSession, classifyCodexOutput, CODEX_CLI_CONNECTOR } from "@420ai/shared";
export type { CodexFailureClass } from "@420ai/shared";

/** The minimal session_meta head shape discovery reads (full shapes live with the parser). */
interface CodexRecordHead {
  type?: string;
  payload?: { cwd?: string; git?: { branch?: string } };
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
    let record: CodexRecordHead;
    try {
      record = JSON.parse(line) as CodexRecordHead;
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
      "failure classification covers environment (exit 124/127, timeouts), tool-runtime (other nonzero exits), and state-mismatch (apply_patch verification failed); model-error / permission-block / user-cancel / expected-negative are not distinguishable from Codex output (PRD §14)",
    ],
    requiredPermissions: [
      "Read OpenAI Codex CLI rollout logs under ~/.codex/sessions/*/*/*/rollout-*.jsonl",
    ],
    testedVersions: ["0.137.x"],
  },
  watchGlobs: (home) => codexWatchGlobs(home),
  parse: (text) => parseCodexSession(text),
  discoverRoots: (home) => discoverCodexRoots(home),
};
