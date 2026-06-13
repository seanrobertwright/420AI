import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptField, decryptField } from "./crypto.js";

describe("field encryption (AES-256-GCM)", () => {
  beforeAll(() => {
    // Self-contained: this unit suite supplies its own key (no .env needed).
    process.env.ARCHIVE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips ASCII", () => {
    const s = "hello claude-opus world";
    expect(decryptField(encryptField(s))).toBe(s);
  });

  it("round-trips unicode", () => {
    const s = "café ☕ — 日本語 — 🔐 emoji";
    expect(decryptField(encryptField(s))).toBe(s);
  });

  it("round-trips a ~50KB string", () => {
    const s = "x".repeat(50 * 1024);
    expect(decryptField(encryptField(s))).toBe(s);
  });

  it("uses a fresh IV per call (no ciphertext/IV reuse)", () => {
    const a = encryptField("same plaintext");
    const b = encryptField("same plaintext");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("throws when ciphertext is tampered (GCM integrity)", () => {
    const f = encryptField("integrity matters");
    const raw = Buffer.from(f.ciphertext, "base64");
    raw[0] ^= 0x01; // flip one bit
    const tampered = { ...f, ciphertext: raw.toString("base64") };
    expect(() => decryptField(tampered)).toThrow();
  });

  it("throws when the auth tag is tampered", () => {
    const f = encryptField("integrity matters");
    const raw = Buffer.from(f.tag, "base64");
    raw[0] ^= 0x01;
    const tampered = { ...f, tag: raw.toString("base64") };
    expect(() => decryptField(tampered)).toThrow();
  });

  it("throws on a missing key", () => {
    const saved = process.env.ARCHIVE_ENCRYPTION_KEY;
    delete process.env.ARCHIVE_ENCRYPTION_KEY;
    try {
      expect(() => encryptField("x")).toThrow(/ARCHIVE_ENCRYPTION_KEY is not set/);
    } finally {
      process.env.ARCHIVE_ENCRYPTION_KEY = saved;
    }
  });

  it("throws on a short key", () => {
    const saved = process.env.ARCHIVE_ENCRYPTION_KEY;
    process.env.ARCHIVE_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    try {
      expect(() => encryptField("x")).toThrow(/must be 32 bytes/);
    } finally {
      process.env.ARCHIVE_ENCRYPTION_KEY = saved;
    }
  });
});
