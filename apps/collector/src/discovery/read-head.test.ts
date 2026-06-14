import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanLines } from "./read-head.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-head-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("scanLines", () => {
  it("returns the first matching line and stops early", () => {
    const seen: string[] = [];
    const p = write("a.txt", "one\ntwo\nMATCH-three\nfour\n");
    const result = scanLines(p, (line) => {
      seen.push(line);
      return line.startsWith("MATCH") ? line : undefined;
    });
    expect(result).toBe("MATCH-three");
    // did NOT read past the match (line 4 never visited)
    expect(seen).toEqual(["one", "two", "MATCH-three"]);
  });

  it("reassembles lines split across small chunk boundaries", () => {
    const cwd = "C:\\Users\\seanr\\OneDrive\\Documents\\420AI";
    const line = JSON.stringify({ type: "user", cwd });
    const p = write("b.jsonl", "noise-without-cwd\n" + line + "\n");
    const result = scanLines<string>(
      p,
      (l) => {
        try {
          const o = JSON.parse(l) as { cwd?: string };
          return o.cwd;
        } catch {
          return undefined;
        }
      },
      { chunkSize: 8 }, // tiny — forces the JSON line to span many chunks
    );
    expect(result).toBe(cwd);
  });

  it("preserves multi-byte UTF-8 across a chunk boundary", () => {
    const value = "café—naïve—日本語";
    const line = JSON.stringify({ v: value });
    const p = write("c.json", line + "\n");
    const result = scanLines<string>(
      p,
      (l) => {
        try {
          return (JSON.parse(l) as { v?: string }).v;
        } catch {
          return undefined;
        }
      },
      { chunkSize: 4 }, // splits multibyte sequences
    );
    expect(result).toBe(value);
  });

  it("handles a final line with no trailing newline", () => {
    const p = write("d.txt", "alpha\nbeta");
    const result = scanLines(p, (l) => (l === "beta" ? l : undefined));
    expect(result).toBe("beta");
  });

  it("returns undefined when nothing matches", () => {
    const p = write("e.txt", "x\ny\nz\n");
    expect(scanLines(p, () => undefined)).toBeUndefined();
  });

  it("returns undefined on a missing file (no throw)", () => {
    expect(scanLines(join(dir, "nope.txt"), () => "x")).toBeUndefined();
  });

  it("gives up at maxBytes on a pathological newline-less file", () => {
    const p = write("f.txt", "a".repeat(10_000)); // no newline
    let calls = 0;
    const result = scanLines(
      p,
      () => {
        calls += 1;
        return undefined;
      },
      { chunkSize: 64, maxBytes: 256 },
    );
    expect(result).toBeUndefined();
    // capped before reading the whole file (only the trailing flush calls onLine)
    expect(calls).toBeLessThanOrEqual(1);
  });
});
