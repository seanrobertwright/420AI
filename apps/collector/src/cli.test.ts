import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeartbeatIntervalMs, runIngest, runReport, runWatch } from "./cli.js";
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
