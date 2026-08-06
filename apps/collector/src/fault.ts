import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { COLLECTOR_HOME, collectorHomeFor } from "./identity.js";

/**
 * M16 16.6 — the durable capture FAULT record (`~/.420ai/fault.json`).
 *
 * INC-2026-07: capture ran dead for ~8 days holding 159,828 queued items against an archive that
 * had been reset, and nothing anywhere said so. The collector is the only party with memory that
 * SURVIVES a server-side database reset — `credentials.json` and `queue.sqlite` sat there the whole
 * time — so the fact "this collector's credential was rejected" belongs here, on local disk, beside
 * them. A server-side record cannot detect the event it exists for, because it dies with the reset
 * (D-16.6-1).
 *
 * Library file (CLAUDE.md): it never logs, never exits and never throws on a read — `cli.ts` /
 * `serve.ts` are the only entrypoints that surface it.
 *
 * The record holds NO TOKEN. It records that a credential was REJECTED, never the credential: this
 * file is written by an unattended daemon, is not encrypted, and its whole purpose is to be pasted
 * into a bug report or a weekly scorecard by a human.
 */
export interface CaptureFault {
  /** The only fault kind that exists today: the archive answered 401 to an ingest POST. */
  code: "auth_revoked";
  /** Operator-facing explanation, including the remedy. Never contains a token. */
  message: string;
  /**
   * ISO timestamp of when this fault STARTED — the first observation of an unbroken run of the
   * same `(code, url)` fault, preserved across process restarts by `saveFault`.
   *
   * This is the field the record exists for. Under WinSW's `<onfailure action="restart"/>` a
   * persistent 401 restarts the collector every 5/10/20 s, and each restart observes the fault
   * again: overwriting `since` on every save made an eight-day outage report "since ~20 seconds
   * ago", i.e. it destroyed the one number the operator needs. See `saveFault`.
   */
  since: string;
  /**
   * ISO timestamp of the MOST RECENT observation of the same fault. Written by `saveFault`; the
   * `onFatal` producers do not set it (they only know "now", which is `since` for a fresh fault).
   * `since` → `lastObservedAt` is the outage's duration.
   */
  lastObservedAt?: string;
  /** The archive base URL that rejected the credential — the URL, never the bearer. */
  url: string;
}

/** Where a fatal capture fault is recorded, beside `credentials.json` and `queue.sqlite`. */
export const FAULT_PATH = join(COLLECTOR_HOME, "fault.json");

/**
 * Resolve the fault path for an EXPLICIT home root (the `--home` override), routed through
 * `collectorHomeFor` exactly like `credentialsPathFor` / `queuePathFor` / the connector paths.
 *
 * This is not decoration. The Windows service runs `watch --home C:\Users\<you>` as LocalSystem,
 * whose `homedir()` is `…\config\systemprofile`. A fault file written under the service profile
 * while the desktop reads the user profile is the same split-brain that F-16.3-1 already cost this
 * milestone once: `--home` moves EVERY collector-home artifact together or it moves none of them
 * honestly (see `identity.ts`).
 */
export function faultPathFor(home: string): string {
  return join(collectorHomeFor(home), "fault.json");
}

/**
 * Persist a fault record. Mirrors `saveCredentials` (`identity.ts`): `mkdirSync` the parent so a
 * fresh `--home` works before anything else has created it, and `mode: 0o600` where the platform
 * honors it. The optional `path` is a testability seam.
 *
 * CONTINUITY: an existing record for the SAME `(code, url)` keeps its original `since`, and the new
 * observation lands in `lastObservedAt`. Without this the outage duration is destroyed by the very
 * mechanism that makes the fault visible — WinSW restarts the collector on every non-zero exit, so
 * a persistent 401 re-observes (and previously re-stamped) the fault every few seconds, and an
 * eight-day INC-2026-07 would have reported `since` ≈ 20 seconds ago. A DIFFERENT `code` or `url`
 * is a different fault (e.g. the operator re-pointed the collector at another archive), so it
 * legitimately starts a new clock.
 */
export function saveFault(fault: CaptureFault, path = FAULT_PATH): void {
  const prior = loadFault(path);
  const continuing = prior !== undefined && prior.code === fault.code && prior.url === fault.url;
  const record: CaptureFault = {
    ...fault,
    since: continuing ? prior.since : fault.since,
    lastObservedAt: fault.lastObservedAt ?? fault.since,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Load the fault record, returning `undefined` when the file is absent or corrupt — tolerant, as
 * `loadCredentials` is. A half-written fault file must never become a second outage.
 */
export function loadFault(path = FAULT_PATH): CaptureFault | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  // A cast is not a check: `{}` parses fine and would hand every caller a record whose `message`
  // and `since` are `undefined` — which then reaches `saveFault`'s continuity comparison, the CLI's
  // stderr line and the desktop's error event as the string "undefined". Validate the three fields
  // the readers actually use; anything else is treated exactly like a corrupt file.
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Partial<CaptureFault>;
  if (rec.code !== "auth_revoked") return undefined;
  if (typeof rec.message !== "string" || typeof rec.since !== "string") return undefined;
  if (typeof rec.url !== "string") return undefined;
  return rec as CaptureFault;
}

/**
 * Remove the fault record. Called on the next SUCCESSFUL sync, which is what makes the signal
 * SELF-RESOLVING — without it one bad hour marks the collector faulted forever and the file stops
 * meaning anything (the same reasoning that made `clearConnectorError` necessary in 16.3).
 *
 * A no-op when absent, and never throws: a fault that cannot be cleared must not become a crash.
 */
export function clearFault(path = FAULT_PATH): void {
  try {
    // `force: true` already makes a missing file a no-op — an `existsSync` guard would only add a
    // second syscall and a TOCTOU window.
    rmSync(path, { force: true });
  } catch {
    /* best effort — an unremovable fault file must never take the collector down */
  }
}
