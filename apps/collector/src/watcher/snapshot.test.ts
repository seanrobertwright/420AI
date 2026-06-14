import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot } from "./snapshot.js";

let dir: string | undefined;

function tempFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "m4-snapshot-"));
  const path = join(dir, "session.json");
  writeFileSync(path, content, "utf8");
  return path;
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

describe("readSnapshot", () => {
  it("reads the whole file on the first call (no prev)", () => {
    const path = tempFile('{"a":1}');
    const snap = readSnapshot(path);
    expect(snap.changed).toBe(true);
    expect(snap.text).toBe('{"a":1}');
    expect(snap.sizeBytes).toBe(Buffer.byteLength('{"a":1}'));
  });

  it("returns changed:false and skips the read when size+mtime are unchanged", () => {
    const path = tempFile('{"a":1}');
    const stat = statSync(path);
    const snap = readSnapshot(path, { sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    expect(snap.changed).toBe(false);
    expect(snap.text).toBe(""); // no read performed
  });

  it("returns changed:true with full text when size differs", () => {
    const path = tempFile('{"a":1}');
    const stat = statSync(path);
    // Simulate a prior read at a different (smaller) size → change detected.
    const snap = readSnapshot(path, { sizeBytes: stat.size - 1, mtimeMs: stat.mtimeMs });
    expect(snap.changed).toBe(true);
    expect(snap.text).toBe('{"a":1}');
  });

  it("detects a rewrite that changes the content length", () => {
    const path = tempFile('{"messages":[]}');
    const first = readSnapshot(path);
    writeFileSync(path, '{"messages":[{"id":"m1"}]}', "utf8");
    const second = readSnapshot(path, { sizeBytes: first.sizeBytes, mtimeMs: first.mtimeMs });
    expect(second.changed).toBe(true);
    expect(second.text).toContain("m1");
  });
});
