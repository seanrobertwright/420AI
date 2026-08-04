import { describe, it, expect } from "vitest";
import type { Connector } from "./connector.js";
import { connectors as defaultConnectors } from "./connector.js";
import { mapConnectorInfo, toMachineConnectorReport } from "./connector-info.js";

/** A fake connector carrying the fidelity + watchGlobs the mapper reads. */
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

describe("mapConnectorInfo (the SINGLE Connector → ConnectorInfo conversion point)", () => {
  it("carries every fidelity field 1:1, plus the resolved globs and approval state", () => {
    const info = mapConnectorInfo(fakeConnector("claude-code"), true, "/fake/home", "approved");
    expect(info).toEqual({
      id: "claude-code",
      enabled: true,
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "reported",
      knownGaps: ["claude-code gap"],
      watchGlobs: ["/fake/home/.claude-code/**/*.jsonl"],
      requiredPermissions: ["Read claude-code session files"],
      approval: "approved",
      custom: false,
    });
  });

  it("flags a non-built-in id as a custom connector", () => {
    expect(mapConnectorInfo(fakeConnector("my-tool"), true, "/h", "approved").custom).toBe(true);
    // Every shipped built-in maps to custom:false — the set is computed, not hand-listed.
    for (const c of defaultConnectors) {
      expect(mapConnectorInfo(c, true, "/h", "approved").custom).toBe(false);
    }
  });

  it("passes enablement and approval through rather than re-deciding them", () => {
    const info = mapConnectorInfo(fakeConnector("codex-cli"), false, "/h", "needs-approval");
    expect(info.enabled).toBe(false);
    expect(info.approval).toBe("needs-approval");
  });
});

describe("toMachineConnectorReport (what the ARCHIVE is allowed to know)", () => {
  const info = mapConnectorInfo(fakeConnector("claude-code"), true, "/fake/home", "approved");

  /**
   * D-16.3-3, PINNED BY A TEST AND NOT ONLY BY A TYPE. `watchGlobs` are absolute paths under the
   * operator's home, so shipping them would write their username and directory layout into the
   * archive. `Omit<ConnectorInfo, "watchGlobs">` makes it a compile error, but a type says nothing
   * about the runtime object — a spread that forgot to drop the key would still typecheck at the
   * call site that built it.
   */
  it("emits NO watchGlobs key at all, and no value containing the home path", () => {
    const report = toMachineConnectorReport(info);
    expect(report).not.toHaveProperty("watchGlobs");
    expect(Object.keys(report)).not.toContain("watchGlobs");
    expect(JSON.stringify(report)).not.toContain("/fake/home");
  });

  it("DOES send requiredPermissions — the human-readable scope built for this review (12.7b)", () => {
    expect(toMachineConnectorReport(info).requiredPermissions).toEqual([
      "Read claude-code session files",
    ]);
  });

  it("carries every other ConnectorInfo field through unchanged", () => {
    const report = toMachineConnectorReport(info);
    const { watchGlobs: _dropped, ...expected } = info;
    expect(report).toMatchObject(expected);
  });

  it("folds in the collector-owned error state, defaulting to never-errored", () => {
    expect(toMachineConnectorReport(info)).toMatchObject({
      lastErrorMessage: null,
      lastErrorAt: null,
      errorCount: 0,
    });

    expect(
      toMachineConnectorReport(info, {
        message: "EACCES",
        at: "2026-08-04T12:00:00.000Z",
        count: 3,
      }),
    ).toMatchObject({
      lastErrorMessage: "EACCES",
      lastErrorAt: "2026-08-04T12:00:00.000Z",
      errorCount: 3,
    });
  });

  it("normalizes an absent `custom` to false (the wire field is required)", () => {
    const { custom: _omitted, ...withoutCustom } = info;
    expect(toMachineConnectorReport(withoutCustom).custom).toBe(false);
  });
});
