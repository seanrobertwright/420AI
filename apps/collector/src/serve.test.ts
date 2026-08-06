import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { runServe, type ServeDeps } from "./serve.js";
import { faultPathFor, loadFault, saveFault } from "./fault.js";
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

/**
 * Temp collector homes minted by `makeHarness`, removed after every test.
 *
 * PR #80 review (HIGH) — `makeHarness` used to supply NO `home`, so `runServe` fell through to
 * `deps.home ?? homedir()` and every harness in this file operated on the DEVELOPER'S REAL
 * `~/.420ai`. That was harmless while nothing there was written; 16.6 made it destructive. The
 * 13.1 test below fires `onSyncSuccess(…, 1)`, which reaches the new `delivered > 0` branch and
 * `rmSync`es the real `<profile>/.420ai/fault.json` — so on a dogfood machine, where a Windows
 * service under the same profile is the documented writer, `npm test` ERASES the durable outage
 * record this slice exists to create, and `service/README.md` tells the operator "no file =
 * healthy". The suite manufactured the exact false negative the slice was built to eliminate.
 *
 * There was a quieter READ half too: `startEngine` now calls `loadFault(faultPathFor(home))`, so
 * ~15 pre-existing tests emitted an extra `error` ControlEvent IFF the host machine happened to
 * hold a fault — a unit test whose event stream depended on whose laptop ran it. Same root cause,
 * same fix. This mirrors the `approvalsBlob` seam directly above, whose comment already says it
 * exists "so seed-on-boot never touches the real ~/.420ai".
 */
