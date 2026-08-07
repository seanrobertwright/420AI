import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { runCaptureEngine, type CaptureEngineOptions } from "./capture-engine.js";
import {
  loadCredentials,
  QUEUE_PATH,
  connectorConfigPathFor,
  connectorApprovalsPathFor,
  type Credentials,
} from "./identity.js";
import { faultPathFor, saveFault, loadFault, clearFault, type CaptureFault } from "./fault.js";
import { QueueStore, type QueueStats } from "./queue/queue-store.js";
import type { Connector } from "./connectors/connector.js";
import { loadRegistry } from "./connectors/registry.js";
import {
  fetchActiveConnectorCatalog,
  loadCachedConnectorCatalog as loadCachedConnectorCatalogDefault,
  saveCachedConnectorCatalog,
  type SignedConnectorCatalog,
} from "./connectors/connector-catalog-cache.js";
import {
  loadConnectorConfig as loadConnectorConfigDefault,
  saveConnectorConfig as saveConnectorConfigDefault,
  filterConnectors,
  type ConnectorConfig,
} from "./connectors/connector-config.js";
import {
  loadConnectorApprovals as loadConnectorApprovalsDefault,
  saveConnectorApprovals as saveConnectorApprovalsDefault,
  seedMissingApprovals,
  approveConnector,
  filterByApproval,
  type ConnectorApprovals,
} from "./connectors/connector-approvals.js";
import { mapConnectorInfo, resolveConnectorStates } from "./connectors/connector-info.js";
import type { ControlCommand, ControlEvent } from "@420ai/shared";

/**
 * The `serve` entrypoint (M11): the long-running stdio protocol server the Tauri
 * desktop shell supervises as a `node:sea` sidecar. It speaks the M11 control
 * protocol (`@420ai/shared` `control-protocol.ts`) — newline-delimited JSON
 * commands on stdin, newline-delimited JSON events on stdout — and drives the
 * UNCHANGED M3 capture core (`runCaptureEngine`) by its AbortSignal alone:
 *   start/resume → spawn a fresh engine run; pause → abort + retain the queue;
 *   stop → abort + drain + exit.
 *
 * Entrypoint, like `cli.ts`: it owns argv/stdio and is the ONLY place here that
 * may exit. But its **stdout is reserved for protocol JSON lines ONLY** (the
 * load-bearing rule the control-protocol spike proved): the engine's `logger`
 * callback maps to a `{type:"log"}` event, and warnings go to stderr — never raw
 * stdout text, which would corrupt the JSON-lines stream.
 *
 * Testability: `runServe(deps)` takes injectable seams (streams, a fake engine,
 * a queue-stats reader, an exit seam) so the protocol state machine is driven
 * deterministically in `serve.test.ts` without real capture or a real exit.
 */

type EngineRunner = (opts: CaptureEngineOptions) => Promise<void>;
type ServeState = "idle" | "running" | "paused" | "error";
type Intent = "running" | "pausing" | "stopping" | null;

export interface ServeDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  /** Seam for the capture loop; defaults to the real `runCaptureEngine`. */
  runEngine?: EngineRunner;
  /** Seam for queue backlog; defaults to a short-lived read of the durable queue. */
  queueStats?: () => QueueStats;
  /** Seam for credential resolution; defaults to the saved pairing (Slice 1). */
  loadCreds?: () => Credentials | undefined;
  collectorVersion?: string;
  /** Periodic status cadence (ms). 0 disables the timer (tests drive status by command). */
  statusIntervalMs?: number;
  /** Exit seam — tests pass a spy so the runner is not killed. */
  exit?: (code: number) => void;
  pid?: number;
  heartbeatIntervalMs?: number;
  /** Slice 2: the connector registry to expose/filter; defaults to the real `connectors`. */
  connectorRegistry?: Connector[];
  /** Slice 2: read per-connector enablement; defaults to the persisted config module. */
  loadConnectorConfig?: () => ConnectorConfig;
  /** Slice 2: persist per-connector enablement; defaults to the persisted config module. */
  saveConnectorConfig?: (cfg: ConnectorConfig) => void;
  /** Slice 12.7b: read per-connector capture-surface approvals; defaults to the persisted module. */
  loadConnectorApprovals?: () => ConnectorApprovals;
  /** Slice 12.7b: persist per-connector capture-surface approvals; defaults to the persisted module. */
  saveConnectorApprovals?: (cfg: ConnectorApprovals) => void;
  /** Slice 12.7c: read the cached signed connector catalog; defaults to the persisted module. */
  loadCachedConnectorCatalog?: () => SignedConnectorCatalog | undefined;
  /** Slice 2: home dir used to resolve a connector's `watchGlobs` (permission scope). */
  home?: string;
}

