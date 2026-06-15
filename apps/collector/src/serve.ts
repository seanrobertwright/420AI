import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { runCaptureEngine, type CaptureEngineOptions } from "./capture-engine.js";
import { loadCredentials, QUEUE_PATH, type Credentials } from "./identity.js";
import { QueueStore, type QueueStats } from "./queue/queue-store.js";
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

  let state: ServeState = "idle";
  let intent: Intent = null;
  let controller: AbortController | null = null;
  let enginePromise: Promise<void> | null = null;
  let creds: Credentials | undefined = loadCreds();
  // TODO(Slice 2): populate from the engine's last successful sync. `runCaptureEngine`
  // does not surface it yet, so this stays null on the wire (StatusBar renders "—").
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
    enginePromise = runEngine({
      creds,
      signal: ctrl.signal,
      logger: (msg) => log("info", msg),
      collectorVersion,
      heartbeatIntervalMs: deps.heartbeatIntervalMs,
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
      case "stop":
        await stop(c.cmd);
        return;
      case "pair":
      case "discover":
        emit({ type: "error", message: `${c.cmd} not supported in this build (Slice 3+)`, cmd: c.cmd });
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
    chain = chain.then(() => handle(c)).catch((err) => {
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
