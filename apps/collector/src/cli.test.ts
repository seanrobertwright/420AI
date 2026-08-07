import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHeartbeatIntervalMs,
  runIngest,
  runReport,
  runWatch,
  watchExitCode,
  type WatchRunResult,
} from "./cli.js";
import {
  faultPathFor,
  loadFault,
  saveFault,
  type DegradedCaptureFault,
  type FatalCaptureFault,
} from "./fault.js";
import type { CaptureEngineOptions } from "./capture-engine.js";
import type { ConnectorConfig } from "./connectors/connector-config.js";
import type { ConnectorApprovals } from "./connectors/connector-approvals.js";

const fixturePath = fileURLToPath(new URL("./fixtures/sample-session.jsonl", import.meta.url));

let dbPath: string | undefined;

afterEach(() => {
  if (dbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
    dbPath = undefined;
  }
});

describe("cli end-to-end (parse → store → report)", () => {
  it("ingests the fixture and renders a report with cost and tokens", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-e2e.sqlite`);
    const summary = runIngest(fixturePath, dbPath);
    expect(summary.sessionId).toBe("sess-fixture-1");
    expect(summary.skippedLines).toBe(1);

    const md = runReport("sess-fixture-1", dbPath);
    expect(md).toContain("# Session Report — sess-fixture-1");
    expect(md).toContain("| 100 | 50 | 30 | 20 | 200 |");
    expect(md).toContain("`estimated-model-known`");
  });

  it("is idempotent across the whole pipe (ingest twice → stable event count)", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-idem.sqlite`);
    const first = runIngest(fixturePath, dbPath);
    const second = runIngest(fixturePath, dbPath);
    expect(second.events).toBe(first.events);

    // And the report still renders identically.
    const md1 = runReport("sess-fixture-1", dbPath);
    const md2 = runReport("sess-fixture-1", dbPath);
    expect(md2).toBe(md1);
  });

  it("throws a clear error reporting an unknown session", () => {
    dbPath = join(tmpdir(), `m1-cli-${process.pid}-missing.sqlite`);
    runIngest(fixturePath, dbPath);
    expect(() => runReport("does-not-exist", dbPath)).toThrow(/No events for session/);
  });
});

describe("parseHeartbeatIntervalMs", () => {
  it("returns undefined for missing or invalid values so watch falls back to the default", () => {
    expect(parseHeartbeatIntervalMs(undefined)).toBeUndefined();
    expect(parseHeartbeatIntervalMs("abc")).toBeUndefined();
    expect(parseHeartbeatIntervalMs("0")).toBeUndefined();
    expect(parseHeartbeatIntervalMs("-1")).toBeUndefined();
    expect(parseHeartbeatIntervalMs("Infinity")).toBeUndefined();
  });

  it("returns a positive finite interval override", () => {
    expect(parseHeartbeatIntervalMs("15000")).toBe(15000);
  });
});

/**
 * F-16.3-1 REGRESSION PIN (M16 16.3).
 *
 * `runWatch` handed `loadRegistry(...)` straight to the engine with NO `filterConnectors` and NO
 * `filterByApproval`, so a connector the operator disabled in the desktop UI kept capturing under
 * `collector watch` — and therefore under the Windows service, which runs `watch --home …`. `serve`
 * applied both filters; `watch` applied neither, and nothing tested it because `runWatch` had no
 * engine seam at all. That is how it survived: the fix and the seam ship together on purpose.
 */
