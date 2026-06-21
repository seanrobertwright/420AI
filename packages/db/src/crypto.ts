import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Field-level encryption (PRD §18.1). AES-256-GCM (authenticated): the auth tag
 * makes decryption fail loudly on any tampering of ciphertext or tag.
 *
 * M12 12.4e — KEY VERSIONING (keyring). The keyId rides INSIDE the ciphertext string
 * (`"<keyId>.<base64>"`), so `EncryptedField` keeps its `{ciphertext, iv, tag}` shape —
 * the 3 write sites + 3 read sites and the schema are UNCHANGED. Two modes:
 *
 *  - Legacy single-key (only ARCHIVE_ENCRYPTION_KEY set): output is BARE base64 (no
 *    prefix) → byte-for-byte identical to pre-12.4e, so existing rows + tests are unaffected.
 *  - Keyring (ARCHIVE_ENCRYPTION_KEYS + ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID): new ciphertext is
 *    prefixed with the active keyId ("v2.AbCd…"); old + new keys coexist so a rotation can
 *    re-encrypt every row under the active key while un-rotated rows still decrypt.
 *
 * The 32-byte key(s) come from env (base64) and are NEVER stored in the DB. A fresh 96-bit
 * IV is generated per call and stored alongside the ciphertext — IVs are not secret but must
 * never repeat under one key.
 */
const ALGO = "aes-256-gcm";

/** keyId used for legacy single-key deployments and for un-prefixed (pre-rotation) ciphertext. */
const LEGACY_ID = "legacy";

/**
 * keyIds must be alphanumeric + hyphen. This is load-bearing, not cosmetic: the keyId is the
 * prefix before the FIRST "." in the ciphertext (so a "." in an id would mis-split on decrypt),
 * and the rotation scan filters un-rotated rows with `NOT LIKE '<id>.%'` (so "%"/"_" in an id
 * would silently match the wrong rows). Rejecting these at boot turns a silent data-corruption
 * path into a clear error.
 */
const KEY_ID_RE = /^[A-Za-z0-9-]+$/;

export interface EncryptedField {
  ciphertext: string; // base64 — keyring mode prefixes "<keyId>.": "v2.AbCd…". Legacy = bare base64.
  iv: string; // base64
  tag: string; // base64
}

interface Keyring {
  keys: Map<string, Buffer>;
  activeId: string;
}

/** Build the keyring from env each call (cheap; preserves the existing test that mutates env). */
function keyring(): Keyring {
  const raw = process.env.ARCHIVE_ENCRYPTION_KEYS;
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, string>; // { keyId: base64key }
    const keys = new Map<string, Buffer>();
    for (const [id, b64] of Object.entries(obj)) {
      if (!KEY_ID_RE.test(id)) {
        throw new Error(`ARCHIVE_ENCRYPTION_KEYS keyId "${id}" must be alphanumeric/hyphen only`);
      }
      const k = Buffer.from(b64, "base64");
      if (k.length !== 32) {
        throw new Error(`ARCHIVE_ENCRYPTION_KEYS["${id}"] must be 32 bytes (base64-encoded)`);
      }
      keys.set(id, k);
    }
    const activeId = process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID;
    if (!activeId || !keys.has(activeId)) {
      throw new Error(
        "ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID must name a key in ARCHIVE_ENCRYPTION_KEYS",
      );
    }
    return { keys, activeId };
  }
  // Back-compat: a single legacy key. Output stays UN-prefixed → byte-identical to pre-12.4e.
  const b64 = process.env.ARCHIVE_ENCRYPTION_KEY;
  if (!b64) throw new Error("ARCHIVE_ENCRYPTION_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) {
    throw new Error("ARCHIVE_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  }
  return { keys: new Map([[LEGACY_ID, k]]), activeId: LEGACY_ID };
}

function resolveKey(ring: Keyring, id: string): Buffer {
  const k = ring.keys.get(id);
  if (!k) throw new Error(`no encryption key for keyId "${id}"`);
  return k;
}

/** The active keyId — used by the rotation CLI to skip already-rotated rows. */
export function activeKeyId(): string {
  return keyring().activeId;
}

export function encryptField(plaintext: string): EncryptedField {
  const ring = keyring();
  const iv = randomBytes(12); // 96-bit IV, fresh per call — NEVER reuse
  const c = createCipheriv(ALGO, resolveKey(ring, ring.activeId), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  // Only keyring mode prefixes; legacy single-key stays bare base64 (zero format change).
  const prefix = ring.activeId === LEGACY_ID ? "" : ring.activeId + ".";
  return {
    ciphertext: prefix + ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}

export function decryptField(f: EncryptedField): string {
  const ring = keyring();
  let id = LEGACY_ID;
  let ctB64 = f.ciphertext;
  const dot = f.ciphertext.indexOf("."); // base64 has no "." → unambiguous prefix split
  if (dot >= 0) {
    id = f.ciphertext.slice(0, dot);
    ctB64 = f.ciphertext.slice(dot + 1);
  }
  const d = createDecipheriv(ALGO, resolveKey(ring, id), Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64")); // final() throws if tampered
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}
