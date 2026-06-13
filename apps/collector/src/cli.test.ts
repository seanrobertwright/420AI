import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIngest, runReport } from "./cli.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/sample-session.jsonl", import.meta.url),
);

let dbPath: string | undefined;

afterEach(() => {
  if (dbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
    dbPath = undefined;
  }
});

describe("cli end-to-end (parse → store → report)", () => {
  it("ingests the fixture and renders a report with cost and tokens", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-e2e.sqlite`);
    const summary = runIngest(fixturePath, dbPath);
    expect(summary.sessionId).toBe("sess-fixture-1");
    expect(summary.skippedLines).toBe(1);

    const md = runReport("sess-fixture-1", dbPath);
    expect(md).toContain("# Session Report — sess-fixture-1");
    expect(md).toContain("| 100 | 50 | 30 | 20 | 200 |");
    expect(md).toContain("`estimated-model-known`");
  });

  it("is idempotent across the whole pipe (ingest twice → stable event count)", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-idem.sqlite`);
    const first = runIngest(fixturePath, dbPath);
    const second = runIngest(fixturePath, dbPath);
    expect(second.events).toBe(first.events);

    // And the report still renders identically.
    const md1 = runReport("sess-fixture-1", dbPath);
    const md2 = runReport("sess-fixture-1", dbPath);
    expect(md2).toBe(md1);
  });

  it("throws a clear error reporting an unknown session", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-missing.sqlite`);
    runIngest(fixturePath, dbPath);
    expect(() => runReport("does-not-exist", dbPath)).toThrow(/No events for session/);
  });
});
