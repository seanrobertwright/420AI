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
/**
 * M16 16.7 — the fault kinds, and they are NOT equally severe.
 *
 * `auth_revoked` is FATAL: the archive answered 401 to an authenticated request, capture stops, and
 * the entrypoint exits 1 so WinSW's `<onfailure action="restart"/>` fires.
 *
 * `archive_unreachable` is DEGRADED: the archive is down or unreachable (5xx / ECONNREFUSED /
 * timeout) for `ARCHIVE_UNREACHABLE_MIN_FAILURES` consecutive drains. Capture KEEPS RUNNING, the
 * durable queue keeps growing (which is correct — that is the queue doing its job), and the process
 * still exits 0 on Ctrl-C.
 *
 * The distinction is load-bearing rather than descriptive: restarting a collector does not make an
 * unreachable archive reachable, so routing this through the fatal path would produce a WinSW
 * restart loop — the collector thrashing precisely while its queue is the only thing preserving the
 * data. So `archive_unreachable` never reaches `WatchRunResult.fault` and never changes the exit
 * code; it only writes this file.
 *
 * Why it needs a durable record at all: `consecutiveSyncFailures` is reported ONLY through the
 * heartbeat — the one channel that by definition cannot arrive when the archive is what is down. A
 * 500/ECONNREFUSED loop therefore grew the queue without bound, wrote nothing, exited 0 and left
 * WinSW seeing a healthy service. That is INC-2026-07's observable symptom reached by a different
 * cause, and the server-side `archive.unreachable` alert cannot cover it because it derives from
 * heartbeat rows that have stopped arriving.
 */
/**
 * Every valid `CaptureFault.code`, and THE ARRAY IS THE SOURCE OF TRUTH — the union is derived from
 * it, not the other way round.
 *
 * The direction is the whole point and it was backwards on the first cut of 16.7:
 * `const FAULT_CODES: readonly CaptureFaultCode[] = [...]` merely ANNOTATES the array against a
 * hand-written union, and an array missing an element satisfies that annotation perfectly. So
 * adding a third code to the union and forgetting the array typechecked cleanly — and reproduced
 * the exact bug 16.7 existed to fix, one code over: `saveFault` writes the record, `loadFault`
 * rejects it as corrupt, the startup announcement says nothing, and `saveFault`'s `(code, url)`
 * continuity restarts the `since` clock on every observation. The feature silently does nothing
 * while every test that writes and never reads stays green.
 *
 * Written this way round, a code that exists in the union NECESSARILY exists in the validator,
 * because there is only one list.
 */
const FAULT_CODES = ["auth_revoked", "archive_unreachable"] as const;

export type CaptureFaultCode = (typeof FAULT_CODES)[number];

/**
 * M16 16.7 — the FATAL fault, spelled as its own type.
 *
 * Until this slice `CaptureFault.code` was the single literal `"auth_revoked"`, so `CaptureFault`
 * WAS the fatal type and "a degraded fault never sets `WatchRunResult.fault`" was enforced by the
 * compiler for free. Widening the union quietly demoted that invariant to prose in three separate
 * comments — and prose is not a mechanism (CLAUDE.md 15.5). These two aliases put it back in the
 * type system: `onFatal` and `result.fault` take `FatalCaptureFault`, `onDegraded` takes
 * `DegradedCaptureFault`, so routing a degraded fault into the fatal channel is a compile error
 * rather than a WinSW restart loop discovered in production (D-16.7-8).
 *
 * `saveFault` / `loadFault` deliberately keep the WIDE type — the file on disk holds either.
 */
export type FatalCaptureFault = CaptureFault<"auth_revoked">;

/** M16 16.7 — the DEGRADED fault. See `FatalCaptureFault` for why the two are distinct types. */
export type DegradedCaptureFault = CaptureFault<"archive_unreachable">;

