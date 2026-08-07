import { homedir } from "node:os";
import {
  toRawRecordPayload,
  toEventPayload,
  ARCHIVE_UNREACHABLE_MIN_FAILURES,
} from "@420ai/shared";
import { QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore, type SyncOutcome } from "./queue/queue-store.js";
import { connectors as defaultConnectors } from "./connectors/connector.js";
import type { Connector, PollContext } from "./connectors/connector.js";
import { mapConnectorInfo, toMachineConnectorReport } from "./connectors/connector-info.js";
import { FileWatcher } from "./watcher/file-watcher.js";
import { syncOnce, runSyncLoop } from "./sync/sync-worker.js";
import { captureGitCommits } from "./discovery/git-capture.js";
import { postGit, isUnauthorized } from "./ingest-client.js";
import type { CaptureFault } from "./fault.js";
import { runPushServer } from "./push/push-server.js";
import { loadOrCreatePushToken } from "./push/push-token.js";

/** Default git-sweep cadence: a SLOW background sweep (commits change far less often than sessions). */
const DEFAULT_GIT_INTERVAL_MS = 5 * 60_000;

/**
 * Hard cap on the best-effort shutdown drain (C.8 fix). On SIGINT the engine flushes what it can,
 * but must NEVER block exit draining a huge backlog or waiting on a stalled archive — the durable
 * queue keeps undelivered items for the next start, so leaving them is safe. Without this bound a
 * Ctrl-C on a large queue (e.g. ~200k pending) drained the WHOLE backlog before `queue.close()`,
 * hanging exit for minutes and holding the SQLite handle ("locks the database").
 */
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * M16 16.7 — how many FURTHER consecutive sync failures between re-stamps of the degraded fault
 * record's `lastObservedAt`, after the initial threshold crossing has written it.
 *
 * `runSyncLoop`'s `retryMs` defaults to 1000, so this is ≈ once a minute during an outage. The
 * number exists because `saveFault` is a read-modify-write of a file on disk: re-stamping on every
 * failed drain would be a file write per second for as long as the archive is down, which is a
 * fault reporter becoming a second fault. `since` is preserved across every re-stamp by
 * `saveFault`'s `(code, url)` continuity, so a sparse `lastObservedAt` costs at most a minute of
 * precision on a number whose unit is hours or days.
 */
const DEGRADED_RESTAMP_EVERY = 60;

/**
 * Best-effort queue drain bounded by a wall-clock deadline. Drains while the archive keeps
 * accepting ("ok") and items remain, but STOPS at the deadline so shutdown can never hang on a
 * large backlog or a stalled archive (C.8). Undelivered items stay queued (durable, recovered on
 * next start). Pure with an injectable clock so it is unit-testable without infra.
 *
 * M16 16.6 (F2): RETURNS the final `SyncOutcome`. It used to swallow it — the `while` merely stopped
 * on anything that was not "ok" — so a 401 first observed HERE (a token revoked while the operator
 * happened to be restarting the machine) produced no fault record, no stderr line and exit 0. The
 * drain is a real authenticated request; a 401 on it is exactly the evidence the sync loop's is.
 */
export async function drainBeforeExit(
  sync: (timeoutMs: number) => Promise<SyncOutcome>,
  pending: () => number,
  opts: { deadlineMs: number; now?: () => number },
): Promise<SyncOutcome> {
  const now = opts.now ?? ((): number => Date.now());
  const deadline = now() + opts.deadlineMs;
  // Give EACH call only the budget left until the deadline, so even one stalled call can't run past
  // it (its request times out at `remaining`). This HARD-bounds the whole drain to deadlineMs — a
  // between-calls deadline check alone allowed ~2× (a call starting just before the deadline could
  // still run its own full timeout).
  let remaining = opts.deadlineMs;
  let outcome = await sync(remaining);
  while (outcome === "ok" && pending() > 0 && (remaining = deadline - now()) > 0) {
    outcome = await sync(remaining);
  }
  return outcome;
}

/**
 * The capture engine wires the proven primitives into the `collector watch`
 * daemon: identity → durable queue → connectors → poll watcher → sync worker.
 *
 * Library file — no direct stdout. It talks via the optional `logger` callback
 * (wired by cli.ts). On SIGINT (the injected AbortSignal aborts) it stops both
 * loops, does a best-effort final drain, and always closes the DB.
 */
