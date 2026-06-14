import { describe, it, expect } from "vitest";
import { basenameFromRoot, repoNameFromRemote } from "./discovery.js";

describe("basenameFromRoot", () => {
  it("takes the last segment of a Windows path", () => {
    expect(basenameFromRoot("C:\\Users\\seanr\\OneDrive\\Documents\\420AI")).toBe("420AI");
  });
  it("takes the last segment of a POSIX path", () => {
    expect(basenameFromRoot("/home/seanr/work/420ai")).toBe("420ai");
  });
  it("ignores a trailing separator", () => {
    expect(basenameFromRoot("/home/seanr/work/420ai/")).toBe("420ai");
    expect(basenameFromRoot("C:\\repo\\")).toBe("repo");
  });
});

describe("repoNameFromRemote", () => {
  it("strips the host, path, and .git suffix from an https remote", () => {
    expect(repoNameFromRemote("https://github.com/seanrobertwright/420AI.git")).toBe("420AI");
  });
  it("handles an scp-style git@ remote", () => {
    expect(repoNameFromRemote("git@github.com:me/repo.git")).toBe("repo");
  });
  it("handles a remote with no .git suffix", () => {
    expect(repoNameFromRemote("https://example.com/team/thing")).toBe("thing");
  });
});
