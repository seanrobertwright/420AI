import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RootHint } from "@420ai/shared";
import type { Connector, ParseResult } from "../connectors/connector.js";
import { discoverWorkspaces } from "./discover-engine.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discover-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Make a real `.git` repo dir inside the tmp dir, returning its absolute path. */
function makeRepo(name: string, branch: string, remote: string): string {
  const root = join(dir, name);
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
  writeFileSync(join(gitDir, "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  return root;
}

/** A fake connector that just returns canned hints (parse/watchGlobs are stubs). */
function fakeConnector(id: string, hints: RootHint[]): Connector {
  return {
    id,
    fidelity: {
      status: "experimental",
      captureMethod: "test",
      liveness: "snapshot",
      tokens: "none",
      cost: "none",
      knownGaps: [],
      requiredPermissions: [],
    },
    watchGlobs: () => [],
    parse: (): ParseResult => ({ rawRecords: [], events: [], skippedLines: 0 }),
    discoverRoots: async () => hints,
  };
}

describe("discoverWorkspaces", () => {
  it("enriches resolved roots with git remote/branch from .git files", async () => {
    const root = makeRepo("repoA", "main", "https://github.com/me/repoA.git");
    const connectors = [fakeConnector("claude-code", [{ projectKey: root, rootPath: root }])];
    const { workspaces, unresolved } = await discoverWorkspaces({ connectors, home: dir });
    expect(unresolved).toBe(0);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      sourceConnector: "claude-code",
      projectKey: root,
      rootPath: root,
      gitRemote: "https://github.com/me/repoA.git",
      gitBranch: "main",
    });
  });

  it("dedups the same real root reported by two connectors into one workspace", async () => {
    const root = makeRepo("repoB", "dev", "https://github.com/me/repoB.git");
    const connectors = [
      fakeConnector("claude-code", [{ projectKey: root, rootPath: root }]),
      fakeConnector("codex-cli", [{ projectKey: root, rootPath: root }]),
    ];
    const { workspaces } = await discoverWorkspaces({ connectors, home: dir });
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.sourceConnector).toBe("claude-code"); // first wins
  });

  it("preserves a Gemini hash projectKey while resolving rootPath to the real path", async () => {
    const root = makeRepo(
      "420ai",
      "m5-project-mapping",
      "https://github.com/seanrobertwright/420AI.git",
    );
    const hash = "2025fdb554a6deadbeef";
    const connectors = [fakeConnector("gemini-cli", [{ projectKey: hash, rootPath: root }])];
    const { workspaces } = await discoverWorkspaces({ connectors, home: dir });
    expect(workspaces).toHaveLength(1);
    // the join key stays the hash; the resolved path drives git enrichment
    expect(workspaces[0]!.projectKey).toBe(hash);
    expect(workspaces[0]!.rootPath).toBe(root);
    expect(workspaces[0]!.gitRemote).toBe("https://github.com/seanrobertwright/420AI.git");
  });

  it("counts hints with no rootPath as unresolved (the Gemini hash-only gap)", async () => {
    const connectors = [
      fakeConnector("gemini-cli", [
        { projectKey: "hash-with-sidecar", rootPath: join(dir, "nope") },
        { projectKey: "legacy-hash-1" }, // no rootPath
        { projectKey: "legacy-hash-2" }, // no rootPath
      ]),
    ];
    const { workspaces, unresolved } = await discoverWorkspaces({ connectors, home: dir });
    expect(unresolved).toBe(2);
    expect(workspaces).toHaveLength(1);
  });

  it("skips connectors that do not implement discoverRoots", async () => {
    const plain: Connector = {
      id: "no-discovery",
      fidelity: {
        status: "experimental",
        captureMethod: "test",
        liveness: "snapshot",
        tokens: "none",
        cost: "none",
        knownGaps: [],
        requiredPermissions: [],
      },
      watchGlobs: () => [],
      parse: (): ParseResult => ({ rawRecords: [], events: [], skippedLines: 0 }),
    };
    const { workspaces, unresolved } = await discoverWorkspaces({ connectors: [plain], home: dir });
    expect(workspaces).toHaveLength(0);
    expect(unresolved).toBe(0);
  });
});
