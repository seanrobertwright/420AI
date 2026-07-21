import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreatePushToken, pushTokenPathFor } from "./push-token.js";

/**
 * Pure token module — exercised with a temp `--home` (never the real ~/.420ai). The
 * load-bearing property: generate-once, reload-idempotent, and regenerate on corrupt.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "push-token-"));
}

describe("loadOrCreatePushToken", () => {
  it("first call creates the file + returns created:true; second returns the SAME token, created:false", () => {
    const home = tempHome();
    const first = loadOrCreatePushToken(home);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes → 48 hex chars

    const second = loadOrCreatePushToken(home);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("persists the token under <home>/.420ai/push-token.json", () => {
    const home = tempHome();
    const { token } = loadOrCreatePushToken(home);
    const path = pushTokenPathFor(home);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { token: string };
    expect(onDisk.token).toBe(token);
  });

  it("regenerates a fresh token when the file is corrupt", () => {
    const home = tempHome();
    const first = loadOrCreatePushToken(home);
    writeFileSync(pushTokenPathFor(home), "{ not valid json");
    const regenerated = loadOrCreatePushToken(home);
    expect(regenerated.created).toBe(true);
    expect(regenerated.token).not.toBe(first.token);
    // And it now reloads idempotently.
    expect(loadOrCreatePushToken(home).token).toBe(regenerated.token);
  });

  it("writes the token owner-only (0o600) where the platform honors it", () => {
    if (process.platform === "win32") return; // mode is a no-op on win32
    const home = tempHome();
    loadOrCreatePushToken(home);
    const mode = statSync(pushTokenPathFor(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
