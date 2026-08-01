import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  TOTP_PERIOD_SECONDS,
  verifyTotp,
  __constantTimeEqual,
} from "./totp.js";

/**
 * M15 15.8 — the TOTP core against THE RFCs' OWN PUBLISHED VECTORS. No infra (CLAUDE.md Testing),
 * so this always runs.
 *
 * Hand-rolled crypto is only defensible when it is checked against the specification's own numbers,
 * and dynamic truncation (RFC 4226 §5.3) is the classic place to be subtly, silently wrong: an
 * off-by-one in the offset produces plausible six-digit codes that no authenticator agrees with.
 */

/** RFC 4226 Appendix D / RFC 6238 Appendix B share this ASCII secret. */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("base32 (RFC 4648 §6)", () => {
  it("matches the RFC 4648 §10 test vectors", () => {
    expect(base32Encode(Buffer.from("", "ascii"))).toBe("");
    expect(base32Encode(Buffer.from("f", "ascii"))).toBe("MY======");
    expect(base32Encode(Buffer.from("fo", "ascii"))).toBe("MZXQ====");
    expect(base32Encode(Buffer.from("foo", "ascii"))).toBe("MZXW6===");
    expect(base32Encode(Buffer.from("foob", "ascii"))).toBe("MZXW6YQ=");
    expect(base32Encode(Buffer.from("fooba", "ascii"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("foobar", "ascii"))).toBe("MZXW6YTBOI======");
  });

  it("encodes the RFC test secret the way authenticator apps expect", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("round-trips at every length that exercises the tail-padding branch", () => {
    // A 20-byte secret is not a multiple of 5, so the tail is the interesting case. These lengths
    // cover every residue mod 5, in both the sub-block and multi-block regimes.
    for (const len of [1, 2, 3, 4, 6, 7, 9, 10, 16, 20, 32]) {
      const buf = randomBytes(len);
      expect(base32Decode(base32Encode(buf)).equals(buf), `length ${len}`).toBe(true);
    }
  });

  it("round-trips 200 random 20-byte secrets", () => {
    for (let i = 0; i < 200; i++) {
      const buf = randomBytes(20);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it("accepts the shapes a human retypes: lower case, whitespace, missing padding", () => {
    const encoded = base32Encode(RFC_SECRET);
    const grouped = encoded
      .replace(/=+$/, "")
      .toLowerCase()
      .replace(/(.{4})/g, "$1 ");
    expect(base32Decode(grouped).equals(RFC_SECRET)).toBe(true);
  });

  it("THROWS on an out-of-alphabet character rather than skipping it", () => {
    // Skipping would produce a silently WRONG secret — "my codes never work", with no bad input to
    // point at. `0`/`1`/`8`/`9` are genuinely not in the RFC 4648 §6 alphabet.
    expect(() => base32Decode("GEZDGNBV0")).toThrow(/invalid base32/);
    expect(() => base32Decode("GEZDGNB!")).toThrow(/invalid base32/);
  });
});

describe("HOTP (RFC 4226 Appendix D)", () => {
  it("reproduces all ten published 6-digit vectors", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (let counter = 0; counter < expected.length; counter++) {
      expect(hotp(RFC_SECRET, counter), `counter ${counter}`).toBe(expected[counter]);
    }
  });

  it("zero-pads a truncation result shorter than `digits`", () => {
    // `bin % 10**6` can be < 100000; a non-padded implementation emits a 5-char code that every
    // app rejects. Search for a counter that produces one rather than asserting a memorised value.
    let found = false;
    for (let counter = 0; counter < 5000 && !found; counter++) {
      const code = hotp(RFC_SECRET, counter);
      if (code.startsWith("0")) found = true;
      expect(code).toHaveLength(6);
    }
    expect(found, "expected at least one leading-zero code in 5000 counters").toBe(true);
  });
});

describe("TOTP (RFC 6238 Appendix B — the SHA-1 rows)", () => {
  it("reproduces all six published 8-digit vectors", () => {
    // NOTE: Appendix B's SHA-256/SHA-512 rows use DIFFERENT (longer) secrets. This implementation
    // is SHA-1 only — those rows do not apply and are deliberately not listed.
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, expected] of vectors) {
      expect(totpCode(RFC_SECRET, t * 1000, 8), `t=${t}`).toBe(expected);
    }
  });
});

describe("verifyTotp", () => {
  const nowMs = 1_700_000_000_000;

  it("accepts the current step and returns THE STEP, not a boolean", () => {
    const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, nowMs), { nowMs })).toBe(step);
  });

  it("accepts ±1 step (±30 s) per RFC 6238 §6", () => {
    for (const offsetMs of [-30_000, 0, 30_000]) {
      const code = totpCode(RFC_SECRET, nowMs + offsetMs);
      expect(verifyTotp(RFC_SECRET, code, { nowMs }), `offset ${offsetMs}`).not.toBeNull();
    }
  });

  it("REJECTS ±2 steps (±60 s) — the window is a bound, and it must actually bind", () => {
    for (const offsetMs of [-60_000, 60_000]) {
      const code = totpCode(RFC_SECRET, nowMs + offsetMs);
      expect(verifyTotp(RFC_SECRET, code, { nowMs }), `offset ${offsetMs}`).toBeNull();
    }
  });

  it("returns the NEIGHBOURING step number when a skewed code matches", () => {
    // The returned step is what `last_step` records, so a code from the previous step must NOT
    // report the current one — otherwise a replay of the current step's code would be accepted.
    const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, nowMs - 30_000), { nowMs })).toBe(step - 1);
  });

  it("rejects on SHAPE before any HMAC is computed", () => {
    for (const junk of ["", "12345", "1234567", "abcdef", "12 45 6", "12345a", "٠١٢٣٤٥"]) {
      expect(verifyTotp(RFC_SECRET, junk, { nowMs }), JSON.stringify(junk)).toBeNull();
    }
  });

  it("falls through to null for a recovery-code-shaped string", () => {
    // This is load-bearing for `POST /v1/auth/mfa/verify`: a null here is what routes the presented
    // credential to the recovery-code hash lookup instead.
    expect(verifyTotp(RFC_SECRET, "9YQ3s1kZ_c4h8vQ2nB7d", { nowMs })).toBeNull();
  });

  it("rejects a code generated under a different secret", () => {
    const other = generateTotpSecret();
    expect(verifyTotp(RFC_SECRET, totpCode(other, nowMs), { nowMs })).toBeNull();
  });

  it("honours a wider explicit skew", () => {
    const code = totpCode(RFC_SECRET, nowMs + 60_000);
    expect(verifyTotp(RFC_SECRET, code, { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { nowMs, skew: 2 })).not.toBeNull();
  });
});

