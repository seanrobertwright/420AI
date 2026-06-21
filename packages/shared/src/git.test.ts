import { describe, it, expect } from "vitest";
import { suggestConfidence, ATTRIBUTION_WINDOW_MINUTES, type GitCommitPayload } from "./git.js";

describe("suggestConfidence (§11.4 heuristic core)", () => {
  const cases: {
    name: string;
    minutesDelta: number;
    fileOverlap: number;
    expected: ReturnType<typeof suggestConfidence>;
  }[] = [
    { name: "in-window + overlap → medium", minutesDelta: 5, fileOverlap: 1, expected: "medium" },
    {
      name: "in-window + many overlaps → medium",
      minutesDelta: 0,
      fileOverlap: 9,
      expected: "medium",
    },
    { name: "in-window + no overlap → low", minutesDelta: 10, fileOverlap: 0, expected: "low" },
    {
      name: "negative delta is symmetric (overlap) → medium",
      minutesDelta: -5,
      fileOverlap: 2,
      expected: "medium",
    },
    {
      name: "negative delta is symmetric (no overlap) → low",
      minutesDelta: -29,
      fileOverlap: 0,
      expected: "low",
    },
    {
      name: "exactly at the window edge → still in-window",
      minutesDelta: ATTRIBUTION_WINDOW_MINUTES,
      fileOverlap: 1,
      expected: "medium",
    },
    {
      name: "negative window edge → still in-window",
      minutesDelta: -ATTRIBUTION_WINDOW_MINUTES,
      fileOverlap: 0,
      expected: "low",
    },
    {
      name: "just past the window → null (no suggestion)",
      minutesDelta: ATTRIBUTION_WINDOW_MINUTES + 0.1,
      fileOverlap: 5,
      expected: null,
    },
    { name: "far past negative window → null", minutesDelta: -120, fileOverlap: 3, expected: null },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(suggestConfidence({ minutesDelta: c.minutesDelta, fileOverlap: c.fileOverlap })).toBe(
        c.expected,
      );
    });
  }

  it("exports the §11.4 window constant as 30 minutes", () => {
    expect(ATTRIBUTION_WINDOW_MINUTES).toBe(30);
  });
});

describe("GitCommitPayload shape", () => {
  it("accepts a well-formed commit literal (ISO strings, numstat, files)", () => {
    const commit: GitCommitPayload = {
      commitSha: "9ef9ec0abc",
      repoRootPath: "C:\\Users\\seanr\\OneDrive\\Documents\\420AI",
      gitBranch: "main",
      authorName: "Sean Wright",
      authorEmail: "seanrobertwright@gmail.com",
      authoredAt: "2026-06-16T12:49:10-04:00",
      committedAt: "2026-06-16T12:49:10Z",
      message: "feat(m10): git outcomes",
      parents: ["abc123", "def456"],
      isRevert: false,
      filesChanged: 1,
      insertions: 10,
      deletions: 2,
      files: [{ path: "src/x.ts", status: "modified", insertions: 10, deletions: 2 }],
    };
    expect(commit.files).toHaveLength(1);
    expect(commit.parents).toHaveLength(2);
    // binary-file file change → 0/0 (never NaN)
    const binary: GitFileChangeLike = {
      path: "app-icon.png",
      status: "added",
      insertions: 0,
      deletions: 0,
    };
    expect(binary.insertions + binary.deletions).toBe(0);
  });
});

type GitFileChangeLike = GitCommitPayload["files"][number];
