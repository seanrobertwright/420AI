import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGeminiProjectRoots } from "./gemini-roots.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gemini-roots-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Create `~/.gemini/tmp/<dirName>` and optionally its `.project_root` sidecar. */
function mkTmpDir(dirName: string, projectRoot?: string): void {
  const d = join(home, ".gemini", "tmp", dirName);
  mkdirSync(d, { recursive: true });
  if (projectRoot !== undefined) writeFileSync(join(d, ".project_root"), projectRoot, "utf8");
}

describe("scanGeminiProjectRoots", () => {
  it("maps a dir WITH a .project_root to its real path (dirName == projectHash)", () => {
    mkTmpDir("2025fdb554a6deadbeef", "c:\\users\\seanr\\onedrive\\documents\\420ai\n");
    const map = scanGeminiProjectRoots(home);
    expect(map.get("2025fdb554a6deadbeef")).toBe("c:\\users\\seanr\\onedrive\\documents\\420ai");
  });

  it("omits dirs that have no .project_root sidecar (legacy hash-only → unattributed)", () => {
    mkTmpDir("has-sidecar", "/real/path");
    mkTmpDir("no-sidecar"); // legacy hash-only generation
    const map = scanGeminiProjectRoots(home);
    expect(map.has("has-sidecar")).toBe(true);
    expect(map.has("no-sidecar")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when there is no ~/.gemini/tmp", () => {
    expect(scanGeminiProjectRoots(home).size).toBe(0);
  });
});
