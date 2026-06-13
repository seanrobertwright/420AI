import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Field-level encryption (PRD §18.1). AES-256-GCM (authenticated): the auth tag
 * makes decryption fail loudly on any tampering of ciphertext or tag.
 *
 * The 32-byte key comes from ARCHIVE_ENCRYPTION_KEY (env, base64) and is NEVER
 * stored in the DB. A fresh 96-bit IV is generated per call and stored alongside
 * the ciphertext — IVs are not secret, but must never repeat under one key.
 */
const ALGO = "aes-256-gcm";

export interface EncryptedField {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
}

function key(): Buffer {
  const b64 = process.env.ARCHIVE_ENCRYPTION_KEY;
  if (!b64) throw new Error("ARCHIVE_ENCRYPTION_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) {
    throw new Error("ARCHIVE_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  }
  return k;
}

export function encryptField(plaintext: string): EncryptedField {
  const iv = randomBytes(12); // 96-bit IV, fresh per call — NEVER reuse
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}

export function decryptField(f: EncryptedField): string {
  const d = createDecipheriv(ALGO, key(), Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64")); // final() throws if tampered
  return Buffer.concat([
    d.update(Buffer.from(f.ciphertext, "base64")),
    d.final(),
  ]).toString("utf8");
}
