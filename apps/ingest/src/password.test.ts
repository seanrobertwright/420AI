import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password (scrypt)", () => {
  it("round-trips a hashed password", () => {
    const stored = hashPassword("hunter2");
    expect(verifyPassword("hunter2", stored)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const stored = hashPassword("hunter2");
    expect(verifyPassword("hunter3", stored)).toBe(false);
  });

  it("uses a fresh salt per hash (two hashes of the same password differ)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("returns false (never throws) for malformed stored values", () => {
    expect(verifyPassword("hunter2", "garbage")).toBe(false);
    expect(verifyPassword("hunter2", "scrypt$x")).toBe(false);
    expect(verifyPassword("hunter2", "")).toBe(false);
    expect(verifyPassword("hunter2", "bcrypt$salt$dk")).toBe(false);
  });
});
