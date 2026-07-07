import { describe, it, expect } from "vitest";
import type { GitCommitPayload, RootHint } from "@420ai/shared";
import type { Connector } from "../connectors/connector.js";
import type { GitCommit, GitLogResult, readGitLog } from "./git-reader.js";
import { captureGitCommits, chunkCommitsBySize } from "./git-capture.js";

/** A minimal Connector stub: discoverWorkspaces only touches `id` + `discoverRoots`. */
function stubConnector(id: string, hints: RootHint[]): Connector {
  return {
    id,
    fidelity: {
      status: "stable",
      captureMethod: "stub",
      liveness: "snapshot",
      tokens: "none",
      cost: "none",
      knownGaps: [],
      requiredPermissions: [],
    },
    watchGlobs: () => [],
    parse: () => ({ rawRecords: [], events: [], skippedLines: 0 }),
    discoverRoots: async () => hints,
  };
}

function fakeCommit(sha: string): GitCommit {
  return {
    commitSha: sha,
    authorName: "Sean Wright",
    authorEmail: "sean@example.com",
    authoredAt: "2026-06-16T12:00:00-04:00",
    committedAt: "2026-06-16T12:00:00-04:00",
    message: `commit ${sha}`,
    parents: ["p0"],
    isRevert: false,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    files: [{ path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 }],
  };
}

describe("captureGitCommits (sweep + DI)", () => {
  it("stamps repoRootPath with the connector projectKey (the join invariant)", async () => {
    const key = "/home/a/420ai";
    const connector = stubConnector("claude-code", [
      { projectKey: key, rootPath: key, gitBranch: "main", sessionCount: 1 },
    ]);
    const readLog: typeof readGitLog = async () => ({ commits: [fakeCommit("c1")], capped: false });

    const result = await captureGitCommits({ connectors: [connector], home: "/home", readLog });
    expect(result.reposScanned).toBe(1);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.repoRootPath).toBe(key); // == events.project_path
    expect(result.commits[0]!.gitBranch).toBe("main"); // fell back to the hint (no real .git)
    expect(result.commits[0]!.commitSha).toBe("c1");
  });

  it("dedups the same root reported by two connectors", async () => {
    const key = "/repo";
    const a = stubConnector("claude-code", [{ projectKey: key, rootPath: key }]);
    const b = stubConnector("codex-cli", [{ projectKey: key, rootPath: key }]);
    let calls = 0;
    const readLog: typeof readGitLog = async () => {
      calls += 1;
      return { commits: [fakeCommit("dup")], capped: false };
    };

    const result = await captureGitCommits({ connectors: [a, b], home: "/home", readLog });
    expect(result.reposScanned).toBe(1); // deduped by projectKey
    expect(calls).toBe(1);
    expect(result.commits).toHaveLength(1);
  });

  it("propagates the capped flag as a per-repo count", async () => {
    const connectors = [
      stubConnector("claude-code", [{ projectKey: "/r1", rootPath: "/r1" }]),
      stubConnector("codex-cli", [{ projectKey: "/r2", rootPath: "/r2" }]),
    ];
    const readLog: typeof readGitLog = async (root: string): Promise<GitLogResult> => ({
      commits: [fakeCommit(root)],
      capped: root === "/r1", // only the first repo is capped
    });

    const result = await captureGitCommits({ connectors, home: "/home", readLog });
    expect(result.reposScanned).toBe(2);
    expect(result.capped).toBe(1);
  });

  it("a repo with no commits (non-repo / git absent) contributes nothing, no throw", async () => {
    const connector = stubConnector("claude-code", [{ projectKey: "/empty", rootPath: "/empty" }]);
    const readLog: typeof readGitLog = async () => ({ commits: [], capped: false });
    const result = await captureGitCommits({ connectors: [connector], home: "/home", readLog });
    expect(result.reposScanned).toBe(1);
    expect(result.commits).toEqual([]);
  });
});

/**
 * C.6 regression: a `git` sweep over a large history used to POST ALL commits as one body, which
 * exceeded the ingest server's body limit and reset the connection (ECONNRESET). chunkCommitsBySize
 * keeps every POST body bounded; `/v1/git` dedups by SHA so chunking is exact.
 */
function payload(sha: string): GitCommitPayload {
  return { ...fakeCommit(sha), repoRootPath: "/repo", gitBranch: "main" };
}

describe("chunkCommitsBySize (C.6 — bounded git POST bodies)", () => {
  it("returns no batches for an empty commit list (no POST needed)", () => {
    expect(chunkCommitsBySize([], 1024)).toEqual([]);
  });

  it("keeps everything in one batch when it fits under the ceiling", () => {
    const commits = [payload("a"), payload("b"), payload("c")];
    const batches = chunkCommitsBySize(commits, 1024 * 1024);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it("splits into multiple bounded batches, losing nothing and preserving order", () => {
    const commits = Array.from({ length: 50 }, (_, i) => payload(`c${i}`));
    const oneBytes = Buffer.byteLength(JSON.stringify(commits[0]));
    // A ceiling that fits ~5 commits per batch forces several batches.
    const maxBytes = oneBytes * 5;
    const batches = chunkCommitsBySize(commits, maxBytes);

    expect(batches.length).toBeGreaterThan(1);
    // Every batch body stays under the ceiling.
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(maxBytes);
    }
    // Concatenation equals the input, in order (nothing dropped or reordered).
    expect(batches.flat().map((c) => c.commitSha)).toEqual(commits.map((c) => c.commitSha));
  });

  it("emits a single over-ceiling commit as its own batch rather than dropping it", () => {
    const big = payload("big");
    big.message = "x".repeat(10_000);
    const batches = chunkCommitsBySize([payload("small"), big], 2_000);
    expect(batches.flat().map((c) => c.commitSha)).toEqual(["small", "big"]);
    // The oversized commit is isolated in its own batch.
    expect(batches.some((b) => b.length === 1 && b[0]!.commitSha === "big")).toBe(true);
  });
});