export interface CaptureEngineOptions {
  creds: Credentials;
  signal: AbortSignal;
  queuePath?: string;
  home?: string;
  intervalMs?: number;
  /** What to CAPTURE — the enabled + approved subset. */
  connectors?: Connector[];
  /**
   * M16 16.3: what to REPORT — the FULL registry, including connectors that are disabled or
   * withheld pending approval. The distinction is the whole point of the scorecard: a connector
   * that is deliberately off must appear as `disabled`, not vanish (which is indistinguishable from
   * broken). Defaults to `connectors`, deliberately NOT to `defaultConnectors` — a test that
   * injects two connectors must not suddenly report eight.
   */
  registry?: Connector[];
  logger?: (msg: string) => void;
  /** M9: collector version (read from package.json by cli.ts) — enables heartbeats. */
  collectorVersion?: string;
  /** M9: heartbeat cadence; default 30 s in the sync loop. */
  heartbeatIntervalMs?: number;
  /** M10: git-sweep cadence (default 5 min). Set to 0 to disable the background git sweep. */
  gitIntervalMs?: number;
  /**
   * M13 13.1: called with an ISO timestamp after each successful sync drain (serve.ts wires this to
   * the StatusBar's `lastSyncAt`).
   *
   * M16 16.6 (F1): `delivered` is how many queue items the archive accepted on that drain — **0 for
   * the empty-queue drain that fires every idle tick without making a request**. "We are alive" may
   * use the timestamp alone; "we have re-reached the archive" must require `delivered > 0`.
   *
   * M16 16.6 (F-D): also fired for the SHUTDOWN DRAIN when that drain delivered anything, because on
   * a short run (a `Stop-Service`, a pause inside the idle cadence) the drain is the only delivery
   * the run ever makes — and a caller that never hears about it leaves a stale fault record on disk
   * after a run that provably re-reached the archive.
   */
  onSyncSuccess?: (at: string, delivered: number) => void;
  /**
   * M16 16.6: report a FATAL, non-recoverable capture stop — today only a revoked token (401).
   *
   * An additive CALLBACK rather than a widened return type, deliberately: `cli.ts` types its engine
   * seam as `runEngine?: typeof runCaptureEngine`, so changing `Promise<void>` to a result object
   * would break the injected test double at compile time. A callback has zero blast radius.
   *
   * The engine still unwinds exactly as before — this only makes the reason SURVIVE the unwind.
   * INC-2026-07: the 401 was known here, at this line, for eight days, and went no further.
   */
  onFatal?: (fault: CaptureFault) => void;
  /**
   * M16 16.7: report a DEGRADED capture state — today only "the archive has been unreachable for
   * `ARCHIVE_UNREACHABLE_MIN_FAILURES` consecutive drains". The sibling of `onFatal`, and separate
   * from it deliberately.
   *
   * `cli.ts` turns `onFatal` into `WatchRunResult.fault`, which `watchExitCode` turns into exit 1,
   * which WinSW's `<onfailure action="restart"/>` turns into a restart. Restarting does not make an
   * unreachable archive reachable, so routing this through `onFatal` would produce a restart loop
   * exactly while the durable queue is the only thing preserving the data. So this callback writes
   * the fault file and changes nothing else: capture keeps running, the queue keeps growing, and
   * the process still exits 0 on Ctrl-C. `result.fault` keeps its meaning, "capture STOPPED".
   *
   * Called on the THRESHOLD CROSSING and then sparsely (see the wiring below) — `saveFault` is a
   * read-modify-write of a file and the retry delay is ~1 s, so "write it on every failed drain"
   * would be a file write per second for as long as the outage lasts.
   */
  onDegraded?: (fault: CaptureFault) => void;
  /** M14 14.7: push-receiver port override (default `DEFAULT_PUSH_PORT`). Tests pass 0 for ephemeral. */
  pushPort?: number;
  /**
   * Injectable ingest client (tests only) — mirrors `runSync`'s `post?` seam in `cli.ts` and
   * `SyncDeps.post`. Production always leaves it unset and gets the real fetch-based `postIngest`.
   * Without it the 401 → `onFatal` path could only be exercised against a live HTTP server.
   */
  post?: typeof import("./ingest-client.js").postIngest;
  /**
   * Injectable heartbeat client (tests only) — the sibling of `post`, threaded to `runSyncLoop`.
   *
   * M16 16.6 (F1) made the HEARTBEAT a fatal-401 detector, and without this seam that path could
   * only be exercised against a live HTTP server answering 401 — i.e. it would have shipped with the
   * same "no test can fail here" shape the 16.6 review found four times.
   */
  postHeartbeat?: typeof import("./ingest-client.js").postHeartbeat;
  /**
   * M16 16.3: resolve the DECLARED state of every registry connector for one report.
   *
   * The engine cannot derive this itself. It receives the already-FILTERED capture set, and
   * "absent from that set" is ambiguous — the connector might be disabled OR withheld pending
   * §10.4 approval, which are different health states with different remedies. Guessing would
   * fabricate a fact, which is the Risk 2 failure this whole slice exists to avoid. So the caller,
   * which holds the config and approvals, supplies it.
   *
   * BATCHED (registry → Map) RATHER THAN PER CONNECTOR, so the caller reads `connectors.json` and
   * `approvals.json` ONCE per report instead of once per connector per report — with 8 built-ins
   * and a 30 s heartbeat the per-connector shape was 16 synchronous file reads every 30 s, forever.
   * It is still re-read on every report, deliberately: a connector disabled mid-session must show
   * as `disabled` on the next heartbeat rather than at the next restart.
   *
   * The DEFAULT is honest precisely because `registry` defaults to `connectors`: when nothing was
   * filtered, every registry connector IS in the capture set, so `enabled: true` is a fact rather
   * than an assumption. A caller that passes a WIDER `registry` must pass this too.
   */
  connectorStates?: (registry: Connector[]) => Map<string, ConnectorDeclaredState>;
}

