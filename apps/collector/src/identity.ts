import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * Machine identity + collector-local home.
 *
 * `~/.420ai/` is the documented collector home: it holds the M2 pairing
 * credentials (`credentials.json`) plus the M3 durable queue (`queue.sqlite`).
 * Everything here is local state, lives outside the repo, and is never committed.
 *
 * Library file: it throws (`NotPairedError`) and never logs or exits — only
 * `cli.ts main()` catches and prints. The credentials shape is byte-identical to
 * M2 so the existing `~/.420ai/credentials.json` still loads unchanged.
 */

export const COLLECTOR_HOME = join(homedir(), ".420ai");

/** Where `pair` persists the issued ingest credentials for later use. */
export const CREDENTIALS_PATH = join(COLLECTOR_HOME, "credentials.json");

/** The durable queue + cursor store (M3). */
export const QUEUE_PATH = join(COLLECTOR_HOME, "queue.sqlite");

export interface Credentials {
  url: string;
  token: string;
  machineId: string;
}

/** Thrown by `requireCredentials` when this machine has not been paired yet. */
export class NotPairedError extends Error {}

/**
 * Persist credentials. The optional `path` is a testability seam — production
 * code always uses the default `CREDENTIALS_PATH`.
 */
export function saveCredentials(creds: Credentials, path = CREDENTIALS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  // mode 0o600 (owner-only) where the platform honors it.
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Load credentials, returning `undefined` when the file is absent or corrupt
 * (tolerant, as the M2 cli did). The optional `path` is a testability seam.
 */
export function loadCredentials(path = CREDENTIALS_PATH): Credentials | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Credentials;
  } catch {
    return undefined;
  }
}

/** Load credentials or throw `NotPairedError` with a friendly instruction. */
export function requireCredentials(path = CREDENTIALS_PATH): Credentials {
  const creds = loadCredentials(path);
  if (!creds) {
    throw new NotPairedError("not paired — run `collector pair <code> --url <baseUrl>` first");
  }
  return creds;
}
