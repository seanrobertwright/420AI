import { glob } from "node:fs/promises";
import { join } from "node:path";
import { parseClaudeCodeSession, CLAUDE_CODE_CONNECTOR, type RootHint } from "@420ai/shared";
import type { Connector } from "./connector.js";
import { scanLines } from "../discovery/read-head.js";

/**
 * The Claude Code connector: discovery/watch wiring around the PURE parser,
 * which lives in `@420ai/shared` (relocated in 13.3 so the server-side re-parse
 * engine runs the exact same code). Re-exported here so existing importers
 * (cli.ts, tests) are unchanged.
 */
export { parseClaudeCodeSession, CLAUDE_CODE_CONNECTOR } from "@420ai/shared";

/** The minimal head-of-session shape discovery reads (full shapes live with the parser). */
interface ClaudeRecordHead {
  cwd?: string;
  gitBranch?: string;
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
    let record: ClaudeRecordHead;
    try {
      record = JSON.parse(line) as ClaudeRecordHead;
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
 * The Claude Code connector — wraps the unchanged whole-file parser in the
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
    requiredPermissions: [
      "Read Claude Code session transcripts under ~/.claude/projects/*/*.jsonl",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => claudeWatchGlobs(home),
  parse: (text) => parseClaudeCodeSession(text),
  discoverRoots: (home) => discoverClaudeRoots(home),
};