/** The declaration half of one connector's capture health, as the caller resolves it. */
export interface ConnectorDeclaredState {
  enabled: boolean;
  approval: "approved" | "needs-approval";
}

/**
 * An abortable sleep. The abort listener + timer are armed SYNCHRONOUSLY (before
 * any await elsewhere can interleave), so an abort during a sweep clears the timer
 * cleanly — no leaked timer (CLAUDE.md long-lived-resource rule).
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Slow background git-outcome sweep (M10). Best-effort: a git/network error NEVER
 * stops capture (caught + ignored). Runs an immediate sweep then repeats every
 * `intervalMs` until the signal aborts. POSTs commits directly (idempotent by SHA
 * server-side) — it does not enqueue, keeping the durable queue session-only.
 */
async function gitSweepLoop(
  opts: {
    connectors: Connector[];
    home: string;
    url: string;
    token: string;
    intervalMs: number;
    log: (msg: string) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const { commits } = await captureGitCommits({ connectors: opts.connectors, home: opts.home });
      if (commits.length > 0) {
        const res = await postGit(opts.url, opts.token, { commits });
        if (res.commitsInserted > 0) {
          opts.log(`git: captured ${res.commitsInserted} new commit(s)`);
        }
      }
    } catch {
      // Best-effort by contract: never let a git/network error stop session capture.
    }
    await abortableDelay(opts.intervalMs, signal);
  }
}

/**
 * M13 13.7: best-effort poll loop for a POLL-mode connector (Cursor). Mirrors
 * `gitSweepLoop`: an immediate pass then a repeat every `poll.intervalMs` until the
 * signal aborts, with a poll/store error NEVER stopping capture (caught + ignored). Each
 * pass sweeps the connector's store paths; the connector's `run` fetches detail + parses
 * only CHANGED units (via the persistent `queue.pollChanged` gate) and enqueues them onto
 * the SAME durable queue the watcher feeds, so the sync loop drains poll + watch uniformly.
 */