const harnessHomes: string[] = [];
afterEach(() => {
  for (const h of harnessHomes.splice(0)) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

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

  // Default home = a PER-HARNESS temp dir (see `harnessHomes`). Every path `runServe` derives from
  // `home` — the fault record, the connector config, the approvals file — therefore lands in a
  // sandbox instead of the operator's profile. Tests that pass their own `home` still win: the
  // `...overrides` spread below is applied after this.
  const defaultHome = mkdtempSync(join(tmpdir(), "m16-serve-home-"));
  harnessHomes.push(defaultHome);

  const deps: ServeDeps = {
    home: defaultHome,
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

  // The structural half of the guard, applied to EVERY harness in this file including any future
  // one that passes its own `home`: a unit test may never resolve a collector-home artifact under
  // the operator's real profile. A default that silently regresses to `undefined` (which `runServe`
  // turns into `homedir()`) fails here rather than in the operator's `~/.420ai`.
  if (deps.home === undefined || deps.home === homedir()) {
    throw new Error(
      `makeHarness must run against a sandbox home, got ${String(deps.home)} — runServe writes ` +
        `fault.json / connectors.json / approvals.json under it.`,
    );
  }

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
      opts.onSyncSuccess?.("2026-07-07T00:00:00.000Z", 1);
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
  /**
   * M16 16.6 — the desktop must say WHY capture died, not just that it did.
   *
   * Before this the `.then()` branch below could only log "capture engine stopped unexpectedly":
   * the engine knew a 401 had revoked the token and threw the fact away as it unwound. This reuses
   * the EXISTING `error` ControlEvent (D-16.6-3), so CONTROL_PROTOCOL_VERSION is unchanged.
   */
  it("M16 16.6: a fatal 401 emits an error event with the reason and records it durably", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-serve-fault-"));
    try {
      const fault = {
        code: "auth_revoked" as const,
        message: "ingest returned 401 — token revoked. Re-pair needed: `collector pair <code>`.",
        since: "2026-08-06T12:00:00.000Z",
        url: "https://archive.example",
      };
      // An engine that dies fatally and returns NORMALLY — exactly how INC-2026-07 looked.
      const runEngine = async (opts: CaptureEngineOptions): Promise<void> => {
        opts.onFatal?.(fault);
      };
      const h = makeHarness({ runEngine, home });

      const err = (await h.send({ cmd: "start" }, (e) => e.type === "error")) as Extract<
        ControlEvent,
        { type: "error" }
      >;
      expect(err.message).toMatch(/401/);
      // Durable too: the desktop closing must not erase the only record of the outage.
      expect(loadFault(faultPathFor(home))).toEqual({ ...fault, lastObservedAt: fault.since });
      // F14: ONE report per stop — the reason rides the `error` event, not also a duplicate `log`.
      expect(
        h.events.filter(
          (e) =>
            e.type === "log" &&
            /capture stopped|stopped unexpectedly/.test((e as { message: string }).message),
        ),
      ).toHaveLength(0);

      const st = await h.send({ cmd: "status" }, (e) => e.type === "status");
      expect(st).toMatchObject({ type: "status", state: "error" });

      await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
      await h.done;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * F3 — a stale fault file must not survive forever.
   *
   * `startEngine` resets the in-memory `fault` on every start, so clearing only `if (fault)` meant:
   * run 1 faults and writes the file → the operator re-pairs and restarts → run 2 syncs fine → the
   * flag is false → the record survives permanently and stops meaning anything. The clear is now
   * unconditional as to WHO wrote it, and conditional only on the drain having actually delivered.
   */
  it("M16 16.6 (F3): a delivering sync clears a fault file THIS run never wrote", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-serve-fault-"));
    try {
      // A previous run (or the Windows service) left the record; this process starts clean.
      saveFault(
        {
          code: "auth_revoked",
          message: "ingest returned 401 — token revoked.",
          since: "2026-08-06T12:00:00.000Z",
          url: "https://archive.example",
        },
        faultPathFor(home),
      );
      const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
        opts.onSyncSuccess?.("2026-08-06T13:00:00.000Z", 4);
        return new Promise<void>((resolve) => {
          if (opts.signal.aborted) return resolve();
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const h = makeHarness({ runEngine, home });

      await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
      expect(existsSync(faultPathFor(home))).toBe(false);

      await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
      await h.done;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * F3 — the desktop must surface a fault recorded EARLIER (by a previous run, or by the Windows
   * service under the same profile) at launch. `loadFault` had no production caller at all, so the
   * durable record was write-only: after a restart in which the archive is merely unreachable, the
   * operator saw a perfectly healthy-looking desktop.
   *
   * Reuses the EXISTING `error` ControlEvent (D-16.6-3) — CONTROL_PROTOCOL_VERSION is untouched.
   */
  it("M16 16.6 (F3): start surfaces a pre-existing fault as an error event", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-serve-fault-"));
    try {
      saveFault(
        {
          code: "auth_revoked",
          message: "ingest returned 401 — token revoked.",
          since: "2026-08-06T12:00:00.000Z",
          url: "https://archive.example",
        },
        faultPathFor(home),
      );
      // An engine that runs perfectly well — the archive is simply unreachable, so nothing ever
      // delivers and nothing ever clears the record. Without F3 this start is completely silent.
      const runEngine = (opts: CaptureEngineOptions): Promise<void> =>
        new Promise<void>((resolve) => {
          if (opts.signal.aborted) return resolve();
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      const h = makeHarness({ runEngine, home });

      const err = (await h.send({ cmd: "start" }, (e) => e.type === "error")) as Extract<
        ControlEvent,
        { type: "error" }
      >;
      expect(err.message).toContain("capture fault is on record");
      expect(err.message).toContain("since 2026-08-06T12:00:00.000Z");

      await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
      await h.done;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * PR #80 review (HIGH) — `npm test` must not touch the operator's REAL `~/.420ai`.
   *
   * `makeHarness` supplied no `home`, so `runServe` fell back to `homedir()` and the 13.1 test's
   * `onSyncSuccess("…", 1)` reached 16.6's `delivered > 0` branch and `rmSync`ed the developer's
   * own `fault.json` — on a dogfood machine, where the Windows service under the same profile is
   * the documented writer, the suite deleted the durable outage record while `service/README.md`
   * tells the operator that no file means healthy.
   *
   * Measured, not asserted structurally: `homedir()` reads `USERPROFILE`/`HOME` on each call, so
   * redirecting them puts a REAL collector home under a temp dir. A file planted exactly where an
   * operator's would live must still be there after driving the very harness shape that deleted it
   * (no `home` override, a delivering sync). `fileParallelism: false` (vitest.config.ts) means no
   * other test file runs while the environment is redirected, and it is restored in a `finally`.
   */
  it("PR #80: a harness with NO home override never touches the real ~/.420ai", async () => {
    const profile = mkdtempSync(join(tmpdir(), "m16-serve-profile-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = profile;
    process.env.USERPROFILE = profile;
    try {
      // Sanity: without this the whole test is theatre — it would sandbox nothing and pass anyway.
      expect(homedir()).toBe(profile);
      const operatorFault = faultPathFor(homedir());
      saveFault(
        {
          code: "auth_revoked",
          message: "ingest returned 401 — token revoked.",
          since: "2026-08-06T12:00:00.000Z",
          url: "https://archive.example",
        },
        operatorFault,
      );

      // EXACTLY the shape that deleted it: no `home`, and a drain that delivered.
      const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
        opts.onSyncSuccess?.("2026-08-06T13:00:00.000Z", 1);
        return new Promise<void>((resolve) => {
          if (opts.signal.aborted) return resolve();
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const h = makeHarness({ runEngine });
      await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");

      // The operator's record survives the test suite.
      expect(existsSync(operatorFault)).toBe(true);
      expect(loadFault(operatorFault)?.since).toBe("2026-08-06T12:00:00.000Z");
      // …and the read half: the harness never announced the operator's fault as its own.
      expect(
        h.events.filter(
          (e) => e.type === "error" && /capture fault is on record/.test(e.message ?? ""),
        ),
      ).toHaveLength(0);

      await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
      await h.done;
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  /** F1's half of the same rule: an idle, empty-queue drain proves nothing and clears nothing. */
  it("M16 16.6 (F1): an empty drain (delivered=0) leaves the fault file in place", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-serve-fault-"));
    try {
      saveFault(
        {
          code: "auth_revoked",
          message: "ingest returned 401 — token revoked.",
          since: "2026-08-06T12:00:00.000Z",
          url: "https://archive.example",
        },
        faultPathFor(home),
      );
      const runEngine = (opts: CaptureEngineOptions): Promise<void> => {
        opts.onSyncSuccess?.("2026-08-06T13:00:00.000Z", 0);
        return new Promise<void>((resolve) => {
          if (opts.signal.aborted) return resolve();
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const h = makeHarness({ runEngine, home });

      await h.send({ cmd: "start" }, (e) => e.type === "status" && e.state === "running");
      expect(existsSync(faultPathFor(home))).toBe(true);

      await h.send({ cmd: "stop" }, (e) => e.type === "stopped");
      await h.done;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