describe("runWatch connector filtering (F-16.3-1)", () => {
  const capture = async (
    connectorConfig: ConnectorConfig["connectors"],
    approvals: ConnectorApprovals = { version: "test", approved: {} },
  ): Promise<CaptureEngineOptions> => {
    const home = mkdtempSync(join(tmpdir(), "m16-watch-"));
    homes.push(home);
    let seen: CaptureEngineOptions | undefined;
    await runWatch({
      url: "http://127.0.0.1:1/unreachable", // the catalog pull is best-effort and never throws
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: connectorConfig }),
      loadConnectorApprovals: () => approvals,
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        seen = o;
      },
    });
    expect(seen, "the engine was never invoked").toBeDefined();
    return seen!;
  };

  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("hands the engine the FILTERED capture set and the FULL registry", async () => {
    const opts = await capture({ "codex-cli": { enabled: false } });

    const capturing = opts.connectors!.map((c) => c.id);
    const reporting = opts.registry!.map((c) => c.id);

    // The disabled connector does NOT capture — this is the defect, pinned.
    expect(capturing).not.toContain("codex-cli");
    expect(capturing).toContain("claude-code");
    // …but it IS still reported, or the scorecard could not tell "deliberately off" from "broken",
    // which is the entire acceptance criterion of this slice.
    expect(reporting).toContain("codex-cli");
    expect(reporting.length).toBe(capturing.length + 1);
  });

  it("default-on is preserved: an absent id still captures", async () => {
    const opts = await capture({});
    expect(opts.connectors!.map((c) => c.id)).toEqual(opts.registry!.map((c) => c.id));
    expect(opts.connectors!.length).toBeGreaterThan(0);
  });

  it("reports a disabled connector as enabled:false and a withheld one as needs-approval", async () => {
    const opts = await capture(
      { "codex-cli": { enabled: false } },
      // A recorded fingerprint that cannot match the connector's CURRENT surface ⇒ needs-approval.
      { version: "test", approved: { "gemini-cli": { surfaceFingerprint: "stale-fingerprint" } } },
    );

    const states = opts.connectorStates!(opts.registry!);
    expect(states.get("codex-cli")).toEqual({ enabled: false, approval: "approved" });
    expect(states.get("gemini-cli")).toEqual({ enabled: true, approval: "needs-approval" });
    expect(states.get("claude-code")).toEqual({ enabled: true, approval: "approved" });
    // Every registry connector is resolved — an absence would be reported as not-capturing, so a
    // gap here would silently understate capture rather than error.
    expect(states.size).toBe(opts.registry!.length);

    // A withheld connector is withheld from CAPTURE too — both filters compose.
    expect(opts.connectors!.map((c) => c.id)).not.toContain("gemini-cli");
  });
});

/**
 * M16 16.6 — `collector watch` must report a fatal 401 through a channel that is not "success".
 *
 * The one-shot sibling `collector sync` learned this as C.11 in M12 (outcome "stop" → stderr +
 * exit 1). The daemon never did: `process.exit(0)` ran unconditionally after `runWatch`, so a
 * revoked token looked identical to Ctrl-C — to the operator AND to WinSW, whose `<onfailure>`
 * restart triggers only on a non-zero exit. These pin the missing half.
 */
