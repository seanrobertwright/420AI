import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * M15 15.8 — TOTP (RFC 6238) over HOTP (RFC 4226) with RFC 4648 §6 base32, hand-rolled on
 * `node:crypto` with ZERO new dependencies (D-15.8-1). Same precedent as `password.ts` (scrypt) and
 * M10's ed25519 catalog verify — which matters concretely, not decoratively: `apps/ingest` is
 * bundled into the `node:sea` desktop sidecar, so a new package is a build surface, not a line in a
 * manifest.
 *
 * It lands in `apps/ingest`, NOT `packages/shared`, for the same reason `password.ts` does: it is
 * server-only crypto with exactly one consumer, and `apps/dashboard` imports the `@420ai/shared`
 * barrel into CLIENT components — a `node:crypto` import reachable from that barrel is a bundling
 * hazard for no benefit.
 *
 * Every function below is PURE: no clock of its own (`verifyTotp` takes `nowMs`), no database, no
 * I/O. That is what lets the unit test drive the RFCs' published vectors directly, and it is the
 * same split `session.ts` documents as load-bearing.
 */

/** RFC 4648 §6. Note `0`/`1`/`8`/`9` are absent — that is the alphabet, not a typo. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The TOTP step, in seconds. RFC 6238 §4 X = 30, and every authenticator app assumes it. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * RFC 4648 §6 base32-encode, most-significant-bit first, `=`-padded to a multiple of 8 characters.
 *
 * A 5-bit accumulator, deliberately, rather than a per-5-byte-block transform: a 20-byte secret is
 * not a multiple of 5, so the tail is the interesting case and a block form has to special-case it.
 * The accumulator has no tail branch at all — it flushes whatever bits remain, left-aligned.
 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  // The remaining <5 bits are the HIGH bits of the final symbol — left-align them.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

/**
 * RFC 4648 §6 base32-decode. Tolerant of the shapes a human retypes: lower case, `=` padding, and
 * whitespace (authenticator UIs group the secret in fours). Throws on any other character rather
 * than skipping it — a silently-dropped symbol yields a WRONG secret, which fails later as
 * "my codes never work" instead of as a bad input.
 */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Any leftover <8 bits are encoding padding, not data — discard them (RFC 4648 §6).
  return Buffer.from(out);
}

/**
 * RFC 4226 §5.3 dynamic truncation. `counter` is a STEP NUMBER, not a timestamp — the TOTP
 * conversion lives in `verifyTotp`/`totpCode`, so this function stays the plain HOTP the Appendix D
 * vectors test.
 */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The step number a millisecond timestamp falls in. RFC 6238 §4: `T = floor((now - T0) / X)`. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code a correctly-configured authenticator shows at `nowMs`. Used by tests and by nothing else. */
export function totpCode(secret: Buffer, nowMs: number, digits = 6): string {
  return hotp(secret, totpStep(nowMs), digits);
}

/**
 * Verify a 6-digit TOTP code and return THE STEP IT MATCHED, or null.
 *
 * IT RETURNS THE STEP, NEVER A BOOLEAN, and that is a requirement rather than a convenience: RFC
 * 6238 §5.2 forbids accepting a validated code a second time within the same step, and the caller
 * enforces that by writing the matched step to `totp_credentials.last_step`. A boolean throws away
 * the only piece of state that makes the rule implementable.
 *
 * Skew is ±1 step (±30 s) per RFC 6238 §6 — enough for a phone whose clock has drifted or a user
 * who types slowly, and no wider, because each extra step multiplies the live code space.
 *
 * The SHAPE check comes first, before any HMAC: a junk body then costs one regex instead of three
 * SHA-1s. (It also means a recovery code — which is far longer than six digits — falls through here
 * to null, which is exactly how the verify route distinguishes the two credential kinds.)
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: { nowMs: number; skew?: number },
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = totpStep(opts.nowMs);
  const skew = opts.skew ?? 1;
  for (let d = -skew; d <= skew; d++) {
    if (constantTimeEqual(hotp(secret, step + d), code)) return step + d;
  }
  return null;
}

/**
 * A fresh 160-bit shared secret. RFC 4226 §4 R6 recommends 160 bits, and it is also exactly what
 * SHA-1's block structure wants, so it is the size every authenticator app is tested against.
 */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * The `otpauth://` provisioning URI (Google's Key URI Format), for a copy-paste hand-off to an
 * authenticator app. 15.8 renders NO QR code (D-15.8-14) — this string plus the base32 secret is
 * the whole enrolment hand-off, and every mainstream app accepts manual entry.
 *
 * BOTH HALVES OF THE LABEL ARE PERCENT-ENCODED. The label is `issuer:account`, and an account is an
 * email — so it always contains `@`, and may contain `+`. Several apps fail to parse a raw one, and
 * a raw `:` would split the label in the wrong place entirely. `algorithm`/`digits`/`period` are
 * emitted explicitly even though they are the defaults: an app that guesses differently produces
 * codes that never match, and the failure is indistinguishable from a wrong secret.
 */
export function otpauthUri({
  issuer,
  account,
  secret,
}: {
  issuer: string;
  account: string;
  secret: Buffer;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret).replace(/=+$/, ""),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Length-guarded constant-time compare. `timingSafeEqual` THROWS on a length mismatch, so the
 * guard is mandatory, not defensive — the same shape `password.ts:26-27` and `auth.ts:71-73` use.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Exported for the unit test only — the length guard above is the thing worth pinning. */
export const __constantTimeEqual = constantTimeEqual;
