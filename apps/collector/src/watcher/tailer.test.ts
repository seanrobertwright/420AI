import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGrownPrefix } from "./tailer.js";

let dir: string | undefined;

function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "m3-tailer-"));
  return join(dir, "session.jsonl");
}

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    dir = undefined;
  }
});

describe("readGrownPrefix (PRE-FLIGHT #4)", () => {
  it("emits two complete appended lines and advances the cursor to the 2nd newline", () => {
    const path = tmpFile();
    writeFileSync(path, "line1\nline2\n", "utf8");
    const r = readGrownPrefix(path, 0);
    expect(r.grew).toBe(true);
    expect(r.reset).toBe(false);
    expect(r.text).toBe("line1\nline2\n");
    expect(r.newOffset).toBe(Buffer.byteLength("line1\nline2\n"));
  });

  it("holds back a partial trailing line (no newline) and does not advance the cursor", () => {
    const path = tmpFile();
    writeFileSync(path, "line1\nline2\n", "utf8");
    const after = readGrownPrefix(path, 0).newOffset;

    appendFileSync(path, "partial-no-newline", "utf8");
    const r = readGrownPrefix(path, after);
    expect(r.grew).toBe(false);
    expect(r.text).toBe("");
    expect(r.newOffset).toBe(after);
  });

  it("emits the completed line exactly once after the newline arrives", () => {
    const path = tmpFile();
    writeFileSync(path, "line1\n", "utf8");
    const after = readGrownPrefix(path, 0).newOffset;

    appendFileSync(path, "line2-partial", "utf8");
    expect(readGrownPrefix(path, after).grew).toBe(false);

    appendFileSync(path, "\n", "utf8"); // complete it
    const r = readGrownPrefix(path, after);
    expect(r.grew).toBe(true);
    expect(r.text).toBe("line1\nline2-partial\n"); // whole-file prefix
    expect(r.newOffset).toBe(Buffer.byteLength("line1\nline2-partial\n"));
  });

  it("re-sends zero lines on resume when the file has not grown", () => {
    const path = tmpFile();
    writeFileSync(path, "line1\nline2\n", "utf8");
    const after = readGrownPrefix(path, 0).newOffset;
    const r = readGrownPrefix(path, after);
    expect(r.grew).toBe(false);
    expect(r.text).toBe("");
    expect(r.newOffset).toBe(after);
  });

  it("detects truncation and re-reads from 0", () => {
    const path = tmpFile();
    writeFileSync(path, "line1\nline2\nline3\n", "utf8");
    const after = readGrownPrefix(path, 0).newOffset;

    // Replace with shorter content (truncation / rotation).
    writeFileSync(path, "fresh\n", "utf8");
    const r = readGrownPrefix(path, after);
    expect(r.reset).toBe(true);
    expect(r.grew).toBe(true);
    expect(r.text).toBe("fresh\n");
    expect(r.newOffset).toBe(Buffer.byteLength("fresh\n"));
  });
});
