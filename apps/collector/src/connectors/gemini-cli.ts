import { glob } from "node:fs/promises";
import { join } from "node:path";
import { parseGeminiSession, GEMINI_CLI_CONNECTOR, type RootHint } from "@420ai/shared";
import type { Connector } from "./connector.js";
import { scanGeminiProjectRoots } from "../discovery/gemini-roots.js";

/**
 * The Gemini CLI connector: discovery/watch wiring around the PURE parser,
 * which lives in `@420ai/shared` (relocated in 13.3 alongside Claude/Codex).
 * Re-exported here so existing importers (tests) are unchanged.
 */
export { parseGeminiSession, GEMINI_CLI_CONNECTOR } from "@420ai/shared";

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
    requiredPermissions: [
      "Read Gemini CLI session files under ~/.gemini/tmp/*/chats/session-*.json",
      "Read ~/.gemini/tmp/*/.project_root sidecars for project attribution (discovery)",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => geminiWatchGlobs(home),
  parse: (text) => parseGeminiSession(text),
  discoverRoots: (home) => discoverGeminiRoots(home),
};
