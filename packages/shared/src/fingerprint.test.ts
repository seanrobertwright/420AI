import { describe, it, expect } from "vitest";
import { eventFingerprint } from "./fingerprint.js";

describe("eventFingerprint", () => {
  it("is deterministic for identical input", () => {
    const a = eventFingerprint("claude-code", "rec-1", 0, "message.assistant");
    const b = eventFingerprint("claude-code", "rec-1", 0, "message.assistant");
    expect(a).toBe(b);
  });

  it("returns a 64-char sha256 hex digest", () => {
    const fp = eventFingerprint("claude-code", "rec-1", 0, "message.assistant");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY field changes", () => {
    const base = eventFingerprint("claude-code", "rec-1", 0, "message.assistant");
    expect(eventFingerprint("codex", "rec-1", 0, "message.assistant")).not.toBe(base);
    expect(eventFingerprint("claude-code", "rec-2", 0, "message.assistant")).not.toBe(base);
    expect(eventFingerprint("claude-code", "rec-1", 1, "message.assistant")).not.toBe(base);
    expect(eventFingerprint("claude-code", "rec-1", 0, "usage.reported")).not.toBe(base);
  });

  it("does not collide across delimiter boundaries", () => {
    // "a" + "|" + "b" must differ from "a|b" + "|" + "" — the | delimiter guards this.
    const x = eventFingerprint("a", "b", 0, "t");
    const y = eventFingerprint("a|b", "", 0, "t");
    expect(x).not.toBe(y);
  });
});