/** Default queue-stats reader: a short-lived WAL read, mirroring cli.ts `runQueueStatus`. */
function defaultQueueStats(): QueueStats {
  const queue = new QueueStore(QUEUE_PATH);
  try {
    return queue.stats();
  } finally {
    queue.close();
  }
}

/**
 * Run the control-protocol server. Returns a promise that resolves when the
 * server stops (a `stop` command or stdin EOF). All listeners + the status timer
 * are armed SYNCHRONOUSLY before any await (CLAUDE.md leak-window rule): a parent
 * that dies during boot still finds its handlers attached.
 */
export function runServe(deps: ServeDeps = {}): Promise<void> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const runEngine = deps.runEngine ?? runCaptureEngine;
  const readStats = deps.queueStats ?? defaultQueueStats;
  const loadCreds = deps.loadCreds ?? loadCredentials;
  const collectorVersion = deps.collectorVersion ?? "0.0.0";
  const statusIntervalMs = deps.statusIntervalMs ?? 5000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const pid = deps.pid ?? process.pid;
  const home = deps.home ?? homedir();
  // Default registry = built-ins + valid custom connectors (M10-S2), overlaid with the
  // CACHED signed connector catalog (Slice 12.7c). Read SYNCHRONOUSLY (no await before the
  // listeners/timer arm — the leak-window rule); offline-first (no cache ⇒ bundled
  // baseline). An injected registry (tests) bypasses the loader and carries no drop reasons.
  const loadCachedCatalog = deps.loadCachedConnectorCatalog ?? loadCachedConnectorCatalogDefault;
  const registry = deps.connectorRegistry
    ? { connectors: deps.connectorRegistry, dropped: [] as { id: string; reason: string }[] }
    : loadRegistry(home, { catalog: loadCachedCatalog()?.payload });
  const connectorRegistry = registry.connectors;
  // PR #77 review — resolved from `home`, not from the import-time `homedir()` constants, so
  // `serve` and `watch` read ONE profile's connector settings. See `identity.ts`: `--home` must
  // move every collector-home artifact together or it moves none of them honestly.
  const cfgPath = connectorConfigPathFor(home);
  const approvalsPath = connectorApprovalsPathFor(home);
  const loadConnectorCfg = deps.loadConnectorConfig ?? (() => loadConnectorConfigDefault(cfgPath));
  const saveConnectorCfg =
    deps.saveConnectorConfig ??
    ((cfg: ConnectorConfig) => saveConnectorConfigDefault(cfg, cfgPath));
  const loadApprovals =
    deps.loadConnectorApprovals ?? (() => loadConnectorApprovalsDefault(approvalsPath));
  const saveApprovals =
    deps.saveConnectorApprovals ??
    ((cfg: ConnectorApprovals) => saveConnectorApprovalsDefault(cfg, approvalsPath));

  // Slice 12.7b: seed-on-first-sight (default-on). Record the current capture-surface
  // fingerprint for any connector not yet known, establishing the baseline so a LATER
  // drift is detectable as a §10.4 "capture surface change". Synchronous (no await) —
  // it precedes the Promise executor's listener/timer arming (leak-window rule), and
  // the registry is already resolved above.
  {
    const seeded = seedMissingApprovals(connectorRegistry, loadApprovals(), home);
    if (seeded.changed) saveApprovals(seeded.approvals);
  }

  let state: ServeState = "idle";
  let intent: Intent = null;
  let controller: AbortController | null = null;
  let enginePromise: Promise<void> | null = null;
  let creds: Credentials | undefined = loadCreds();
  // M13 13.1: updated live by the engine's onSyncSuccess callback (wired in startEngine below)
  // each time the sync loop completes a successful drain — the StatusBar no longer renders "—".
  let lastSyncAt: string | null = null;
  /**
   * M16 16.6: the reason the CURRENT engine run died, if it died fatally (a revoked token). Set by
   * the engine's `onFatal` and consumed by the `.then()` branch below, which already knew the engine
   * had ended on its own and could only say "unexpectedly".
   */
  let fault: CaptureFault | undefined;
  let closed = false;
  // Per-instance teardown; assigned once the Promise executor has rl + the timer.
  let cleanupAndExit: (code: number) => void = () => {};

  function emit(ev: ControlEvent): void {
    stdout.write(JSON.stringify(ev) + "\n");
  }
  function log(level: "info" | "warn" | "error", message: string): void {
    emit({ type: "log", level, message });
  }

  function emitStatus(): void {
    let stats: QueueStats = { pending: 0, inflight: 0 };
    try {
      stats = readStats();
    } catch (err) {
      log("warn", `queue stats unavailable: ${(err as Error).message}`);
    }
    emit({ type: "status", state, pending: stats.pending, inflight: stats.inflight, lastSyncAt });
  }

  /** Emit the current registry + persisted enablement + approval state as a `connectors` event. */
  function emitConnectors(): void {
    // Same resolver the engine's heartbeat report uses, so the webview and the archive can never
    // show different enablement for the same connector.
    const states = resolveConnectorStates(
      connectorRegistry,
      loadConnectorCfg(),
      loadApprovals(),
      home,
    );
    const connectors = connectorRegistry.map((c) => {
      const s = states.get(c.id);
      return mapConnectorInfo(c, s?.enabled ?? false, home, s?.approval ?? "approved");
    });
    emit({ type: "connectors", connectors });
  }

  function startEngine(cmd: string): void {
    if (state === "running") {
      emit({ type: "ack", cmd });
      return;
    }
    if (!creds) {
      emit({ type: "error", message: "not configured — pair or configure first", cmd });
      return;
    }
    const ctrl = new AbortController();
    controller = ctrl;
    intent = "running";
    state = "running";
    // A fresh run carries no fault yet — otherwise a fault from the PREVIOUS run would annotate
    // this one's stop reason. This is about the IN-MEMORY stop reason only; the file on disk is
    // cleared by the first drain that actually delivers (see `onSyncSuccess`), which is why that
    // clear must not be gated on this flag.
    fault = undefined;
    /**
     * M16 16.6 (F3): announce a fault recorded EARLIER — by a previous desktop run or by the
     * Windows service under the same profile — so the operator sees it on launch instead of only
     * ever discovering it by reading `fault.json` by hand. `loadFault` previously had no production
     * caller at all, which made the durable record write-only.
     *
     * Reuses the EXISTING `{ type: "error"; message }` ControlEvent (D-16.6-3), so
     * CONTROL_PROTOCOL_VERSION stays `m12-control-v3` and the Tauri UI is untouched.
     *
     * ONE event, not an event plus a `log` line saying the same words: `log()` here IS a protocol
     * event, and the duplicate-report defect the 16.6 review fixed on the fatal-stop path would be
     * reintroduced verbatim by emitting both.
     */
    const priorFault = loadFault(faultPathFor(home));
    if (priorFault) {
      // M16 16.7: NAME WHICH KIND, mirroring `cli.ts`. The two codes mean opposite things about
      // whether capture kept running, and this line is the operator's only report of it.
      const kind =
        priorFault.code === "archive_unreachable"
          ? "a DEGRADED capture fault (capture kept running; the archive was unreachable)"
          : "a FATAL capture fault (capture had stopped)";
      emit({
        type: "error",
        message:
          `${kind} is on record: ${priorFault.message} (since ${priorFault.since}` +
          (priorFault.lastObservedAt ? `, last observed ${priorFault.lastObservedAt}` : "") +
          `). It clears on the next sync that actually delivers.`,
      });
    }
    // Slice 2 + 12.7b: re-read enablement AND approvals at each (re)start and hand the
    // engine the FILTERED registry. The M3/M4 capture core is unchanged — this is the
    // existing `CaptureEngineOptions.connectors` seam (capture-engine.ts). Both filters
    // compose: a connector must be enabled AND its capture surface approved to capture.
    // Re-reading approvals here means an approval granted mid-session takes effect on the
    // next start (mirroring how enablement is re-read). Default-on preserved by both.
    const enabledConnectors = filterByApproval(
      filterConnectors(connectorRegistry, loadConnectorCfg()),
      loadApprovals(),
      home,
    );
    enginePromise = runEngine({
      creds,
      signal: ctrl.signal,
      logger: (msg) => log("info", msg),
      collectorVersion,
      heartbeatIntervalMs: deps.heartbeatIntervalMs,
      connectors: enabledConnectors,
      // M16 16.3: REPORT the full registry, CAPTURE the filtered subset — the same split `cli.ts`
      // makes, so the desktop and service paths produce the same scorecard.
      registry: connectorRegistry,
      // Config + approvals read ONCE per report; the mapping is shared with `cli.ts` so the desktop
      // and the Windows service cannot disagree about what "enabled" means.
      connectorStates: (reg) =>
        resolveConnectorStates(reg, loadConnectorCfg(), loadApprovals(), home),
      onSyncSuccess: (at, delivered) => {
        lastSyncAt = at;
        // M16 16.6: a drain that actually DELIVERED resolves the fault — unconditionally as to who
        // recorded it. Gating on the in-memory `fault` left a stale file forever: `startEngine`
        // resets `fault = undefined` on every start, so a run that faulted and wrote the file was
        // followed by a successful run in which the flag was false and the file survived, reading
        // as a permanent outage. There is no cross-profile hazard to justify the narrower scope
        // either: `serve`'s home defaults to `homedir()`, the same profile the documented service
        // install targets with `watch --home C:\Users\YOURNAME` — same machine, same credentials.
        //
        // `delivered > 0` is load-bearing: an empty-queue drain returns "ok" every ~2 s without
        // making a request, so an idle desktop would otherwise erase the record having contacted
        // nothing.
        if (delivered > 0) {
          fault = undefined;
          clearFault(faultPathFor(home));
        }
      },
      // M16 16.6: capture the fatal reason and make it DURABLE, so the fact survives the desktop
      // being closed and a server-side DB reset alike.
      onFatal: (f) => {
        fault = f;
        try {
          saveFault(f, faultPathFor(home));
        } catch (err) {
          log("warn", `could not record capture fault: ${(err as Error).message}`);
        }
      },
      // M16 16.7: the DEGRADED record. Deliberately does NOT assign `fault` — that variable is the
      // engine's STOP reason, consumed by the `.then()` branch below to explain why capture ended.
      // An unreachable archive does not end capture, so annotating a later stop with it would
      // misreport the cause. It writes the file and surfaces one event; capture keeps running.
      onDegraded: (f) => {
        try {
          saveFault(f, faultPathFor(home));
        } catch (err) {
          log("warn", `could not record capture fault: ${(err as Error).message}`);
        }
        emit({ type: "error", message: f.message });
      },
    })
      .then(() => {
        controller = null;
        enginePromise = null;
        if (intent === "pausing") {
          state = "paused";
        } else if (intent === "stopping") {
          // stop() owns the terminal state + events.
        } else {
          // Engine ended on its own — surface it. M16 16.6: with the REASON when we have one.
          // Reuses the EXISTING `error` ControlEvent (D-16.6-3) rather than adding a field to
          // `status`, which would bump CONTROL_PROTOCOL_VERSION and drag the Tauri UI into this
          // slice for no detection benefit.
          state = "error";
          // ONE event per stop: when the reason is known the `error` event carries it, and a `log`
          // line saying the same words would only duplicate it in the desktop's feed. The `log`
          // stays for the branch that has no reason to report.
          if (fault) {
            emit({ type: "error", message: `capture stopped: ${fault.message}` });
          } else {
            log("error", "capture engine stopped unexpectedly");
          }
          emitStatus();
        }
      })
      .catch((err) => {
        controller = null;
        enginePromise = null;
        state = "error";
        log("error", `capture engine error: ${(err as Error).message}`);
        emitStatus();
      });
    emit({ type: "ack", cmd });
    emitStatus();
  }

  // NOTE: pause aborts the (unchanged) capture engine, whose abort path runs a
  // best-effort final DRAIN (capture-engine.ts) — so against a reachable archive,
  // pause flushes the backlog (pending → ~0) rather than freezing it. No data is
  // lost (the queue is durable; items are synced, not dropped); this is the natural
  // consequence of reusing the real engine. A non-draining "freeze" is a later slice.
  async function pause(cmd: string): Promise<void> {
    if (state !== "running" || !controller) {
      emit({ type: "ack", cmd });
      emitStatus();
      return;
    }
    intent = "pausing";
    controller.abort();
    if (enginePromise) await enginePromise; // settles → state "paused"
    emit({ type: "ack", cmd });
    emitStatus();
  }

  async function stop(cmd: string): Promise<void> {
    intent = "stopping";
    if (controller) controller.abort();
    if (enginePromise) await enginePromise; // engine does its own final drain
    state = "idle";
    emit({ type: "ack", cmd });
    emit({ type: "stopped" });
    cleanupAndExit(0);
  }

  async function handle(c: ControlCommand): Promise<void> {
    switch (c.cmd) {
      case "configure":
        // Slice 3 wires the keychain; the in-memory inject is forward-compatible now.
        creds = {
          url: c.url,
          token: c.token,
          machineId: c.machineId ?? creds?.machineId ?? "unknown",
        };
        emit({ type: "ack", cmd: "configure" });
        return;
      case "start":
      case "resume":
        startEngine(c.cmd);
        return;
      case "pause":
        await pause(c.cmd);
        return;
      case "status":
        emitStatus();
        return;
      case "connectors.list":
        emitConnectors();
        return;
      case "connectors.set": {
        // Defense-in-depth at the stdin boundary: the Rust relay forwards opaque JSON,
        // so validate `id`/`enabled` rather than trust the (typed) producer — without
        // this, a malformed line writes a `"undefined"` config key and falsely acks.
        if (typeof c.id !== "string" || typeof c.enabled !== "boolean") {
          emit({
            type: "error",
            message: "connectors.set requires id:string + enabled:boolean",
            cmd: c.cmd,
          });
          return;
        }
        // Persist enable/disable; re-emit so the UI reflects the saved state. Takes
        // effect on the NEXT engine start/resume (startEngine re-reads) — no hot
        // restart on toggle (state-machine simplicity; deferred refinement). `config`
        // is reserved/forward-compat and ignored today.
        const cfg = loadConnectorCfg();
        cfg.connectors[c.id] = { enabled: c.enabled };
        saveConnectorCfg(cfg);
        emit({ type: "ack", cmd: c.cmd });
        emitConnectors();
        return;
      }
      case "connectors.approve": {
        // Defense-in-depth at the stdin boundary (the Rust relay forwards opaque JSON).
        if (typeof c.id !== "string") {
          emit({ type: "error", message: "connectors.approve requires id:string", cmd: c.cmd });
          return;
        }
        // Record the connector's CURRENT capture surface as the approved baseline (§10.4).
        // Unknown id ⇒ clean error (capture unaffected) — mirrors connectors.set's guard.
        const found = connectorRegistry.find((conn) => conn.id === c.id);
        if (!found) {
          emit({ type: "error", message: "unknown connector id", cmd: c.cmd });
          return;
        }
        saveApprovals(approveConnector(found, loadApprovals(), home));
        emit({ type: "ack", cmd: c.cmd });
        emitConnectors();
        return;
      }
      case "stop":
        await stop(c.cmd);
        return;
      case "pair":
      case "discover":
        emit({
          type: "error",
          message: `${c.cmd} not supported in this build (Slice 3+)`,
          cmd: c.cmd,
        });
        return;
      default: {
        const unknown = c as { cmd?: unknown };
        emit({ type: "error", message: `unknown command: ${String(unknown.cmd)}` });
        return;
      }
    }
  }

  // Serialize commands so an awaiting pause/stop cannot interleave with the next
  // command (e.g. a quick pause→resume must apply in order).
  let chain: Promise<void> = Promise.resolve();
  function dispatch(c: ControlCommand): void {
    chain = chain
      .then(() => handle(c))
      .catch((err) => {
        const cmd = (c as { cmd?: string }).cmd;
        emit({ type: "error", message: `command failed: ${(err as Error).message}`, cmd });
      });
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: ControlCommand;
    try {
      parsed = JSON.parse(trimmed) as ControlCommand;
    } catch {
      emit({ type: "error", message: `malformed command line: ${trimmed.slice(0, 80)}` });
      return;
    }
    dispatch(parsed);
  }

  return new Promise<void>((resolveDone) => {
    // Arm listeners + timer BEFORE any await (none precede this — creds/stats are sync).
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on("line", handleLine);
    rl.on("close", () => {
      // stdin EOF (the parent closed the pipe) → graceful stop, unless already stopping.
      if (intent !== "stopping" && !closed) dispatch({ cmd: "stop" });
    });
    stdin.on("error", (err: Error) => {
      stderr.write(`serve stdin error: ${err.message}\n`);
    });

    const statusTimer = statusIntervalMs > 0 ? setInterval(emitStatus, statusIntervalMs) : null;

    cleanupAndExit = (code: number): void => {
      if (closed) return;
      closed = true;
      if (statusTimer) clearInterval(statusTimer);
      rl.close();
      resolveDone();
      exit(code);
    };

    emit({ type: "ready", pid, collectorVersion, paired: Boolean(creds) });
    emitStatus();
    // Surface any custom-connector declarations the loader dropped (invalid/colliding).
    // The entrypoint may log; the registry library itself stays silent (D5).
    for (const d of registry.dropped) {
      log("warn", `custom connector "${d.id}" dropped: ${d.reason}`);
    }

    // M12 12.7c: best-effort REFRESH of the cached connector catalog for the NEXT start.
    // Fired AFTER `cleanupAndExit` is armed (a one-shot promise, never a timer/stream — no
    // leak window), production-only (tests inject `connectorRegistry` and skip this). The
    // live registry already overlaid the CACHED catalog synchronously above; a freshly
    // pulled one applies on the next start (avoids an await-before-arm leak / a live
    // registry rebuild). The `closed` guard prevents a late write/log during shutdown.
    if (!deps.connectorRegistry && creds) {
      const c = creds;
      void fetchActiveConnectorCatalog({ baseUrl: c.url, token: c.token })
        .then((fetched) => {
          if (fetched && !closed) {
            saveCachedConnectorCatalog(fetched);
            log("info", `connector catalog ${fetched.version} cached (applies next start)`);
          }
        })
        .catch(() => {});
    }
  });
}

/** True when this module is the process entrypoint under a native `node`/`tsx` run. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Auto-run when executed as a program, NOT when imported by a test. Process.env-free.
 * Three signals, robust across the SEA `.exe`, a bundled `node bundle.cjs`, and a
 * dev `tsx serve.ts`:
 *   1. an explicit `serve` argv token — the Tauri sidecar spawns the binary with it,
 *      so neither `isSea()` nor `import.meta.url` (which esbuild zeroes to `{}` in the
 *      CJS bundle — the spike's `isMain()` gotcha) is load-bearing;
 *   2. `isSea()` — true inside the SEA `.exe` even with no args;
 *   3. the entrypoint check — for a direct `node`/`tsx` run of the source.
 * Under vitest none fire (argv has no bare `serve` token), so the test drives
 * `runServe` itself.
 */
function shouldAutoRun(): boolean {
  if (process.argv.slice(1).includes("serve")) return true;
  try {
    if (isSea()) return true;
  } catch {
    /* node:sea unavailable — fall through to the entrypoint check */
  }
  return isMainModule();
}

if (shouldAutoRun()) {
  runServe().catch((err) => {
    process.stderr.write(`serve fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
