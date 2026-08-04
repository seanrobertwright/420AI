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

/**
 * Resolve the collector-home paths for an EXPLICIT home root (the `--home` override). The constants
 * above bake in `homedir()` at import time, which is wrong for a Windows SERVICE: under LocalSystem
 * `homedir()` is `…\config\systemprofile`, not the paired user profile. `--home` repoints connectors,
 * credentials, AND the queue together so all three agree on one profile. `…For(homedir())` is
 * byte-identical to the constants, so default (no-flag) callers are unchanged.
 */
export function collectorHomeFor(home: string): string {
  return join(home, ".420ai");
}
export function credentialsPathFor(home: string): string {
  return join(collectorHomeFor(home), "credentials.json");
}
export function queuePathFor(home: string): string {
  return join(collectorHomeFor(home), "queue.sqlite");
}
/**
 * M16 16.3 (PR #77 review) — connector ENABLEMENT and APPROVALS are `--home`-scoped too, and their
 * absence here was a real hole rather than an omission of convenience.
 *
 * `CONNECTOR_CONFIG_PATH` / `CONNECTOR_APPROVALS_PATH` bake in `homedir()` at import time exactly as
 * the constants above do. Until 16.3 that was harmless, because only `serve` (which runs as the
 * desktop user) read them. 16.3's F-16.3-1 fix made `watch` read them as well — and `watch --home`
 * is precisely the Windows SERVICE invocation, running as LocalSystem. So the service read
 * `…\config\systemprofile\.420ai\connectors.json`, which does not exist, fell through to default-on,
 * and kept capturing a connector the operator had disabled — while REPORTING it as `enabled: true`
 * on the capture health scorecard. A fabricated fact, on the primary capture path, from the very
 * slice built to stop fabricating facts.
 *
 * This is the footgun the `--home` doc above already warns about ("a flag that moved only the
 * connector home but not creds+queue"), one file further out: the flag must move EVERY collector-home
 * artifact or it moves none of them honestly.
 */
export function connectorConfigPathFor(home: string): string {
  return join(collectorHomeFor(home), "connectors.json");
}
export function connectorApprovalsPathFor(home: string): string {
  return join(collectorHomeFor(home), "connector-approvals.json");
}

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
