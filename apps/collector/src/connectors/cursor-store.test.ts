import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCursorStore, defaultCursorStorePath } from "./cursor-store.js";

/**
 * The store layer is exercised against a REAL vscdb the test builds itself with the
 * spike-proven key formats (composerData:%, bubbleId:<composerId>:<bubbleId>), including
 * a NULL-value bubble and a zero-bubble composer. An ItemTable row carrying a secret is
 * seeded to PROVE the reader never touches it.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function buildFixtureStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-store-"));
  tempDirs.push(dir);
  const path = join(dir, "state.vscdb");
  const db = new DatabaseSync(path);
  // Values are BLOBs in the real store — build them as Buffers so the reader's Uint8Array
  // coercion path (not just the string path) is exercised.
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const ins = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  ins.run("composerData:compA", Buffer.from(JSON.stringify({ composerId: "compA" })));
  ins.run("composerData:compB", Buffer.from(JSON.stringify({ composerId: "compB" }))); // zero bubbles
  ins.run("bubbleId:compA:b1", Buffer.from(JSON.stringify({ type: 1, text: "hello" })));
  ins.run("bubbleId:compA:b2", null); // NULL value — must be filtered out
  // A secret that lives ONLY in ItemTable — the reader must never surface it.
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "aiSettings",
    Buffer.from("SECRET_TOKEN_should_never_be_read"),
  );
  db.close();
  return path;
}

describe("openCursorStore", () => {
  it("sweeps composers and strips the composerData: prefix", () => {
    const store = openCursorStore(buildFixtureStore());
    try {
      const composers = store.listComposers();
      expect(composers.map((c) => c.id).sort()).toEqual(["compA", "compB"]);
      // BLOB value coerced to a JSON string.
      expect(JSON.parse(composers.find((c) => c.id === "compA")!.value).composerId).toBe("compA");
    } finally {
      store.close();
    }
  });

  it("fetches bubbles per composer, filtering NULL values", () => {
    const store = openCursorStore(buildFixtureStore());
    try {
      const bubbles = store.bubblesFor("compA");
      expect(bubbles).toHaveLength(1); // b2 (NULL) filtered
      expect(bubbles[0]!.key).toBe("bubbleId:compA:b1");
      expect(JSON.parse(bubbles[0]!.value).text).toBe("hello");
    } finally {
      store.close();
    }
  });

  it("returns an empty array for a zero-bubble composer", () => {
    const store = openCursorStore(buildFixtureStore());
    try {
      expect(store.bubblesFor("compB")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("never reads ItemTable — the seeded secret cannot appear in any output", () => {
    const store = openCursorStore(buildFixtureStore());
    try {
      const surface = JSON.stringify([
        store.listComposers(),
        store.bubblesFor("compA"),
        store.bubblesFor("compB"),
      ]);
      expect(surface).not.toContain("SECRET_TOKEN");
      expect(surface).not.toContain("aiSettings");
    } finally {
      store.close();
    }
  });

  it("opens read-only (a second reader can open the same store concurrently)", () => {
    const path = buildFixtureStore();
    const a = openCursorStore(path);
    const b = openCursorStore(path);
    try {
      expect(a.listComposers()).toHaveLength(2);
      expect(b.listComposers()).toHaveLength(2);
    } finally {
      a.close();
      b.close();
    }
  });

  it("throws on a missing store (caller treats it as unavailable)", () => {
    expect(() => openCursorStore(join(tmpdir(), "does-not-exist-420ai.vscdb"))).toThrow();
  });

  it("derives the default path under APPDATA", () => {
    const prev = process.env.APPDATA;
    process.env.APPDATA = join("C:", "Users", "x", "AppData", "Roaming");
    try {
      const p = defaultCursorStorePath().replace(/\\/g, "/");
      expect(p).toContain("Cursor/User/globalStorage/state.vscdb");
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
    }
  });
});
