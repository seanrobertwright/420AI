import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { saveFault, loadFault, clearFault, faultPathFor, type CaptureFault } from "./fault.js";

/**
 * M16 16.6 — the durable capture fault record.
 *
 * INC-2026-07 ran for ~8 days with a revoked token and left no local trace at all. These pin the
 * three properties that make the file worth having: it survives the process, it never throws on a
 * bad read, it clears itself, and it carries no secret.
 */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "m16-fault-"));
  homes.push(home);
  return home;
}

const sample: CaptureFault = {
  code: "auth_revoked",
  message:
    "the archive rejected this collector's token (401) — re-pair with `collector pair <code>`",
  since: "2026-08-06T12:00:00.000Z",
  url: "https://archive.example/",
};

describe("fault record (M16 16.6)", () => {
  it("round-trips save → load, stamping the first observation", () => {
    const path = faultPathFor(tempHome());
    saveFault(sample, path);
    expect(loadFault(path)).toEqual({ ...sample, lastObservedAt: sample.since });
  });

  /**
   * F2 — `since` must survive a restart, because the restart is CAUSED by the fault.
   *
   * WinSW restarts the collector on every non-zero exit (5/10/20 s), and each restart re-observes
   * the same 401. Overwriting `since` on every save therefore reported an eight-day INC-2026-07 as
   * "since ~20 seconds ago" — destroying the one number the record exists to answer.
   */
  it("preserves the ORIGINAL since across re-saves of the same fault, moving lastObservedAt", () => {
    const path = faultPathFor(tempHome());
    saveFault(sample, path);
    saveFault({ ...sample, since: "2026-08-14T09:31:04.220Z" }, path);

    const stored = loadFault(path);
    expect(stored?.since).toBe("2026-08-06T12:00:00.000Z"); // the outage started here
    expect(stored?.lastObservedAt).toBe("2026-08-14T09:31:04.220Z"); // …and is still happening
  });

  it("a DIFFERENT archive url starts a new clock (it is a different fault)", () => {
    const path = faultPathFor(tempHome());
    saveFault(sample, path);
    saveFault(
      { ...sample, url: "https://other.example/", since: "2026-08-14T09:31:04.220Z" },
      path,
    );

    const stored = loadFault(path);
    expect(stored?.since).toBe("2026-08-14T09:31:04.220Z");
    expect(stored?.lastObservedAt).toBe("2026-08-14T09:31:04.220Z");
  });

  it("creates the collector home if it does not exist yet (fresh --home)", () => {
    const path = faultPathFor(tempHome());
    expect(existsSync(dirname(path))).toBe(false);
    saveFault(sample, path);
    expect(existsSync(path)).toBe(true);
  });

  it("returns undefined for a missing file", () => {
    expect(loadFault(faultPathFor(tempHome()))).toBeUndefined();
  });

  it("tolerates a corrupt file rather than throwing (mirrors loadCredentials)", () => {
    const path = faultPathFor(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(() => loadFault(path)).not.toThrow();
    expect(loadFault(path)).toBeUndefined();
  });

  /**
   * F13 — a cast is not a check. `{}` is valid JSON, so the old `as CaptureFault` handed callers a
   * record whose `message`/`since` were `undefined`; those reach `saveFault`'s continuity check,
   * the CLI's stderr line and the desktop's error event as the literal string "undefined".
   */
  it("rejects a well-formed JSON file of the WRONG SHAPE, exactly like a corrupt one", () => {
    const path = faultPathFor(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    for (const body of [
      "{}",
      '"a string"',
      "null",
      '{ "code": "something_else", "message": "m", "since": "s", "url": "u" }',
      '{ "code": "auth_revoked", "since": "s", "url": "u" }', // no message
      '{ "code": "auth_revoked", "message": "m", "url": "u" }', // no since
      '{ "code": "auth_revoked", "message": "m", "since": 12345, "url": "u" }', // wrong type
    ]) {
      writeFileSync(path, body);
      expect(loadFault(path), body).toBeUndefined();
    }
  });

  it("clearFault removes the record, making the signal self-resolving", () => {
    const path = faultPathFor(tempHome());
    saveFault(sample, path);
    clearFault(path);
    expect(existsSync(path)).toBe(false);
    expect(loadFault(path)).toBeUndefined();
  });

  it("clearFault on a missing file is a no-op, not a throw", () => {
    const path = faultPathFor(tempHome());
    expect(() => clearFault(path)).not.toThrow();
  });

  it("faultPathFor routes through the collector home, so --home moves it with creds + queue", () => {
    // The Windows service runs `watch --home C:\Users\<you>` as LocalSystem; a fault file that did
    // not follow `--home` would be written under `…\config\systemprofile\.420ai\` and never read.
    expect(faultPathFor(join("C:", "x"))).toBe(join("C:", "x", ".420ai", "fault.json"));
  });

  it("persists NO token — the record says a credential was rejected, never which one", () => {
    const path = faultPathFor(tempHome());
    saveFault({ ...sample, url: "https://archive.example/" }, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toMatch(/token"\s*:/);
    expect(raw).not.toMatch(/Bearer/i);
    // Exactly the documented keys — a future field cannot smuggle a secret in unnoticed.
    expect(Object.keys(JSON.parse(raw) as CaptureFault).sort()).toEqual([
      "code",
      "lastObservedAt",
      "message",
      "since",
      "url",
    ]);
  });
});
