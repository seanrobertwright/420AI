import { describe, it, expect } from "vitest";
import type { RootHint } from "@420ai/shared";
import type { Connector } from "../connectors/connector.js";
import type { GitCommit, GitLogResult, readGitLog } from "./git-reader.js";
import { captureGitCommits } from "./git-capture.js";

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
