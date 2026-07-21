import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { collectorHomeFor } from "../identity.js";

/**
 * The shared bearer secret for the `push` capture receiver (M14 slice 14.7).
 *
 * The browser extension must present this token to POST conversation JSON to the
 * collector's localhost receiver (`push-server.ts`). It lives beside the pairing
 * credentials + durable queue under the collector home, owner-only (`0o600`), and
 * is generated ONCE on first `watch` start (the engine logs it then so the user can
 * paste it into the extension options).
 *
 * Library file: tolerant reads (absent/corrupt ⇒ regenerate), a `home`-injectable
 * path, no logging, no exit — mirrors `identity.ts` `saveCredentials`/`loadCredentials`.
 */

/** Where the push token is persisted (under the same home as creds + queue). */
export function pushTokenPathFor(home: string): string {
  return join(collectorHomeFor(home), "push-token.json");
}

interface PushTokenFile {
  token: string;
}

/**
 * Load the push token, generating + persisting one on first use. Returns the token
 * and whether it was just created (so the caller can log it exactly once). An absent
 * OR corrupt file is (re)generated — never throws.
 */
export function loadOrCreatePushToken(home: string): { token: string; created: boolean } {
  const path = pushTokenPathFor(home);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PushTokenFile>;
      if (typeof parsed.token === "string" && parsed.token.length > 0) {
        return { token: parsed.token, created: false };
      }
      // Present but corrupt/empty → fall through and regenerate.
    } catch {
      // Corrupt JSON → regenerate.
    }
  }
  const token = randomBytes(24).toString("hex");
  // ~/.420ai/ may not exist on a fresh install — mkdir the parent (identity does too).
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  return { token, created: true };
}