describe("runWatch fatal fault (M16 16.6 — the C.11 lesson, applied to the daemon)", () => {
  const watchHomes: string[] = [];
  afterEach(() => {
    for (const h of watchHomes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  const watch = async (
    runEngine: (o: CaptureEngineOptions) => Promise<void>,
  ): Promise<{ home: string; result: WatchRunResult }> => {
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    watchHomes.push(home);
    const result = await runWatch({
      url: "http://127.0.0.1:1/unreachable", // the catalog pull is best-effort and never throws
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine,
    });
    return { home, result };
  };

  const fault: FatalCaptureFault = {
    code: "auth_revoked",
    message: "ingest returned 401 — token revoked.",
    since: "2026-08-06T12:00:00.000Z",
    url: "https://archive.example",
  };

  it("writes the fault file and reports the fault when the engine fires onFatal", async () => {
    const { home, result } = await watch(async (o) => {
      o.onFatal?.(fault);
    });

    expect(result.fault).toEqual(fault);
    expect(result.recorded).toBe(true);
    // Written under the SAME --home as creds + queue, so the Windows service and the desktop read
    // one profile rather than two (see `faultPathFor`).
    expect(loadFault(faultPathFor(home))).toEqual({ ...fault, lastObservedAt: fault.since });
  });

  /**
   * F4 — a failed write must not be reported as a successful one. The engine's `onStop` swallows
   * anything thrown by the reporter, so before this the CLI printed "Recorded at <path>" for a file
   * that was never created (read-only disk / ENOSPC / EPERM are all plausible for a LocalSystem
   * service). The exit code must survive the failure: `fault` is still set.
   */
  it("reports recorded=false — but still a fault — when the fault file cannot be written", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    watchHomes.push(home);
    // `.420ai` exists as a FILE, so `saveFault`'s mkdirSync of the parent throws.
    writeFileSync(join(home, ".420ai"), "not a directory");
    const logs: string[] = [];

    const result = await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      logger: (m) => logs.push(m),
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        o.onFatal?.(fault);
      },
    });

    expect(result.fault).toEqual(fault); // exit code unaffected by the write failing
    expect(result.recorded).toBe(false); // …so the entrypoint must not claim it was recorded
    expect(logs.join("\n")).toMatch(/could not record capture fault/);
  });

  it("a clean SIGINT-style return reports NO fault (so the entrypoint exits 0)", async () => {
    const { home, result } = await watch(async () => {});

    expect(result.fault).toBeUndefined();
    expect(existsSync(faultPathFor(home))).toBe(false);
  });

  /** Drive a `runWatch` over a home pre-seeded with a fault, firing one `onSyncSuccess` drain. */
  const watchWithSeededFault = async (delivered: number): Promise<string> => {
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    watchHomes.push(home);
    // A previous process died faulted — the record is on disk before this run starts.
    saveFault(fault, faultPathFor(home));

    const result = await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        o.onSyncSuccess?.("2026-08-06T13:00:00.000Z", delivered);
      },
    });
    expect(result.fault).toBeUndefined();
    return home;
  };

  it("a DELIVERING sync clears a fault left by an earlier run (self-resolving)", async () => {
    const home = await watchWithSeededFault(7);
    expect(existsSync(faultPathFor(home))).toBe(false);
  });

  /**
   * F1 — the fault must NOT self-resolve on a drain that never contacted the archive.
   *
   * `syncOnce` returns "ok" immediately when the queue is empty, without making a request, and
   * `runSyncLoop` fires `onSync` on every such tick (~2 s). Clearing on that meant: 401 → exit 1 →
   * WinSW restart → first idle tick on a quiet machine DELETES `fault.json`, having sent nothing —
   * the precise opposite of what `service/README.md` tells the operator to trust.
   */
  it("an EMPTY drain (delivered=0) leaves the fault on disk — it contacted nothing", async () => {
    const home = await watchWithSeededFault(0);
    expect(existsSync(faultPathFor(home))).toBe(true);
    expect(loadFault(faultPathFor(home))?.code).toBe("auth_revoked");
  });

  /**
   * F3 — `loadFault` had NO production caller: the record was written and never read back.
   *
   * The case that costs: the collector restarts while the archive is merely UNREACHABLE (network
   * down, containers not up) rather than 401. Capture runs happily, nothing delivers, nothing
   * clears the file — and the operator is told nothing at all unless they think to open
   * `fault.json` by hand, which is exactly the "you must suspect it first" trigger this slice
   * exists to remove.
   */
  it("F3: reports a fault recorded by an EARLIER run through the logger at startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    watchHomes.push(home);
    saveFault(fault, faultPathFor(home));
    // …and a second observation, so `lastObservedAt` differs from `since` and the reported pair is
    // actually the outage's duration rather than the same instant twice.
    saveFault({ ...fault, since: "2026-08-14T09:31:04.220Z" }, faultPathFor(home));
    const logs: string[] = [];

    await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      logger: (m) => logs.push(m),
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      // A clean run that neither faults nor delivers — the archive is simply unreachable.
      runEngine: async () => {},
    });

    const line = logs.find((m) => m.includes("capture fault (capture had stopped) is on record"));
    expect(line, logs.join("\n")).toBeDefined();
    expect(line).toContain(faultPathFor(home));
    expect(line).toContain("since 2026-08-06T12:00:00.000Z"); // when the outage STARTED
    expect(line).toContain("last observed 2026-08-14T09:31:04.220Z");
  });

  it("F3: says nothing when there is no fault on record", async () => {
    const logs: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    watchHomes.push(home);
    await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      logger: (m) => logs.push(m),
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async () => {},
    });
    // A plain substring, NOT a regex: the announcement text now contains parentheses, and
    // `/…(capture had stopped)…/` would silently become a capture group that matches nothing —
    // making this negative assertion pass vacuously, which is the one way it can be worthless.
    expect(logs.join("\n")).not.toContain("is on record");
  });
});

