import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptField, decryptField, activeKeyId, type EncryptedField } from "./crypto.js";

/**
 * M12 12.4e keyring-mode tests — the executable form of Spike C. The EXISTING crypto.test.ts
 * (single-key mode) must still pass unchanged; THIS file exercises the keyring path. Each case
 * sets/clears the keyring env and restores it in afterEach so cases don't leak into each other.
 */
const K_LEGACY = randomBytes(32).toString("base64");
const K_V2 = randomBytes(32).toString("base64");

function setKeyring(activeId: string, keys: Record<string, string>): void {
  process.env.ARCHIVE_ENCRYPTION_KEYS = JSON.stringify(keys);
  process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID = activeId;
}

function clearAll(): void {
  delete process.env.ARCHIVE_ENCRYPTION_KEYS;
  delete process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID;
  delete process.env.ARCHIVE_ENCRYPTION_KEY;
}

describe("field encryption — keyring mode (M12 12.4e)", () => {
  afterEach(clearAll);

  it("legacy single-key round-trips and emits UN-prefixed ciphertext (byte-compat)", () => {
    process.env.ARCHIVE_ENCRYPTION_KEY = K_LEGACY;
    const f = encryptField("legacy secret");
    expect(f.ciphertext.includes(".")).toBe(false); // bare base64, no keyId prefix
    expect(decryptField(f)).toBe("legacy secret");
    expect(activeKeyId()).toBe("legacy");
  });

  it("a legacy (un-prefixed) row decrypts after upgrading to keyring mode", () => {
    // Encrypt under the single-key legacy deployment…
    process.env.ARCHIVE_ENCRYPTION_KEY = K_LEGACY;
    const f = encryptField("written before rotation");
    // …then upgrade to a keyring that carries the SAME key under the "legacy" id + a new active.
    clearAll();
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    expect(decryptField(f)).toBe("written before rotation"); // un-prefixed → resolves to "legacy"
  });

  it("keyring active=v2 prefixes 'v2.' and round-trips", () => {
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    const f = encryptField("new world");
    expect(f.ciphertext.startsWith("v2.")).toBe(true);
    expect(decryptField(f)).toBe("new world");
    expect(activeKeyId()).toBe("v2");
  });

  it("a field written when active=legacy still decrypts after the active flips to v2", () => {
    // Keyring where legacy is the active id → bare base64 (legacy id is special-cased no-prefix).
    setKeyring("legacy", { legacy: K_LEGACY, v2: K_V2 });
    const f = encryptField("coexists across an active flip");
    expect(f.ciphertext.includes(".")).toBe(false);
    // Flip active to v2; the old field must still decrypt (its key is still in the ring).
    clearAll();
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    expect(decryptField(f)).toBe("coexists across an active flip");
  });

  it("decrypt-then-encrypt rotation yields a v2-prefixed field that round-trips", () => {
    // A legacy row…
    process.env.ARCHIVE_ENCRYPTION_KEY = K_LEGACY;
    const legacyField: EncryptedField = encryptField("rotate me");
    // …rotated under a keyring with active=v2.
    clearAll();
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    const rotated = encryptField(decryptField(legacyField));
    expect(rotated.ciphertext.startsWith("v2.")).toBe(true);
    expect(decryptField(rotated)).toBe("rotate me");
  });

  it("throws on an unknown keyId", () => {
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    const f = encryptField("x");
    const tampered: EncryptedField = { ...f, ciphertext: "v9." + f.ciphertext.slice(3) };
    expect(() => decryptField(tampered)).toThrow(/no encryption key for keyId "v9"/);
  });

  it("throws when the active key id names no key in the ring", () => {
    setKeyring("v9", { legacy: K_LEGACY, v2: K_V2 });
    expect(() => encryptField("x")).toThrow(
      /ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID must name a key/,
    );
  });

  it("throws on a short keyring key", () => {
    setKeyring("v2", { legacy: K_LEGACY, v2: randomBytes(16).toString("base64") });
    expect(() => encryptField("x")).toThrow(/must be 32 bytes/);
  });

  it("rejects a keyId with a '.' (would mis-split the ciphertext prefix)", () => {
    // The dot is the ciphertext keyId separator + a LIKE-wildcard risk in the rotation scan.
    setKeyring("v.2", { legacy: K_LEGACY, "v.2": K_V2 });
    expect(() => encryptField("x")).toThrow(/alphanumeric\/hyphen only/);
  });

  it("tamper still throws in keyring mode (GCM integrity)", () => {
    setKeyring("v2", { legacy: K_LEGACY, v2: K_V2 });
    const f = encryptField("integrity matters");
    const raw = Buffer.from(f.ciphertext.slice(3), "base64"); // skip the "v2." prefix
    raw[0] ^= 0x01;
    const tampered: EncryptedField = { ...f, ciphertext: "v2." + raw.toString("base64") };
    expect(() => decryptField(tampered)).toThrow();
  });
});
