import type { GitCommitPayload } from "@420ai/shared";
import type { Connector } from "../connectors/connector.js";
import { discoverWorkspaces } from "./discover-engine.js";
import { readGitMeta } from "./git-meta.js";
import { readGitLog } from "./git-reader.js";

/**
 * Git-capture sweep (M10, PRD §11.3). Enumerates the SAME project roots the M5
 * discovery sweep finds (so `repoRootPath` matches `events.project_path`
 * byte-for-byte — the join invariant, discovery.ts:21), reads each repo's commits,
 * and builds the `GitCommitPayload[]` the collector POSTs.
 *
 * Library file: no logging — returns counts for `cli.ts` to print. `readLog` is
 * injectable (default = the real `readGitLog`) so tests run with NO live git,
 * mirroring the `syncOnce({ post })` DI style.
 */

export interface GitCaptureResult {
  commits: GitCommitPayload[];
  reposScanned: number;
  /** How many repos hit the read cap (more history exists) — surfaced, never silently dropped. */
  capped: number;
}

/**
 * Target ceiling for a single `/v1/git` POST body (C.6). The collector used to POST ALL commits
 * across every repo as one body; a large history blew past the ingest server's body limit and the
 * connection was reset (ECONNRESET, server up). Chunking under this ceiling keeps every request
 * small AND memory bounded. Kept comfortably below the server's raised bodyLimit.
 */
export const GIT_POST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Split commits into batches whose serialized size stays under `maxBytes` (C.6). `/v1/git` is
 * idempotent by SHA, so chunking is safe — a commit re-sent across runs simply dedups server-side.
 * A single commit larger than the ceiling is emitted as its own (best-effort) batch rather than
 * dropped. Pure + exported for unit testing.
 */
export function chunkCommitsBySize(
  commits: GitCommitPayload[],
  maxBytes: number,
): GitCommitPayload[][] {
  const batches: GitCommitPayload[][] = [];
  let current: GitCommitPayload[] = [];
  let currentBytes = 2; // the enclosing "[]"
  for (const commit of commits) {
    const commitBytes = Buffer.byteLength(JSON.stringify(commit)) + 1; // +1 for the joining comma
    if (current.length > 0 && currentBytes + commitBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(commit);
    currentBytes += commitBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function captureGitCommits(opts: {
  connectors: Connector[];
  home: string;
  readLog?: typeof readGitLog;
}): Promise<GitCaptureResult> {
  const readLog = opts.readLog ?? readGitLog;
  // Reuse the M5 discovery sweep: dedups roots across connectors by projectKey.
  const { workspaces } = await discoverWorkspaces({
    connectors: opts.connectors,
    home: opts.home,
  });

  const commits: GitCommitPayload[] = [];
  let reposScanned = 0;
  let capped = 0;

  for (const ws of workspaces) {
    reposScanned += 1;
    // Read git history from the resolved REAL path, but stamp the payload's
    // repoRootPath with the connector's projectKey (== events.project_path) so the
    // server's attribution join resolves. For Claude/Codex these are equal; for a
    // hash-keyed connector the key differs from the real path on disk.
    const meta = readGitMeta(ws.rootPath);
    const { commits: repoCommits, capped: repoCapped } = await readLog(ws.rootPath);
    if (repoCapped) capped += 1;
    for (const c of repoCommits) {
      commits.push({
        ...c,
        repoRootPath: ws.projectKey,
        gitBranch: meta.branch ?? ws.gitBranch,
      });
    }
  }

  return { commits, reposScanned, capped };
}