export async function pollLoop(
  opts: {
    connector: Connector;
    home: string;
    queue: QueueStore;
    log: (msg: string) => void;
    /** M16 16.3: report a poll failure so it renders `erroring` instead of vanishing. */
    onError?: (connector: Connector, err: unknown) => void;
    /** M16 16.3 (PR #77): a clean sweep clears the fault, so a resolved error stops reading red. */
    onSuccess?: (connector: Connector) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  const poll = opts.connector.poll;
  if (!poll) return;
  const ctx: PollContext = {
    changed: (key, content) => opts.queue.pollChanged(opts.connector.id, key, content),
    enqueue: (result) => {
      for (const r of result.rawRecords) {
        opts.queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
      }
      for (const e of result.events) {
        opts.queue.enqueue("event", e.fingerprint, toEventPayload(e));
      }
    },
    commit: (key, content) => opts.queue.pollCommit(opts.connector.id, key, content),
  };
  while (!signal.aborted) {
    try {
      for (const path of poll.sources(opts.home)) {
        if (signal.aborted) break;
        const outcome = poll.run(path, ctx);
        if (outcome.changed > 0) {
          opts.log(
            `${opts.connector.id}: ${outcome.changed}/${outcome.swept} session(s) changed → ` +
              `${outcome.rawRecords} record(s), ${outcome.events} event(s)`,
          );
        }
      }
      // A full sweep with no throw clears the connector's fault — see `clearConnectorError`.
      opts.onSuccess?.(opts.connector);
    } catch (err) {
      // Best-effort by contract: never let a poll/store error stop session capture. M16 16.3 —
      // but it is no longer INVISIBLE: a best-effort/swallow path is the worst place to lose a
      // signal, precisely because it is designed not to complain (the M15 15.3 lesson).
      //
      // The REPORTER is guarded too, for the same reason `FileWatcher.report` is: `onError` writes
      // to `queue.sqlite`, and a throw here would reject this loop. That is quieter than the
      // watcher's equivalent — `pollLoops` are absorbed by `Promise.allSettled`, so the engine
      // survives — which makes it WORSE to diagnose: this connector's polling stops forever while
      // the machine still reports `online` and the connector renders `idle` rather than `erroring`.
      try {
        opts.onError?.(opts.connector, err);
      } catch {
        /* an error reporter that throws must not become the outage it was reporting */
      }
    }
    await abortableDelay(poll.intervalMs, signal);
  }
}

export async function runCaptureEngine(opts: CaptureEngineOptions): Promise<void> {
  const log = opts.logger ?? (() => {});
  const queue = new QueueStore(opts.queuePath ?? QUEUE_PATH);
  const home = opts.home ?? homedir();
  const connectors = opts.connectors ?? defaultConnectors;
  // What to REPORT vs what to CAPTURE — see `registry` in the options. Defaults to `connectors`.
  const registry = opts.registry ?? connectors;
  const captureIds = new Set(connectors.map((c) => c.id));
  const connectorStates =
    opts.connectorStates ??
    ((reg: Connector[]) =>
      new Map(
        reg.map((c) => [c.id, { enabled: captureIds.has(c.id), approval: "approved" as const }]),
      ));

  // Boot recovery: re-send anything a crash left mid-flight.
  queue.recoverInflight();

  /**
   * M16 16.3: the DECLARED inventory for the heartbeat. Built fresh on EVERY send (it is a thunk)
   * because `queue.connectorErrors()` changes as capture fails — a snapshot taken at construction
   * would report the state the collector had at boot, forever.
   */
  const connectorReports = () => {
    const errors = queue.connectorErrors();
    // Resolved ONCE for the whole registry — see `connectorStates`. A connector missing from the
    // map is reported as not-capturing rather than silently defaulted to enabled: the map comes
    // from the same registry it is keyed on, so an absence is a caller bug, and guessing "enabled"
    // would put a healthy-looking row on the scorecard (Risk 2).
    const states = connectorStates(registry);
    return registry.map((c) => {
      const state = states.get(c.id) ?? { enabled: false, approval: "approved" as const };
      return toMachineConnectorReport(
        mapConnectorInfo(c, state.enabled, home, state.approval),
        errors.get(c.id),
        // The archive boundary: home-relativize any path in the permissions or the error message.
        home,
      );
    });
  };

  /** Record a connector failure locally so it can ride the next heartbeat and render `erroring`. */
  const recordConnectorError = (connector: Connector, err: unknown): void => {
    queue.recordConnectorError(connector.id, String(err), new Date().toISOString());
    log(`${connector.id}: capture error — ${String(err)}`);
  };

  const onChange = (connector: Connector, text: string): void => {
    const parsed = connector.parse(text);
    // A SUCCESSFUL capture clears the connector's fault (PR #77 review). Placed AFTER `parse`, which
    // is the step that actually throws, so a still-broken connector does not clear itself by
    // reaching this line. See `clearConnectorError` for why a fault that cannot clear is permanent.
    queue.clearConnectorError(connector.id);
    for (const r of parsed.rawRecords) {
      queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
    }
    for (const e of parsed.events) {
      queue.enqueue("event", e.fingerprint, toEventPayload(e));
    }
  };

  // F-16.3-2: a per-file failure is now REPORTED rather than unwinding the whole engine.
  const watcher = new FileWatcher({
    connectors,
    home,
    queue,
    onChange,
    onError: recordConnectorError,
  });

  log(`watching ${connectors.length} connector(s) under ${home}; syncing to ${opts.creds.url}`);
  if (registry.length !== connectors.length) {
    log(`reporting ${registry.length} connector(s) to the archive (including disabled/withheld)`);
  }

  try {
    // Run watcher + sync loops concurrently. A fatal 401 ("stop") or SIGINT ends
    // one; we abort the other so both unwind. Use an internal controller chained
    // to the external signal so a 401 can also stop the watcher.
    const internal = new AbortController();
    const onExternalAbort = () => internal.abort();
    opts.signal.addEventListener("abort", onExternalAbort, { once: true });

    /**
     * M16 16.6: report a FATAL capture stop exactly once, from whichever of the THREE authenticated
     * paths observes it first — the sync loop's ingest POST, the heartbeat (F1), or the shutdown
     * drain (F2). All three carry the same evidence (this machine's credential was rejected), and
     * before F1/F2 only the first of them could produce a fault record, an exit code or a word of
     * output.
     *
     * `reported` is the de-duplication: a persistent 401 is normally seen by two of the three in one
     * run (the sync loop, then the drain re-POSTing the items it released), and a second `onFatal`
     * would double-report to the desktop and re-enter `saveFault` for no new information.
     *
     * The callback is GUARDED for the same reason `heartbeat.ts` guards its `onError`: it writes a
     * file, and a throw here would unwind the engine through a rejected promise instead of the clean
     * "stop" path — the F-16.3-2 shape, in the one component whose whole job is to survive long
     * enough to report a failure.
     */
    let reported = false;
    const reportFatal = (message: string): void => {
      if (reported) return;
      reported = true;
      log(message);
      try {
        opts.onFatal?.({
          code: "auth_revoked",
          message,
          since: new Date().toISOString(),
          // The URL that rejected the credential — never the credential itself.
          url: opts.creds.url,
        });
      } catch {
        /* a fault reporter that throws must not become the outage it was reporting */
      }
    };

    /**
     * M16 16.7 — report a DEGRADED (non-fatal) unreachable archive, on the threshold CROSSING and
     * then sparsely.
     *
     * THE THRESHOLD IS `ARCHIVE_UNREACHABLE_MIN_FAILURES` FROM `@420ai/shared`, not a local
     * constant: it is the SAME number the server-side `archive.unreachable` alert derives from
     * (`deriveArchiveUnreachableAlerts`), so the local record and the server alert cannot disagree
     * about when an archive counts as unreachable. Two spellings of one threshold is two things to
     * drift.
     *
     * THE RE-STAMP IS SPARSE. `saveFault` reads, merges and rewrites a file; `runSyncLoop`'s
     * `retryMs` defaults to 1000, so re-stamping on every failed drain is one file write per second
     * for the entire outage. Writing on the crossing and then every 60th failure (≈ once a minute
     * at the default cadence) keeps `lastObservedAt` fresh enough to be the "duration" half of the
     * record while making the write rate negligible. `saveFault`'s existing `(code, url)` continuity
     * preserves `since` across every re-stamp AND across process restarts, unchanged.
     *
     * IT MUST NOT `internal.abort()` AND MUST NOT SET `reported`. Aborting would stop capture for a
     * condition capture is designed to ride out. Consuming the fatal `reported` guard would be
     * worse and subtler: an archive that is unreachable NOW and 401s once it comes back must still
     * be able to report the 401, which is the fatal one.
     */
    let failuresSinceStamp = 0;
    const reportDegraded = (consecutive: number): void => {
      if (consecutive < ARCHIVE_UNREACHABLE_MIN_FAILURES) return;
      // The crossing itself, then every 60th subsequent failure.
      const crossing = consecutive === ARCHIVE_UNREACHABLE_MIN_FAILURES;
      if (!crossing) {
        failuresSinceStamp += 1;
        if (failuresSinceStamp < DEGRADED_RESTAMP_EVERY) return;
      }
      failuresSinceStamp = 0;
      const message =
        `cannot reach the archive (${consecutive} consecutive sync failures). ` +
        `Capture is STILL RUNNING and the queue is buffering; this clears on the next sync that ` +
        `actually delivers.`;
      if (crossing) log(message);
      try {
        opts.onDegraded?.({
          code: "archive_unreachable",
          message,
          since: new Date().toISOString(),
          // The URL that could not be reached — never the credential.
          url: opts.creds.url,
        });
      } catch {
        /* a fault reporter that throws must not become the outage it was reporting */
      }
    };

    const watcherLoop = watcher.runLoop(internal.signal, opts.intervalMs);
    const syncLoop = runSyncLoop(
      {
        queue,
        url: opts.creds.url,
        token: opts.creds.token,
        // M9: pass the version through so the sync loop sends heartbeats (best-effort).
        collectorVersion: opts.collectorVersion,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
        // M16 16.3 — the DECLARED inventory rides the existing heartbeat (D-16.3-2).
        connectorReports,
        // D-16.3-6: the send failure stays swallowed, but is no longer SILENT. A newer collector
        // against an older archive is the case this exists for.
        //
        // M16 16.6 (F1) — EXCEPT for a 401, which is not a transient send failure at all. The
        // heartbeat makes a real authenticated request every ~30 s REGARDLESS of queue state, so on
        // a quiet machine (empty queue ⇒ the sync loop never POSTs) it is the ONLY thing that ever
        // talks to the archive. Leaving its 401 as a log line meant a collector could sit for days
        // with a revoked credential, write no fault, exit 0 and report nothing — INC-2026-07's exact
        // shape with a smaller queue. Uses the SAME `isUnauthorized` predicate the sync worker
        // branches on; a second predicate is a second thing to drift.
        //
        // Every OTHER heartbeat error keeps the swallow (residual risk e): a network blip or an
        // older archive that 404s the endpoint must never stop capture.
        onHeartbeatError: (e) => {
          if (isUnauthorized(e)) {
            reportFatal(
              "heartbeat returned 401 — token revoked. Re-pair needed: `collector pair <code>`. Stopping capture.",
            );
            internal.abort();
            return;
          }
          log(`heartbeat failed (capture health not reported): ${String(e)}`);
        },
        post: opts.post,
        postHeartbeat: opts.postHeartbeat,
        onSync: opts.onSyncSuccess,
        // M16 16.7: the streak the heartbeat could never deliver during an outage of the archive.
        onSyncFailure: reportDegraded,
        onStop: () => {
          // M16 16.6: leave a DURABLE trace before unwinding. The engine is about to end normally,
          // which is exactly how INC-2026-07 stayed invisible for eight days.
          reportFatal(
            "ingest returned 401 — token revoked. Re-pair needed: `collector pair <code>`. Stopping sync.",
          );
          internal.abort();
        },
      },
      internal.signal,
    );

    // M10: best-effort slow git sweep alongside the watcher/sync loops. NOT part of
    // the race (it is infinite + best-effort) — it unwinds when internal aborts.
    const gitIntervalMs = opts.gitIntervalMs ?? DEFAULT_GIT_INTERVAL_MS;
    const gitLoop =
      gitIntervalMs > 0
        ? gitSweepLoop(
            {
              connectors,
              home,
              url: opts.creds.url,
              token: opts.creds.token,
              intervalMs: gitIntervalMs,
              log,
            },
            internal.signal,
          )
        : Promise.resolve();

    // M13 13.7: a best-effort poll loop per POLL-mode connector (Cursor). Like the git
    // sweep, these are NOT part of the race (infinite + best-effort) — they unwind when
    // `internal` aborts. Absent any poll connector (the default until Cursor is approved),
    // this is an empty array and the behavior is byte-identical to before.
    const pollLoops = connectors
      .filter((c) => c.poll)
      .map((c) =>
        pollLoop(
          {
            connector: c,
            home,
            queue,
            log,
            onError: recordConnectorError,
            onSuccess: (connector) => queue.clearConnectorError(connector.id),
          },
          internal.signal,
        ),
      );

    // M14 14.7: a single best-effort push receiver for the enabled+approved push connectors
    // (Claude-live). Like the git/poll loops it is NOT part of the race (it resolves only on
    // abort/close) and unwinds when `internal` aborts. Starts ONLY when ≥1 push connector is
    // present, so the default (until claude-live is approved) is byte-identical to before.
    const pushConnectors = connectors.filter((c) => c.push);
    let pushServer: Promise<void> = Promise.resolve();
    if (pushConnectors.length > 0) {
      const { token, created } = loadOrCreatePushToken(home);
      if (created) {
        log(`push receiver token generated: ${token} — paste it into the 420AI browser extension`);
      }
      pushServer = runPushServer(
        { connectors: pushConnectors, queue, token, port: opts.pushPort, log },
        internal.signal,
      );
    }

    await Promise.race([watcherLoop, syncLoop]);
    internal.abort(); // ensure the other loops unwind too
    await Promise.allSettled([watcherLoop, syncLoop, gitLoop, ...pollLoops, pushServer]);
    opts.signal.removeEventListener("abort", onExternalAbort);

    // Best-effort final drain of anything captured but not yet sent — bounded by SHUTDOWN_DRAIN_MS
    // so a huge backlog or a stalled archive can never hang exit (C.8). Leftover items stay queued.
    log("draining queue before exit…");
    /**
     * M16 16.6 (F-D): what the SHUTDOWN DRAIN actually delivered.
     *
     * The drain omitted `onDelivered`, so items it successfully acked were invisible to
     * `onSyncSuccess` — the only path that clears the durable fault record. The run that costs:
     * a fault is on disk from a previous run, the operator re-pairs, and the run is SHORT (a
     * `Stop-Service`, or a desktop pause landing inside the ~2 s idle cadence) so the ONLY
     * successful delivery happens here, in the 5 s drain. The stale record then survived a run that
     * had demonstrably re-reached the archive, and reads as a live outage.
     *
     * Accumulated across every drain iteration (`drainBeforeExit` may call `syncOnce` repeatedly),
     * so a multi-batch drain reports the total rather than the last batch.
     */
    let drainDelivered = 0;
    const drainOutcome = await drainBeforeExit(
      // Each drain POST is bounded by the budget REMAINING until the deadline, so even a single
      // stalled archive connection can't outlast it (the between-calls check alone can't interrupt a
      // hung fetch — C.8).
      (timeoutMs) =>
        syncOnce({
          queue,
          url: opts.creds.url,
          token: opts.creds.token,
          timeoutMs,
          post: opts.post,
          onDelivered: (n) => {
            drainDelivered += n;
          },
        }),
      () => queue.stats().pending,
      { deadlineMs: SHUTDOWN_DRAIN_MS },
    );
    // Route the drain's deliveries through the SAME `onSyncSuccess` the sync loop uses, so the
    // callers' `delivered > 0` predicate — the property that stops an empty, no-POST drain from
    // clearing a fault it never disproved — keeps deciding, unchanged. Fired only when something was
    // actually accepted, so a no-op drain still reports nothing (and never stamps a fake "last
    // sync"), and never after a `"stop"`, whose fault record is written two lines below and must not
    // be erased by deliveries that preceded the 401 in the same drain.
    if (drainDelivered > 0 && drainOutcome !== "stop") {
      opts.onSyncSuccess?.(new Date().toISOString(), drainDelivered);
    }
    // M16 16.6 (F2): the drain is the LAST authenticated request the collector makes, and on the
    // realistic path — the operator restarts the machine, the token having been revoked meanwhile —
    // it is the FIRST to see the 401: SIGINT ends the sync loop through the "aborted" branch before
    // it ever POSTs. Discarding this outcome meant that run wrote no fault record and exited 0, so
    // WinSW read it as a deliberate stop. De-duplicated by `reported`, because the ordinary
    // persistent-401 run reaches here having already reported through `onStop`.
    if (drainOutcome === "stop") {
      reportFatal(
        "ingest returned 401 while draining the queue on shutdown — token revoked. Re-pair needed: `collector pair <code>`.",
      );
    }
    const remaining = queue.stats().pending;
    log(remaining === 0 ? "queue drained." : `stopped with ${remaining} item(s) still queued.`);
  } finally {
    queue.close();
  }
}
