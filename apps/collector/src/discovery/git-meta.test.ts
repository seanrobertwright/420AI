import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitMeta } from "./git-meta.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-meta-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a `.git/HEAD` + `.git/config` into `dir`. */
function writeGit(head: string, config?: string): void {
  const gitDir = join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), head, "utf8");
  if (config !== undefined) writeFileSync(join(gitDir, "config"), config, "utf8");
}

describe("readGitMeta", () => {
  it("parses remote + branch from .git/HEAD and .git/config ([VERIFIED] formats)", () => {
    writeGit(
      "ref: refs/heads/m5-project-mapping\n",
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/seanrobertwright/420AI.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(readGitMeta(dir)).toEqual({
      remote: "https://github.com/seanrobertwright/420AI.git",
      branch: "m5-project-mapping",
    });
  });

  it("parses an scp-style git@ remote and a feature branch", () => {
    writeGit("ref: refs/heads/feature-x\n", '[remote "origin"]\n\turl = git@github.com:me/repo.git\n');
    expect(readGitMeta(dir)).toEqual({ remote: "git@github.com:me/repo.git", branch: "feature-x" });
  });

  it("returns {} when there is no .git directory", () => {
    expect(readGitMeta(dir)).toEqual({});
  });

  it("returns branch undefined for a detached HEAD (bare sha)", () => {
    writeGit("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e\n", '[remote "origin"]\n\turl = https://x/y.git\n');
    const meta = readGitMeta(dir);
    expect(meta.branch).toBeUndefined();
    expect(meta.remote).toBe("https://x/y.git");
  });

  it("returns remote undefined when there is no origin remote", () => {
    writeGit("ref: refs/heads/main\n", "[core]\n\tbare = false\n");
    expect(readGitMeta(dir)).toEqual({ remote: undefined, branch: "main" });
  });
});
