import { describe, it, expect } from "vitest";
import { parseGitLog, type GitCommit } from "./git-reader.js";

/**
 * Build one `git log` record in the EXACT byte layout the pinned `--format` emits
 * (verified Phase-0): `\x1fCOMMIT\x1f` + 8 `\x1f`-delimited header fields, the last
 * field is `<body>\x1e`, then a newline, then the numstat block, then a newline.
 */
function rec(p: {
  sha: string;
  an?: string;
  ae?: string;
  aI?: string;
  cI?: string;
  parents?: string;
  subject: string;
  body?: string;
  numstat?: string;
}): string {
  const an = p.an ?? "Sean Wright";
  const ae = p.ae ?? "sean@example.com";
  const aI = p.aI ?? "2026-06-16T12:00:00-04:00";
  const cI = p.cI ?? aI;
  const parents = p.parents ?? "parent0";
  const body = p.body ?? "";
  const numstat = p.numstat ?? "";
  return `\x1fCOMMIT\x1f${p.sha}\x1f${an}\x1f${ae}\x1f${aI}\x1f${cI}\x1f${parents}\x1f${p.subject}\x1f${body}\x1e\n${numstat}\n`;
}

function bySha(commits: GitCommit[], sha: string): GitCommit {
  const c = commits.find((x) => x.commitSha === sha);
  if (!c) throw new Error(`commit ${sha} not parsed`);
  return c;
}

describe("parseGitLog (the highest-risk parser — Phase-0 edge cases)", () => {
  const fixture = [
    // 1. multi-file commit with a multiline body
    rec({
      sha: "aaa111",
      subject: "feat: multi-file change",
      body: "line one\nline two",
      numstat: "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts",
    }),
    // 2. merge commit: two parents, EMPTY numstat block
    rec({
      sha: "merge22",
      parents: "p1 p2",
      subject: "Merge pull request #21 from x/y",
      body: "",
      numstat: "",
    }),
    // 3. rename: brace form + simple form
    rec({
      sha: "ren333",
      subject: "refactor: move files",
      numstat: "3\t1\tsrc/{old => new}/file.ts\n0\t0\tdocs/a.md => docs/b.md",
    }),
    // 4. binary file: numstat reports -\t-\tpath → 0/0
    rec({
      sha: "bin444",
      subject: "chore: add icon",
      numstat: "-\t-\tassets/app-icon.png",
    }),
    // 5. revert via subject prefix
    rec({
      sha: "rev555",
      subject: 'Revert "feat: something"',
      body: "This reverts commit abc123.",
      numstat: "1\t1\tsrc/x.ts",
    }),
    // 6. revert detected via BODY only (subject does not start with Revert)
    rec({
      sha: "rev666",
      subject: "undo the change",
      body: "This reverts commit def456.",
      numstat: "0\t2\tsrc/y.ts",
    }),
  ].join("");

  const commits = parseGitLog(fixture);

  it("parses every record (no record dropped)", () => {
    expect(commits).toHaveLength(6);
  });

  it("multi-file commit: files, summed counts, multiline message", () => {
    const c = bySha(commits, "aaa111");
    expect(c.files).toHaveLength(2);
    expect(c.filesChanged).toBe(2);
    expect(c.insertions).toBe(15);
    expect(c.deletions).toBe(2);
    expect(c.files[0]).toEqual({ path: "src/a.ts", status: "modified", insertions: 10, deletions: 2 });
    expect(c.message).toContain("feat: multi-file change");
    expect(c.message).toContain("line one\nline two");
    expect(c.isRevert).toBe(false);
  });

  it("merge commit: two parents, empty numstat → 0 files / 0 stats (valid)", () => {
    const c = bySha(commits, "merge22");
    expect(c.parents).toEqual(["p1", "p2"]);
    expect(c.files).toEqual([]);
    expect(c.filesChanged).toBe(0);
    expect(c.insertions).toBe(0);
    expect(c.deletions).toBe(0);
  });

  it("renames: brace form collapses to the new path; simple form takes the new path", () => {
    const c = bySha(commits, "ren333");
    expect(c.files[0]).toEqual({
      path: "src/new/file.ts",
      status: "renamed",
      insertions: 3,
      deletions: 1,
    });
    expect(c.files[1]!.path).toBe("docs/b.md");
    expect(c.files[1]!.status).toBe("renamed");
  });

  it("binary file: -\\t- maps to 0/0 (never NaN)", () => {
    const c = bySha(commits, "bin444");
    expect(c.files[0]).toEqual({
      path: "assets/app-icon.png",
      status: "modified",
      insertions: 0,
      deletions: 0,
    });
    expect(Number.isNaN(c.insertions)).toBe(false);
    expect(c.insertions).toBe(0);
  });

  it("revert detected from the subject prefix AND from the body", () => {
    expect(bySha(commits, "rev555").isRevert).toBe(true);
    expect(bySha(commits, "rev666").isRevert).toBe(true);
  });

  it("an empty/whitespace stdout parses to no commits", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\n\n")).toEqual([]);
  });
});