describe("generateTotpSecret", () => {
  it("is 160 bits (RFC 4226 §4 R6) and not repeated", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });
});

describe("otpauthUri (Google Key URI Format)", () => {
  const secret = RFC_SECRET;

  it("percent-encodes BOTH halves of the label", () => {
    const uri = otpauthUri({ issuer: "420AI", account: "a+b@corp.com", secret });
    const label = uri.slice("otpauth://totp/".length, uri.indexOf("?"));
    // A raw `@`, `+` or `:` in the label breaks parsing in several apps — `:` most severely,
    // because it splits the label in the wrong place entirely.
    expect(label).not.toMatch(/[@+]/);
    expect(label.split("%3A")).toHaveLength(1); // the ONE separator is a literal ":"
    expect(label.match(/:/g)).toHaveLength(1);
    expect(decodeURIComponent(label.slice(label.indexOf(":") + 1))).toBe("a+b@corp.com");
  });

  it("carries an UNPADDED base32 secret plus the explicit algorithm parameters", () => {
    const uri = otpauthUri({ issuer: "420AI", account: "user@corp.com", secret });
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(params.get("secret")).not.toContain("=");
    expect(params.get("issuer")).toBe("420AI");
    expect(params.get("algorithm")).toBe("SHA1");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  it("round-trips the secret it advertises", () => {
    const generated = generateTotpSecret();
    const uri = otpauthUri({ issuer: "420AI", account: "user@corp.com", secret: generated });
    const advertised = new URL(uri).searchParams.get("secret")!;
    expect(base32Decode(advertised).equals(generated)).toBe(true);
  });
});

describe("constantTimeEqual", () => {
  it("returns false — never throws — on a length mismatch", () => {
    // `timingSafeEqual` THROWS on unequal lengths, so the guard is mandatory. Without it a
    // five-digit code would 500 instead of 401.
    expect(__constantTimeEqual("123456", "12345")).toBe(false);
    expect(__constantTimeEqual("", "1")).toBe(false);
  });

  it("compares equal-length strings correctly", () => {
    expect(__constantTimeEqual("123456", "123456")).toBe(true);
    expect(__constantTimeEqual("123456", "123457")).toBe(false);
  });
});
