import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolveHome, pairSummary } from "./cli.js";
import { credentialsPathFor, queuePathFor, CREDENTIALS_PATH, QUEUE_PATH } from "./identity.js";

/**
 * `--home` exists for one concrete failure: a collector running as a Windows SERVICE under
 * LocalSystem has `homedir()` = `…\config\systemprofile`, so it would read credentials, the queue,
 * and the session globs from the WRONG profile and silently capture nothing. `--home <dir>` repoints
 * all three at the real paired profile. These assert the override works AND that the no-flag default
 * stays byte-identical to the legacy constants (no behavior change for existing users).
 */
describe("resolveHome (--home override)", () => {
  it("uses --home when provided", () => {
    expect(resolveHome(["watch", "--home", "C:\\Users\\seanr"])).toBe("C:\\Users\\seanr");
  });

  it("falls back to the OS home when --home is absent", () => {
    expect(resolveHome(["watch"])).toBe(homedir());
  });

  it("ignores --home belonging to a different reading (only its own value)", () => {
    // A bare trailing --home with no value yields undefined → OS home (not a crash).
    expect(resolveHome(["watch", "--home"])).toBe(homedir());
  });
});

describe("home-relative collector paths (--home moves creds + queue together)", () => {
  it("composes credentials.json and queue.sqlite under <home>/.420ai", () => {
    const home = process.platform === "win32" ? "C:\\svc-home" : "/svc-home";
    expect(credentialsPathFor(home)).toMatch(/[\\/]\.420ai[\\/]credentials\.json$/);
    expect(queuePathFor(home)).toMatch(/[\\/]\.420ai[\\/]queue\.sqlite$/);
    // Both derive from the SAME home (no split-brain between creds and queue).
    expect(credentialsPathFor(home).startsWith(home)).toBe(true);
    expect(queuePathFor(home).startsWith(home)).toBe(true);
  });

  it("default (home = OS home) is byte-identical to the legacy constants — back-compat", () => {
    expect(credentialsPathFor(homedir())).toBe(CREDENTIALS_PATH);
    expect(queuePathFor(homedir())).toBe(QUEUE_PATH);
  });
});

/**
 * The `pair` confirmation must name the path actually written. It previously interpolated the
 * module-level `CREDENTIALS_PATH` constant, which bakes in `homedir()` at import time — so under
 * `--home <dir>` the file landed in `<dir>/.420ai` while the message named `~/.420ai`. The failure
 * mode is entirely human: an operator pairing into an isolated clean room reads that line and
 * concludes it clobbered their real credentials.
 *
 * The second assertion is the discriminator. Asserting only that the resolved path appears would
 * still pass a message that printed BOTH; asserting the OS-home constant is absent is what actually
 * pins the substitution.
 */
describe("pairSummary (the `pair` confirmation names the --home-resolved path)", () => {
  const res = { machineId: "m-123", token: "tok-abc" };
  const home = process.platform === "win32" ? "C:\\cleanroom" : "/cleanroom";

  it("names the --home-resolved credentials path, not the OS-home constant", () => {
    const out = pairSummary(res, home);
    expect(out).toContain(credentialsPathFor(home));
    // The bug: this constant is derived from homedir() at import time and is NOT where we wrote.
    expect(out).not.toContain(CREDENTIALS_PATH);
  });

  it("still names the OS-home path when no --home was given", () => {
    expect(pairSummary(res, homedir())).toContain(CREDENTIALS_PATH);
  });

  it("reports the machine id and token it was handed", () => {
    const out = pairSummary(res, home);
    expect(out).toContain("m-123");
    expect(out).toContain("tok-abc");
  });
});
