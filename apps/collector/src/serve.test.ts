import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runServe, type ServeDeps } from "./serve.js";
import type { CaptureEngineOptions } from "./capture-engine.js";
import { connectors as defaultConnectors, type Connector } from "./connectors/connector.js";
import type { ConnectorConfig } from "./connectors/connector-config.js";
import {
  captureSurfaceFingerprint,
  type ConnectorApprovals,
} from "./connectors/connector-approvals.js";
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

  // Default in-memory approvals seam so seed-on-boot never touches the real ~/.420ai.
  // (Tests that need to assert drift inject their own via overrides.)
  let approvalsBlob: ConnectorApprovals = { version: "test", approved: {} };

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
    // Inject the built-in registry by default so non-overriding tests never read the
    // real ~/.420ai/custom-connectors.json (runServe's loadRegistry branch is skipped).
    connectorRegistry: defaultConnectors,
    loadConnectorApprovals: () => ({
      version: approvalsBlob.version,
      approved: { ...approvalsBlob.approved },
    }),
    saveConnectorApprovals: (next) => {
      approvalsBlob = { version: next.version, approved: { ...next.approved } };
    },
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

  it("M13 13.1: a successful sync surfaces a non-null ISO lastSyncAt on status", async () => {
    const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
      opts.onSyncSuccess?.("2026-07-07T00:00:00.000Z");
      return new Promise<void>((resolve) => {
        if (opts.signal.aborted) return resolve();
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const h = makeHarness({ runEngine });
    // Before any sync, lastSyncAt stays null (never rendered as a stale/fake time).
    const before = await h.send({ cmd: "status" }, (e) => e.type === "status");
    expect(before).toMatchObject({ type: "status", lastSyncAt: null });

    const running = await h.send({ cmd: "start" }, (e) => e.type === "status");
    expect(running).toMatchObject({
      type: "status",
      state: "running",
      lastSyncAt: "2026-07-07T00:00:00.000Z",
    });

    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
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
      requiredPermissions: [`Read ${id} session files`],
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
    // The mapper carries fidelity 1:1 + the resolved watch globs (permission scope) +
    // the declared §10.3 permissions and the §10.4 approval state (seeded approved).
    expect(ev.connectors[0]).toMatchObject({
      id: "claude-code",
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "reported",
      knownGaps: ["claude-code gap"],
      watchGlobs: ["/fake/home/.claude-code/**/*.jsonl"],
      requiredPermissions: ["Read claude-code session files"],
      approval: "approved",
    });
    expect(ev.connectors.every((c) => c.approval === "approved")).toBe(true);
  });

  it("connectors.set persists; a follow-up list shows the id disabled", async () => {
    const store = inMemoryConfig();
    const h = makeHarness({
      connectorRegistry: registry,
      loadConnectorConfig: store.load,
      saveConnectorConfig: store.save,
    });
    await h.send(
      { cmd: "connectors.set", id: "codex-cli", enabled: false },
      (e) => e.type === "ack",
    );
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

/** An in-memory approvals seam (a closure over a mutable blob). */
function inMemoryApprovals(initial: ConnectorApprovals["approved"] = {}): {
  load: () => ConnectorApprovals;
  save: (cfg: ConnectorApprovals) => void;
  saved: () => number;
} {
  let cfg: ConnectorApprovals = { version: "test", approved: { ...initial } };
  let saves = 0;
  return {
    load: () => ({ version: cfg.version, approved: { ...cfg.approved } }),
    save: (next) => {
      saves += 1;
      cfg = { version: next.version, approved: { ...next.approved } };
    },
    saved: () => saves,
  };
}

describe("serve connector approvals (Slice 12.7b)", () => {
  const registry = [fakeConnector("claude-code"), fakeConnector("codex-cli")];
  const HOME = "/fake/home";

  it("connectors.approve records the surface + acks + re-emits; the seam is persisted", async () => {
    const approvals = inMemoryApprovals();
    const h = makeHarness({
      connectorRegistry: registry,
      home: HOME,
      loadConnectorApprovals: approvals.load,
      saveConnectorApprovals: approvals.save,
    });
    const savesBeforeCmd = approvals.saved(); // boot seed already ran
    // approve acks THEN re-emits `connectors` synchronously — wait for the trailing
    // connectors event (the ack precedes it in the captured stream).
    const ev = (await h.send(
      { cmd: "connectors.approve", id: "codex-cli" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    expect(h.events.some((e) => e.type === "ack" && e.cmd === "connectors.approve")).toBe(true);
    expect(approvals.saved()).toBeGreaterThan(savesBeforeCmd); // approval persisted
    expect(ev.connectors.find((c) => c.id === "codex-cli")?.approval).toBe("approved");
  });

  it("connectors.approve for an unknown id → error event, no throw, loop survives", async () => {
    const approvals = inMemoryApprovals();
    const h = makeHarness({
      connectorRegistry: registry,
      home: HOME,
      loadConnectorApprovals: approvals.load,
      saveConnectorApprovals: approvals.save,
    });
    const err = await h.send(
      { cmd: "connectors.approve", id: "ghost-cli" },
      (e) => e.type === "error",
    );
    expect(err).toMatchObject({ type: "error", cmd: "connectors.approve" });
    expect((err as { message: string }).message).toMatch(/unknown connector id/);
    const st = await h.send({ cmd: "status" }, (e) => e.type === "status");
    expect(st).toMatchObject({ type: "status", state: "idle" });
  });

  it("a drifted connector is reported needs-approval AND withheld from the engine", async () => {
    // Pre-seed codex-cli with a STALE fingerprint (simulating a prior, narrower scope) so
    // its current surface drifts on boot. claude-code is left unrecorded ⇒ seeded approved.
    const approvals = inMemoryApprovals({ "codex-cli": { surfaceFingerprint: "stale-deadbeef" } });
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
      home: HOME,
      loadConnectorApprovals: approvals.load,
      saveConnectorApprovals: approvals.save,
      runEngine,
    });
    const ev = (await h.send(
      { cmd: "connectors.list" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    expect(ev.connectors.find((c) => c.id === "codex-cli")?.approval).toBe("needs-approval");
    expect(ev.connectors.find((c) => c.id === "claude-code")?.approval).toBe("approved");

    await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
    // The drifted connector is withheld from capture (filtered out of the engine's registry).
    expect(seen?.map((c) => c.id)).toEqual(["claude-code"]);
    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
  });

  it("approving a drifted connector restores it to capture on the next start", async () => {
    const approvals = inMemoryApprovals({ "codex-cli": { surfaceFingerprint: "stale-deadbeef" } });
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
      home: HOME,
      loadConnectorApprovals: approvals.load,
      saveConnectorApprovals: approvals.save,
      runEngine,
    });
    await h.send({ cmd: "connectors.approve", id: "codex-cli" }, (e) => e.type === "ack");
    // Sanity: the persisted fingerprint now matches the connector's current surface.
    const codex = registry.find((c) => c.id === "codex-cli")!;
    expect(approvals.load().approved["codex-cli"]?.surfaceFingerprint).toBe(
      captureSurfaceFingerprint(codex, HOME),
    );
    await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
    expect(seen?.map((c) => c.id)?.sort()).toEqual(["claude-code", "codex-cli"]);
    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
  });
});

describe("serve custom connectors (M10-S2)", () => {
  // `custom` is id-derived (not a built-in id ⇒ custom), so a fake connector with a
  // non-built-in id is flagged custom:true regardless of its fidelity fields.
  const registry = [fakeConnector("claude-code"), fakeConnector("custom-mytool")];

  it("connectors.list flags a user-defined connector with custom:true (built-ins false)", async () => {
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
    expect(ev.connectors.find((c) => c.id === "custom-mytool")?.custom).toBe(true);
    expect(ev.connectors.find((c) => c.id === "claude-code")?.custom).toBe(false);
  });

  it("a custom connector honors connectors.set disable and is dropped from capture", async () => {
    const store = inMemoryConfig();
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
    await h.send(
      { cmd: "connectors.set", id: "custom-mytool", enabled: false },
      (e) => e.type === "ack",
    );
    const ev = (await h.send(
      { cmd: "connectors.list" },
      (e) => e.type === "connectors",
    )) as Extract<ControlEvent, { type: "connectors" }>;
    expect(ev.connectors.find((c) => c.id === "custom-mytool")?.enabled).toBe(false);
    await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
    expect(seen?.map((c) => c.id)).toEqual(["claude-code"]);
    await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
    await h.done;
  });
});