export interface CaptureFault<C extends CaptureFaultCode = CaptureFaultCode> {
  /** Which fault this is, and how severe — see `CaptureFaultCode`. */
  code: C;
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

/**
 * M16 16.7 — which codes STOP capture and which do not, as an EXHAUSTIVE map.
 *
 * A `Record<CaptureFaultCode, …>` is the point: adding a code to `FAULT_CODES` makes `tsc` demand
 * an entry here. The two entrypoints previously each carried
 * `code === "archive_unreachable" ? DEGRADED : FATAL`, whose `else` arm is an open default — so a
 * third code would have been announced as "capture had stopped" whether or not it had, which is
 * the precise failure `describeFault` below exists to prevent.
 */
const FAULT_SEVERITY: Record<CaptureFaultCode, "fatal" | "degraded"> = {
  auth_revoked: "fatal",
  archive_unreachable: "degraded",
};

/**
 * The operator-facing sentence for a fault on record, shared by `cli.ts` and `serve.ts`.
 *
 * COMPOSITION, NOT I/O — this returns a string and writes nothing, so it does not cross CLAUDE.md's
 * entrypoint-logging boundary. Each entrypoint still owns HOW it emits (`opts.logger?.()` versus an
 * `emit({type:"error"})` event); what it must not own is a second copy of WHAT IT SAYS. The two
 * copies were byte-identical, `serve.ts`'s comment said "mirroring cli.ts", and nothing failed if
 * only one was edited.
 *
 * Naming the severity correctly is the entire job of this sentence: `archive_unreachable` means
 * capture KEPT RUNNING and the queue buffered, and telling an operator that capture stopped when it
 * did not is worse than saying nothing at all.
 *
 * `at` is the record's path, included by `cli.ts` (an operator at a terminal can open it) and
 * omitted by `serve.ts` (the desktop surfaces the message in a UI where a path is noise).
 */
export function describeFault(fault: CaptureFault, at?: string): string {
  const kind =
    FAULT_SEVERITY[fault.code] === "degraded"
      ? "a DEGRADED capture fault (capture kept running; the archive was unreachable)"
      : "a FATAL capture fault (capture had stopped)";
  const where = at ? ` at ${at}` : "";
  const lastObserved = fault.lastObservedAt ? `, last observed ${fault.lastObservedAt}` : "";
  return (
    `${kind} is on record${where}: ${fault.message} (since ${fault.since}${lastObserved}). ` +
    `It clears on the next sync that actually delivers.`
  );
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
  // stderr line and the desktop's error event as the string "undefined". Validate EVERY field a
  // reader touches; anything else is treated exactly like a corrupt file.
  //
  // That includes `lastObservedAt`, which is optional but NOT unread: `cli.ts` and `serve.ts` both
  // interpolate it into the operator-facing "a capture fault is on record …, last observed X"
  // message, and `saveFault` carries it forward. Validating four fields and casting the fifth is
  // the same defect one field over — the declared type would say `string | undefined` while the
  // runtime value was a number. Optional here means "absent or a string", never "anything".
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Partial<CaptureFault>;
  // M16 16.7 — a SET MEMBERSHIP check, not an equality against one literal. This line read
  // `rec.code !== "auth_revoked"` when `auth_revoked` was the only code, and leaving it that way
  // while adding a second would have made every `archive_unreachable` record read back as a CORRUPT
  // FILE: `saveFault` would write it, `loadFault` would return undefined, the startup announcement
  // would say nothing, `saveFault`'s continuity would restart the `since` clock on every
  // observation — i.e. the whole feature would silently do nothing while every test that writes and
  // never reads stayed green. Derived from `FAULT_CODES` so a third code cannot repeat the trap.
  if (typeof rec.code !== "string" || !FAULT_CODES.includes(rec.code)) return undefined;
  if (typeof rec.message !== "string" || typeof rec.since !== "string") return undefined;
  if (typeof rec.url !== "string") return undefined;
  if (rec.lastObservedAt !== undefined && typeof rec.lastObservedAt !== "string") return undefined;
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
