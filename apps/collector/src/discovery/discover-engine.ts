import type { DiscoveredWorkspace } from "@420ai/shared";
import type { Connector } from "../connectors/connector.js";
import { readGitMeta } from "./git-meta.js";

/**
 * Discovery engine (M5, PRD §19 steps 7–8). Gathers each connector's
 * `discoverRoots` hints, dedups by `projectKey`, enriches every resolved root
 * with git remote/branch (`readGitMeta`, no subprocess), and produces the
 * `DiscoveredWorkspace[]` the collector POSTs.
 *
 * Library file: NO logging — returns data (incl. the `unresolved` gap count) for
 * `cli.ts` to print. Inject `connectors` + `home` for tests.
 */
export interface DiscoverResult {
  workspaces: DiscoveredWorkspace[];
  /** Hints with no resolvable real path (e.g. Gemini hash-only dirs) — a gap. */
  unresolved: number;
}

export async function discoverWorkspaces(opts: {
  connectors: Connector[];
  home: string;
}): Promise<DiscoverResult> {
  const seen = new Set<string>();
  const workspaces: DiscoveredWorkspace[] = [];
  let unresolved = 0;

  for (const connector of opts.connectors) {
    if (!connector.discoverRoots) continue;
    const hints = await connector.discoverRoots(opts.home);
    for (const hint of hints) {
      // A resolvable root with no path is a discovery gap (Gemini hash-only).
      if (!hint.rootPath) {
        unresolved += 1;
        continue;
      }
      // Dedup by the raw projectKey — the same real root reported by two
      // connectors collapses to one workspace (the server keys on it too).
      if (seen.has(hint.projectKey)) continue;
      seen.add(hint.projectKey);

      const git = readGitMeta(hint.rootPath);
      workspaces.push({
        sourceConnector: connector.id,
        projectKey: hint.projectKey,
        rootPath: hint.rootPath,
        gitRemote: git.remote,
        // Prefer the freshly-read branch; fall back to the store hint.
        gitBranch: git.branch ?? hint.gitBranch,
        sessionCount: hint.sessionCount,
      });
    }
  }

  return { workspaces, unresolved };
}
