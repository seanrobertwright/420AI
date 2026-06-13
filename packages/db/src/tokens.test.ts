import { describe, it, expect } from "vitest";
import { generateToken, hashToken } from "./tokens.js";

describe("ingest token helpers", () => {
  it("hashToken is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("different tokens hash to different values", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });

  it("hashToken produces 64-hex-char sha256 digests", () => {
    expect(hashToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateToken returns distinct values across calls", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
  });
});
