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

  /**
   * M16 16.7 — THE `!== "auth_revoked"` TRAP, closed by a test.
   *
   * `loadFault`'s validator read `if (rec.code !== "auth_revoked") return undefined` when that was
   * the only code. Adding a second code without widening it would have made every
   * `archive_unreachable` record read back as a CORRUPT FILE — written by `saveFault`, rejected by
   * `loadFault` — so the startup announcement would say nothing, the `(code, url)` continuity would
   * restart the `since` clock on every observation, and the whole feature would silently do nothing
   * while every test that only WRITES stayed green. This is the read-back that catches it.
   */
  it("round-trips the DEGRADED archive_unreachable code (the !== auth_revoked trap)", () => {
    const path = faultPathFor(tempHome());
    const degraded: CaptureFault = { ...sample, code: "archive_unreachable", message: "down" };
    saveFault(degraded, path);
    const stored = loadFault(path);
    expect(stored).toEqual({ ...degraded, lastObservedAt: degraded.since });
    expect(stored?.code).toBe("archive_unreachable");
  });

  it("rejects an UNKNOWN code as corrupt (the check is set membership, not `!== undefined`)", () => {
    const path = faultPathFor(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...sample, code: "disk_full" }));
    expect(loadFault(path)).toBeUndefined();
  });

  /**
   * M16 16.7 — a code change is a DIFFERENT fault, so it starts a new clock. That is `saveFault`'s
   * existing `(code, url)` continuity rule and this is the case it was written for but could never
   * previously exercise, there having been only one code.
   *
   * The sequence is the real one: the archive is unreachable for a while, comes back, and answers
   * 401 because the credential was revoked in the meantime. The 401's `since` must be when the 401
   * started — reporting it as "since the network went down" would attribute a revocation to an
   * outage that had already ended.
   */
  it("unreachable → auth_revoked starts a NEW since (a different code is a different fault)", () => {
    const path = faultPathFor(tempHome());
    saveFault({ ...sample, code: "archive_unreachable" }, path);
    saveFault({ ...sample, code: "auth_revoked", since: "2026-08-14T09:31:04.220Z" }, path);

    const stored = loadFault(path);
    expect(stored?.code).toBe("auth_revoked");
    expect(stored?.since).toBe("2026-08-14T09:31:04.220Z");
  });

  it("preserves since across re-stamps of the SAME degraded fault (the sparse re-stamp path)", () => {
    const path = faultPathFor(tempHome());
    const degraded: CaptureFault = { ...sample, code: "archive_unreachable" };
    saveFault(degraded, path);
    // What the engine's every-60th-failure re-stamp does: same code, same url, a later instant.
    saveFault({ ...degraded, since: "2026-08-06T12:01:00.000Z" }, path);

    const stored = loadFault(path);
    expect(stored?.since).toBe("2026-08-06T12:00:00.000Z");
    expect(stored?.lastObservedAt).toBe("2026-08-06T12:01:00.000Z");
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
      // OPTIONAL is not UNCHECKED. `lastObservedAt` is read by both entrypoints (they interpolate
      // it into "…, last observed X"), so a number here yields a record whose declared type says
      // `string | undefined` and whose runtime value is neither — the `{}` defect one field over.
      '{ "code": "auth_revoked", "message": "m", "since": "s", "url": "u", "lastObservedAt": 12345 }',
    ]) {
      writeFileSync(path, body);
      expect(loadFault(path), body).toBeUndefined();
    }
  });

  /** …but an ABSENT `lastObservedAt` is legitimate: it is optional, and a pre-16.6-fix file lacks it. */
  it("accepts a record with no lastObservedAt at all (the field is genuinely optional)", () => {
    const path = faultPathFor(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ "code": "auth_revoked", "message": "m", "since": "s", "url": "u" }');
    expect(loadFault(path)).toEqual({ code: "auth_revoked", message: "m", since: "s", url: "u" });
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
