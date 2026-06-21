import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "./sqlite-store.js";
import { parseClaudeCodeSession } from "../connectors/claude-code.js";

const fixture = readFileSync(new URL("../fixtures/sample-session.jsonl", import.meta.url), "utf8");

let dbPath: string | undefined;

afterEach(() => {
  if (dbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* file may not exist */
      }
    }
    dbPath = undefined;
  }
});

function freshStore(label: string): SqliteStore {
  dbPath = join(tmpdir(), `m1-test-${process.pid}-${label}.sqlite`);
  try {
    rmSync(dbPath);
  } catch {
    /* fresh */
  }
  return new SqliteStore(dbPath);
}

describe("SqliteStore", () => {
  it("stores events and reads them back for a session", () => {
    const store = freshStore("read");
    const parsed = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    store.insertRawRecords(parsed.rawRecords);
    store.upsertEvents(parsed.events);

    const events = store.getSessionEvents("sess-fixture-1");
    expect(events.length).toBe(parsed.events.length);
    store.close();
  });

  it("is idempotent: re-ingesting the same parse result does not add events", () => {
    const store = freshStore("idem");
    const parsed = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });

    store.insertRawRecords(parsed.rawRecords);
    store.upsertEvents(parsed.events);
    const firstCount = store.getSessionEvents("sess-fixture-1").length;

    // Ingest the SAME data again — upsert by fingerprint = no new rows.
    store.insertRawRecords(parsed.rawRecords);
    store.upsertEvents(parsed.events);
    const secondCount = store.getSessionEvents("sess-fixture-1").length;

    expect(secondCount).toBe(firstCount);
    store.close();
  });

  it("round-trips token and cost JSON columns intact", () => {
    const store = freshStore("roundtrip");
    const parsed = parseClaudeCodeSession(fixture, { ingestedAt: "2026-06-13T00:00:00Z" });
    store.insertRawRecords(parsed.rawRecords);
    store.upsertEvents(parsed.events);

    const events = store.getSessionEvents("sess-fixture-1");
    const usage = events.find((e) => e.eventType === "usage.reported");
    const cost = events.find((e) => e.eventType === "cost.estimated");

    expect(usage!.tokens!.total).toBe(200);
    expect(cost!.cost!.usd).toBeGreaterThan(0);
    expect(cost!.cost!.confidence).toBe("estimated-model-known");
    store.close();
  });
});
