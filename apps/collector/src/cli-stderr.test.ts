import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * M16 16.6 F4 — the exit-path stderr write must be SYNCHRONOUS.
 *
 * `process.stderr.write` is asynchronous for some stdio targets and `process.exit` does not flush
 * pending asynchronous writes, so `process.stderr.write(msg); process.exit(1)` can silently drop the
 * message when stderr is a pipe (`collector watch … | tee log.txt`). That message is the ONE
 * human-readable notice this slice adds, on the one path where the process is deliberately about to
 * die — the same class of loss the whole slice exists to end.
 *
 * The test asserts the MECHANISM rather than trying to reproduce the truncation, because whether a
 * pipe flushes in time is platform- and buffer-dependent (Node documents pipe stdio as synchronous
 * on some platforms and asynchronous on others). A test that "passes on this machine" would be the
 * fifth member of the family the 16.6 review named: a test that cannot fail, guarding the thing you
 * were worried about. What is checkable everywhere is that the bytes go to fd 2 through
 * `fs.writeSync`, which is unconditionally synchronous.
 *
 * `node:fs` is mocked ONLY in this file (a whole-file hoisted mock), with every other export passed
 * through untouched — `cli.ts` reads files at import time and the other cli tests must keep the real
 * implementations.
 */
const { writeSyncSpy } = vi.hoisted(() => ({ writeSyncSpy: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual, writeSync: writeSyncSpy };
});

const { writeStderrSync } = await import("./cli.js");

describe("writeStderrSync (M16 16.6 F4 — a notice that cannot be lost to an unflushed buffer)", () => {
  beforeEach(() => {
    writeSyncSpy.mockReset();
  });

  it("writes to fd 2 via fs.writeSync, not process.stderr.write", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      writeStderrSync("Capture stopped: token revoked\n");

      expect(writeSyncSpy).toHaveBeenCalledTimes(1);
      expect(writeSyncSpy).toHaveBeenCalledWith(2, "Capture stopped: token revoked\n");
      // The async writer must not be the one carrying it — that is the whole defect.
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  /**
   * A raw `writeSync` on a non-blocking fd can throw EAGAIN. Losing the notice to an exception —
   * which on the `watch` path would replace exit 1 with an unhandled throw — would be strictly worse
   * than losing it to a flush, so the fallback is deliberate.
   */
  it("falls back to process.stderr.write rather than throwing", () => {
    writeSyncSpy.mockImplementation(() => {
      throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(() => writeStderrSync("still says something\n")).not.toThrow();
      expect(stderrWrite).toHaveBeenCalledWith("still says something\n");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