/**
 * F6 — the slice's headline behaviour, finally testable. `main()` is not exported and
 * `process.exit` is not seamed, so deleting the whole `if (fault)` branch left every test green.
 * The mapper is extracted for exactly the reason `pairSummary` / `formatCliError` were.
 */
describe("watchExitCode (M16 16.6 — exit 1 on a fatal 401, 0 on SIGINT)", () => {
  const fault: FatalCaptureFault = {
    code: "auth_revoked",
    message: "ingest returned 401 — token revoked.",
    since: "2026-08-06T12:00:00.000Z",
    url: "https://archive.example",
  };

  it("exits 1 for a fatal fault, so WinSW's <onfailure> restart actually fires", () => {
    expect(watchExitCode({ fault, recorded: true })).toBe(1);
    // …even when the durable record could not be written: the exit code is the other half of the
    // signal, and losing both is how INC-2026-07 stayed invisible.
    expect(watchExitCode({ fault, recorded: false })).toBe(1);
  });

  it("exits 0 for a clean SIGINT-style stop, so a deliberate stop never restart-loops", () => {
    expect(watchExitCode({ recorded: false })).toBe(0);
  });

  /**
   * `recorded` is REQUIRED. `runWatch` initialises it to `false` and always returns it, so marking
   * it optional made the type claim something untrue — and the claim is load-bearing, because
   * `main()` prints "WARNING: the fault record could NOT be written" on the falsy branch. An
   * `undefined` there is a warning about a write that succeeded.
   *
   * Enforced by the COMPILER (root `tsc -b` covers co-located `*.test.ts`): `@ts-expect-error` is
   * itself an error when the expression compiles cleanly, so making `recorded` optional again fails
   * the typecheck on this line.
   */
  it("declares `recorded` as required, not optional", async () => {
    // @ts-expect-error `recorded` is required — omitting it must not compile.
    const missing: WatchRunResult = { fault };
    expect(watchExitCode(missing)).toBe(1);
    // …and the runtime honours the declaration on the happy path too.
    const home = mkdtempSync(join(tmpdir(), "m16-fault-watch-"));
    try {
      const result = await runWatch({
        url: "http://127.0.0.1:1/unreachable",
        token: "t",
        home,
        signal: new AbortController().signal,
        loadConnectorConfig: () => ({ version: "test", connectors: {} }),
        loadConnectorApprovals: () => ({ version: "test", approved: {} }),
        saveConnectorApprovals: () => {},
        runEngine: async () => {},
      });
      expect(result.recorded).toBe(false);
      expect(typeof result.recorded).toBe("boolean");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * M16 16.7 — the DEGRADED fault must reach disk WITHOUT reaching the exit code (D-16.7-8).
 *
 * This is the acceptance criterion the whole "separate callback" design exists for, and it is
 * exactly the kind of thing that would ship broken and stay green: wiring `onDegraded` to the same
 * `fault = f` assignment as `onFatal` typechecks perfectly, writes the same file, and looks right in
 * review. It would also make `watchExitCode` return 1 for an unreachable archive, which WinSW's
 * `<onfailure action="restart"/>` turns into a RESTART LOOP — the collector thrashing precisely
 * while its durable queue is the only thing preserving the data, and restarting cannot make an
 * unreachable archive reachable.
 *
 * So: the file appears, `result.fault` stays undefined, and `watchExitCode` stays 0.
 */
describe("runWatch onDegraded (M16 16.7 — degraded is NOT fatal)", () => {
  const degradedHomes: string[] = [];
  afterEach(() => {
    for (const h of degradedHomes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  const degraded: DegradedCaptureFault = {
    code: "archive_unreachable",
    message: "cannot reach the archive (3 consecutive sync failures). Capture is STILL RUNNING",
    since: "2026-08-06T12:00:00.000Z",
    url: "http://127.0.0.1:1/unreachable",
  };

  /** Drive `runWatch` with an engine that fires ONE `onDegraded` and then returns. */
  async function watchWithDegraded(): Promise<{
    home: string;
    result: Awaited<ReturnType<typeof runWatch>>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "m16-degraded-watch-"));
    degradedHomes.push(home);
    const result = await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        o.onDegraded?.(degraded);
      },
    });
    return { home, result };
  }

  it("writes fault.json but leaves result.fault undefined, so the exit code stays 0", async () => {
    const { home, result } = await watchWithDegraded();
    // The record is durable…
    const onDisk = loadFault(faultPathFor(home));
    expect(onDisk).toBeDefined();
    expect(onDisk!.code).toBe("archive_unreachable");
    expect(onDisk!.since).toBe(degraded.since);
    // …and it is NOT a capture STOP. `result.fault` keeps its meaning: "capture stopped".
    expect(result.fault).toBeUndefined();
    expect(watchExitCode(result)).toBe(0);
  });

  it("a DELIVERING drain clears it, exactly as it clears a fatal one", async () => {
    // The self-resolving half. Only bytes the archive ACCEPTED prove it is reachable again, which
    // is why the clear is gated on `delivered > 0` for both codes and not on outcome "ok".
    const home = mkdtempSync(join(tmpdir(), "m16-degraded-clear-"));
    degradedHomes.push(home);
    const result = await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        o.onDegraded?.(degraded);
        o.onSyncSuccess?.("2026-08-06T13:00:00.000Z", 5);
      },
    });
    expect(existsSync(faultPathFor(home))).toBe(false);
    expect(watchExitCode(result)).toBe(0);
  });

  it("an EMPTY drain leaves it — a no-op tick contacted nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "m16-degraded-keep-"));
    degradedHomes.push(home);
    await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async (o) => {
        o.onDegraded?.(degraded);
        o.onSyncSuccess?.("2026-08-06T13:00:00.000Z", 0);
      },
    });
    expect(loadFault(faultPathFor(home))?.code).toBe("archive_unreachable");
  });

  it("announces a prior DEGRADED fault as degraded, not as a stop", async () => {
    // The operator-facing half. "a capture fault is on record" said the same words for both codes,
    // which tells someone capture STOPPED when an `archive_unreachable` record means the opposite.
    const home = mkdtempSync(join(tmpdir(), "m16-degraded-announce-"));
    degradedHomes.push(home);
    saveFault(degraded, faultPathFor(home));
    const logs: string[] = [];
    await runWatch({
      url: "http://127.0.0.1:1/unreachable",
      token: "t",
      home,
      signal: new AbortController().signal,
      logger: (m) => logs.push(m),
      loadConnectorConfig: () => ({ version: "test", connectors: {} }),
      loadConnectorApprovals: () => ({ version: "test", approved: {} }),
      saveConnectorApprovals: () => {},
      runEngine: async () => {},
    });
    const line = logs.find((m) => m.includes("is on record"));
    expect(line, logs.join("\n")).toBeDefined();
    expect(line).toContain("DEGRADED");
    expect(line).toContain("capture kept running");
    expect(line).not.toContain("capture had stopped");
  });
});
