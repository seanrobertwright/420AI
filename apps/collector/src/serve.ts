import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { runCaptureEngine, type CaptureEngineOptions } from "./capture-engine.js";
import { loadCredentials, QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore, type QueueStats } from "./queue/queue-store.js";
import { connectors as defaultConnectors, type Connector } from "./connectors/connector.js";
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
  approvalStatus,
  approveConnector,
  filterByApproval,
  type ConnectorApprovals,
} from "./connectors/connector-approvals.js";
import type { ControlCommand, ControlEvent, ConnectorInfo } from "@420ai/shared";

/** Built-in connector ids, computed once — `mapConnectorInfo` flags anything else as `custom`. */
const BUILTIN_IDS = new Set(defaultConnectors.map((c) => c.id));

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

/**
 * Map a `Connector` (+ its resolved enablement + home) to the serializable
 * `ConnectorInfo` wire shape. The SINGLE conversion point (`@420ai/shared` can't
 * import `Connector`, so the fidelity fields are mirrored on the wire) — a serve
 * test asserts this mapping stays 1:1 with `ConnectorFidelity`.
 */
function mapConnectorInfo(
  c: Connector,
  enabled: boolean,
  home: string,
  approval: "approved" | "needs-approval",
): ConnectorInfo {
  return {
    id: c.id,
    enabled,
    status: c.fidelity.status,
    captureMethod: c.fidelity.captureMethod,
    liveness: c.fidelity.liveness,
    tokens: c.fidelity.tokens,
    cost: c.fidelity.cost,
    knownGaps: c.fidelity.knownGaps,
    watchGlobs: c.watchGlobs(home),
    // Slice 12.7b: the declared §10.3 scope + the §10.4 approval state.
    requiredPermissions: c.fidelity.requiredPermissions,
    approval,
    // A connector whose id is not a built-in is a user-defined custom connector (M10-S2).
    custom: !BUILTIN_IDS.has(c.id),
  };
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
  const loadConnectorCfg = deps.loadConnectorConfig ?? loadConnectorConfigDefault;
  const saveConnectorCfg = deps.saveConnectorConfig ?? saveConnectorConfigDefault;
  const loadApprovals = deps.loadConnectorApprovals ?? loadConnectorApprovalsDefault;
  const saveApprovals = deps.saveConnectorApprovals ?? saveConnectorApprovalsDefault;

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
  // TODO(Slice 2): populate from the engine's last successful sync. `runCaptureEngine`
  // does not surface it yet, so this stays null on the wire (StatusBar renders "—").
  // eslint-disable-next-line prefer-const -- reassigned once Slice 2 wires the sync time (TODO above)
  let lastSyncAt: string | null = null;
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
    const cfg = loadConnectorCfg();
    const approvals = loadApprovals();
    const connectors = connectorRegistry.map((c) =>
      mapConnectorInfo(
        c,
        cfg.connectors[c.id]?.enabled !== false,
        home,
        approvalStatus(c, approvals, home),
      ),
    );
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
    })
      .then(() => {
        controller = null;
        enginePromise = null;
        if (intent === "pausing") {
          state = "paused";
        } else if (intent === "stopping") {
          // stop() owns the terminal state + events.
        } else {
          // Engine ended on its own (e.g. a 401 revoked the token) — surface it.
          state = "error";
          log("error", "capture engine stopped unexpectedly");
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
