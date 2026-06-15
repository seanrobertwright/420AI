import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runServe, type ServeDeps } from "./serve.js";
import type { CaptureEngineOptions } from "./capture-engine.js";
import type { Connector } from "./connectors/connector.js";
import type { ConnectorConfig } from "./connectors/connector-config.js";
import type { ControlCommand, ControlEvent } from "@420ai/shared";

/**
 * Drives the serve protocol state machine with injected streams + a FAKE engine
 * (no real capture, no real exit) and asserts the command→event round-trip:
 * ready on boot, start runs, pause holds the backlog, resume advances, stop drains
 * + exits. Mirrors the control-protocol spike's supervisor assertions. The exit
 * seam records codes instead of killing the test runner (CLAUDE.md gotcha).
 */

interface Harness {
  stdin: PassThrough;
  events: ControlEvent[];
  exitCodes: number[];
  done: Promise<void>;
  /** Send a command line, then resolve with the next event matching `pred`. */
  send(cmd: ControlCommand | string, pred: (e: ControlEvent) => boolean): Promise<ControlEvent>;
  waitFor(pred: (e: ControlEvent) => boolean, timeoutMs?: number): Promise<ControlEvent>;
}

function makeHarness(overrides: Partial<ServeDeps> = {}): Harness {
  const stdin = new PassThrough();
  const events: ControlEvent[] = [];
  const exitCodes: number[] = [];
  let listener: ((e: ControlEvent) => void) | null = null;

  const stdout = {
    write(s: string): boolean {
      for (const line of s.split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as ControlEvent;
        events.push(ev);
        listener?.(ev);
      }
      return true;
    },
  };

  function waitFor(pred: (e: ControlEvent) => boolean, timeoutMs = 1000): Promise<ControlEvent> {
    return new Promise((resolve, reject) => {
      const prev = listener;
      const timer = setTimeout(() => {
        listener = prev;
        reject(new Error("waitFor timed out"));
      }, timeoutMs);
      listener = (e) => {
        prev?.(e);
        if (pred(e)) {
          clearTimeout(timer);
          listener = prev;
          resolve(e);
        }
      };
    });
  }

  // Fake engine: each run "captures" one item (advances pending) then idles until
  // its AbortSignal fires. So a start/resume advances pending by 1; a pause (which
  // aborts) holds it (the engine isn't re-run until resume).
  let pending = 0;
  const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
    pending += 1;
    return new Promise<void>((resolve) => {
      if (opts.signal.aborted) return resolve();
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const deps: ServeDeps = {
    stdin,
    stdout,
    stderr: { write: () => true },
    runEngine,
    queueStats: () => ({ pending, inflight: 0 }),
    loadCreds: () => ({ url: "http://archive.test", token: "tok", machineId: "machine-1" }),
    collectorVersion: "9.9.9",
    statusIntervalMs: 0, // disable the timer; tests drive status by command
    exit: (code) => exitCodes.push(code),
    pid: 4242,
    ...overrides,
  };

  const done = runServe(deps);

  function send(
    cmd: ControlCommand | string,
    pred: (e: ControlEvent) => boolean,
  ): Promise<ControlEvent> {
    const p = waitFor(pred);
    stdin.write((typeof cmd === "string" ? cmd : JSON.stringify(cmd)) + "\n");
    return p;
  }

  return { stdin, events, exitCodes, done, send, waitFor };
}

describe("serve control protocol", () => {
  it("emits ready + an initial status on boot", () => {
    const h = makeHarness();
    expect(h.events[0]).toMatchObject({
      type: "ready",
      pid: 4242,
      collectorVersion: "9.9.9",
      paired: true,
    });
    expect(h.events[1]).toMatchObject({ type: "status", state: "idle", pending: 0 });
  });

  it("start runs, pause holds the backlog, resume advances, stop drains + exits 0", async () => {
    const h = makeHarness();

    const running = await h.send({ cmd: "start" }, (e) => e.type === "status");
    expect(running).toMatchObject({ type: "status", state: "running", pending: 1 });

    const paused = await h.send({ cmd: "pause" }, (e) => e.type === "status");
    expect(paused).toMatchObject({ type: "status", state: "paused", pending: 1 }); // held

    const resumed = await h.send({ cmd: "resume" }, (e) => e.type === "status");
    expect(resumed).toMatchObject({ type: "status", state: "running", pending: 2 }); // advanced

    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
    expect(h.exitCodes).toEqual([0]);
  });

  it("status command emits an immediate status event", async () => {
    const h = makeHarness();
    const st = await h.send({ cmd: "status" }, (e) => e.type === "status");
    expect(st).toMatchObject({ type: "status", state: "idle" });
  });

  it("start before configured creds → error event, not a crash", async () => {
    const h = makeHarness({ loadCreds: () => undefined });
    const err = await h.send({ cmd: "start" }, (e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", cmd: "start" });
    expect((err as { message: string }).message).toMatch(/not configured/);
    // Loop survives: a follow-up status still answers.
    const st = await h.send({ cmd: "status" }, (e) => e.type === "status");
    expect(st).toMatchObject({ type: "status", state: "idle" });
  });

  it("malformed stdin line → error event, loop survives", async () => {
    const h = makeHarness();
    const err = await h.send("this is not json", (e) => e.type === "error");
    expect((err as { message: string }).message).toMatch(/malformed/);
    const st = await h.send({ cmd: "status" }, (e) => e.type === "status");
    expect(st).toMatchObject({ type: "status", state: "idle" });
  });

  it("configure injects creds so start can run without a saved pairing", async () => {
    const h = makeHarness({ loadCreds: () => undefined });
    await h.send({ cmd: "configure", url: "http://x", token: "t" }, (e) => e.type === "ack");
    const running = await h.send({ cmd: "start" }, (e) => e.type === "status");
    expect(running).toMatchObject({ type: "status", state: "running" });
    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
  });
});

/** A fake connector carrying the fidelity + watchGlobs the serve mapper reads. */
function fakeConnector(id: string): Connector {
  return {
    id,
    fidelity: {
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "reported",
      knownGaps: [`${id} gap`],
    },
    watchGlobs: (home: string) => [`${home}/.${id}/**/*.jsonl`],
    parse: () => ({ rawRecords: [], events: [], skippedLines: 0 }),
  };
}

/** An in-memory connector-config seam (a closure over a mutable object). */
function inMemoryConfig(initial: ConnectorConfig["connectors"] = {}): {
  load: () => ConnectorConfig;
  save: (cfg: ConnectorConfig) => void;
} {
  let cfg: ConnectorConfig = { version: "test", connectors: { ...initial } };
  return {
    load: () => ({ version: cfg.version, connectors: { ...cfg.connectors } }),
    save: (next) => {
      cfg = { version: next.version, connectors: { ...next.connectors } };
    },
  };
}

describe("serve connector management (Slice 2)", () => {
  const registry = [fakeConnector("claude-code"), fakeConnector("codex-cli")];

  it("connectors.list emits a connectors event with all connectors enabled by default", async () => {
    const store = inMemoryConfig();
    const h = makeHarness({
      connectorRegistry: registry,
      loadConnectorConfig: store.load,
      saveConnectorConfig: store.save,
      home: "/fake/home",
    });
    const ev = (await h.send(
      { cmd: "connectors.list" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    expect(ev.connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli"]);
    expect(ev.connectors.every((c) => c.enabled)).toBe(true);
    // The mapper carries fidelity 1:1 + the resolved watch globs (permission scope).
    expect(ev.connectors[0]).toMatchObject({
      id: "claude-code",
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "reported",
      knownGaps: ["claude-code gap"],
      watchGlobs: ["/fake/home/.claude-code/**/*.jsonl"],
    });
  });

  it("connectors.set persists; a follow-up list shows the id disabled", async () => {
    const store = inMemoryConfig();
    const h = makeHarness({
      connectorRegistry: registry,
      loadConnectorConfig: store.load,
      saveConnectorConfig: store.save,
    });
    await h.send({ cmd: "connectors.set", id: "codex-cli", enabled: false }, (e) => e.type === "ack");
    const ev = (await h.send(
      { cmd: "connectors.list" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    const codex = ev.connectors.find((c) => c.id === "codex-cli");
    expect(codex?.enabled).toBe(false);
    expect(ev.connectors.find((c) => c.id === "claude-code")?.enabled).toBe(true);
  });

  it("malformed connectors.set (missing id) → error event, no garbage written, loop survives", async () => {
    let saved = 0;
    const store = inMemoryConfig();
    const h = makeHarness({
      connectorRegistry: registry,
      loadConnectorConfig: store.load,
      saveConnectorConfig: (cfg) => {
        saved += 1;
        store.save(cfg);
      },
    });
    const err = await h.send(
      { cmd: "connectors.set", enabled: false } as ControlCommand,
      (e) => e.type === "error",
    );
    expect(err).toMatchObject({ type: "error", cmd: "connectors.set" });
    expect((err as { message: string }).message).toMatch(/requires id/);
    expect(saved).toBe(0); // nothing persisted
    // Loop survives: a follow-up list still answers.
    const ev = (await h.send(
      { cmd: "connectors.list" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    expect(ev.connectors.map((c) => c.id)).toEqual(["claude-code", "codex-cli"]);
  });

  it("filtering reaches the engine — a disabled connector is dropped from runEngine opts", async () => {
    const store = inMemoryConfig({ "codex-cli": { enabled: false } });
    let seen: Connector[] | undefined;
    const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
      seen = opts.connectors;
      return new Promise<void>((resolve) => {
        if (opts.signal.aborted) return resolve();
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const h = makeHarness({
      connectorRegistry: registry,
      loadConnectorConfig: store.load,
      saveConnectorConfig: store.save,
      runEngine,
    });
    await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
    expect(seen?.map((c) => c.id)).toEqual(["claude-code"]);
    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
  });
});
