import { describe, expect, it } from "vitest";
import {
  CAPTURE_HEALTH_THRESHOLDS,
  CAPTURE_HEALTH_VERDICT,
  type CaptureHealthInputs,
  type CaptureHealthState,
  type DeclaredConnectorRow,
  type ObservedConnectorRow,
  deriveCaptureHealth,
} from "./capture-health.js";

/**
 * `nowMs` is a FIXED literal in every case (CLAUDE.md: inject clocks). A test using the wall clock
 * passes today and fails in some future minute.
 */
const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function declared(over: Partial<DeclaredConnectorRow> = {}): DeclaredConnectorRow {
  return {
    machineId: "m1",
    connectorId: "claude-code",
    enabled: true,
    approval: "approved",
    status: "stable",
    captureMethod: "jsonl tail",
    liveness: "streaming",
    tokens: "exact",
    cost: "computed",
    knownGaps: [],
    requiredPermissions: ["Read ~/.claude/projects"],
    custom: false,
    lastErrorMessage: null,
    lastErrorAt: null,
    errorCount: 0,
    reportedAt: ago(10_000),
    lastEventAt: ago(MINUTE),
    eventCount: 12,
    parserVersions: ["claude-code@3"],
    ...over,
  };
}

function inputs(over: Partial<CaptureHealthInputs> = {}): CaptureHealthInputs {
  return {
    machines: [{ id: "m1", name: "laptop", status: "online" }],
    declared: [],
    observed: [],
    ...over,
  };
}

const stateOf = (i: CaptureHealthInputs, connectorId = "claude-code"): CaptureHealthState => {
  const row = deriveCaptureHealth(i, NOW).find((r) => r.connectorId === connectorId);
  if (!row) throw new Error(`no row for ${connectorId}`);
  return row.state;
};

describe("deriveCaptureHealth — every state is reachable", () => {
  it("healthy: enabled, approved, a recent event", () => {
    expect(stateOf(inputs({ declared: [declared()] }))).toBe("healthy");
  });

  it("idle: enabled, approved, quiet — and nothing else on the machine captured", () => {
    expect(stateOf(inputs({ declared: [declared({ lastEventAt: ago(3 * DAY) })] }))).toBe("idle");
  });

  it("erroring: an error at or after the last successful event", () => {
    const d = declared({
      lastEventAt: ago(2 * HOUR),
      lastErrorMessage: "EACCES: permission denied",
      lastErrorAt: ago(HOUR),
      errorCount: 4,
    });
    expect(stateOf(inputs({ declared: [d] }))).toBe("erroring");
  });

  it("needs-approval: withheld from capture pending re-approval", () => {
    expect(stateOf(inputs({ declared: [declared({ approval: "needs-approval" })] }))).toBe(
      "needs-approval",
    );
  });

  it("disabled: declared enabled:false", () => {
    expect(stateOf(inputs({ declared: [declared({ enabled: false })] }))).toBe("disabled");
  });

  it("silent: a live-capture connector quiet while a sibling on the same machine captured", () => {
    const i = inputs({
      declared: [
        declared({ connectorId: "codex-cli", lastEventAt: null, eventCount: 0 }),
        declared({ connectorId: "claude-code", lastEventAt: ago(MINUTE) }),
      ],
    });
    expect(stateOf(i, "codex-cli")).toBe("silent");
  });

  it("unreported: events observed but no machine declares the connector", () => {
    const observed: ObservedConnectorRow = {
      machineId: "m1",
      connectorId: "gemini-cli",
      lastEventAt: ago(MINUTE),
      eventCount: 5,
      parserVersions: ["gemini-cli@1"],
    };
    const row = deriveCaptureHealth(inputs({ observed: [observed] }), NOW)[0];
    expect(row?.state).toBe("unreported");
    expect(row?.declared).toBe(false);
    // NEVER "disabled" — a pre-16.3 collector reports nothing, so claiming it is off is fabrication.
    expect(row?.enabled).toBeNull();
  });

  it("unknown: an offline machine's declaration is stale", () => {
    const i = inputs({
      machines: [{ id: "m1", name: "laptop", status: "offline" }],
      declared: [declared()],
    });
    expect(stateOf(i)).toBe("unknown");
  });
});

describe("the liveness gate (D-16.3-4)", () => {
  it("a batch connector with zero events is idle, never silent", () => {
    const i = inputs({
      declared: [
        declared({
          connectorId: "claude-export",
          liveness: "batch",
          lastEventAt: null,
          eventCount: 0,
        }),
        declared({ connectorId: "claude-code", lastEventAt: ago(MINUTE) }),
      ],
    });
    expect(stateOf(i, "claude-export")).toBe("idle");
  });

  it("a snapshot connector with zero events is idle, never silent", () => {
    const i = inputs({
      declared: [
        declared({ connectorId: "cursor", liveness: "snapshot", lastEventAt: null, eventCount: 0 }),
        declared({ connectorId: "claude-code", lastEventAt: ago(MINUTE) }),
      ],
    });
    expect(stateOf(i, "cursor")).toBe("idle");
  });

  it("near-real-time counts as live capture and can be silent", () => {
    const i = inputs({
      declared: [
        declared({ connectorId: "codex-cli", liveness: "near-real-time", lastEventAt: null }),
        declared({ connectorId: "claude-code", lastEventAt: ago(MINUTE) }),
      ],
    });
    expect(stateOf(i, "codex-cli")).toBe("silent");
  });

  it("a live connector quiet on a machine where NOTHING captured is idle, not silent", () => {
    const i = inputs({
      declared: [
        declared({ connectorId: "codex-cli", lastEventAt: null }),
        declared({ connectorId: "claude-code", lastEventAt: ago(5 * DAY) }),
      ],
    });
    expect(stateOf(i, "codex-cli")).toBe("idle");
  });

  it("a sibling on a DIFFERENT machine does not make this one silent", () => {
    const i = inputs({
      machines: [
        { id: "m1", name: "laptop", status: "online" },
        { id: "m2", name: "desktop", status: "online" },
      ],
      declared: [
        declared({ machineId: "m1", connectorId: "codex-cli", lastEventAt: null }),
        declared({ machineId: "m2", connectorId: "claude-code", lastEventAt: ago(MINUTE) }),
      ],
    });
    expect(stateOf(i, "codex-cli")).toBe("idle");
  });
});

describe("precedence", () => {
  it("offline outranks everything, including a fresh event and an error", () => {
    const i = inputs({
      machines: [{ id: "m1", name: "laptop", status: "offline" }],
      declared: [declared({ enabled: false, lastErrorAt: ago(MINUTE), lastErrorMessage: "boom" })],
    });
    expect(stateOf(i)).toBe("unknown");
  });

  it("a stale (not offline) machine is still classified normally", () => {
    const i = inputs({
      machines: [{ id: "m1", name: "laptop", status: "stale" }],
      declared: [declared()],
    });
    expect(stateOf(i)).toBe("healthy");
  });

  it("disabled outranks an outstanding error", () => {
    const i = inputs({
      declared: [declared({ enabled: false, lastErrorAt: ago(MINUTE), lastErrorMessage: "boom" })],
    });
    expect(stateOf(i)).toBe("disabled");
  });

  it("needs-approval outranks idle — the silence is explained", () => {
    const i = inputs({
      declared: [declared({ approval: "needs-approval", lastEventAt: null, eventCount: 0 })],
    });
    expect(stateOf(i)).toBe("needs-approval");
  });

  it("an error BEFORE the last successful event is not erroring — it recovered", () => {
    const i = inputs({
      declared: [
        declared({
          lastEventAt: ago(MINUTE),
          lastErrorAt: ago(2 * HOUR),
          lastErrorMessage: "transient",
          errorCount: 1,
        }),
      ],
    });
    expect(stateOf(i)).toBe("healthy");
  });

  it("erroring outranks healthy when the error is newer than the event", () => {
    const i = inputs({
      declared: [
        declared({ lastEventAt: ago(2 * MINUTE), lastErrorAt: ago(MINUTE), lastErrorMessage: "x" }),
      ],
    });
    expect(stateOf(i)).toBe("erroring");
  });

  it("an error with no successful event at all is erroring", () => {
    const i = inputs({
      declared: [
        declared({
          lastEventAt: null,
          eventCount: 0,
          lastErrorAt: ago(MINUTE),
          lastErrorMessage: "x",
        }),
      ],
    });
    expect(stateOf(i)).toBe("erroring");
  });
});

describe("the freshness window", () => {
  it("an event exactly at the boundary is still healthy", () => {
    const i = inputs({
      declared: [declared({ lastEventAt: ago(CAPTURE_HEALTH_THRESHOLDS.freshEventMs) })],
    });
    expect(stateOf(i)).toBe("healthy");
  });

  it("one millisecond past the boundary is not", () => {
    const i = inputs({
      declared: [declared({ lastEventAt: ago(CAPTURE_HEALTH_THRESHOLDS.freshEventMs + 1) })],
    });
    expect(stateOf(i)).toBe("idle");
  });

  it("is NOT the 15-minute ACTIVE_WINDOW_MS — a two-hour lunch is not a capture failure", () => {
    expect(CAPTURE_HEALTH_THRESHOLDS.freshEventMs).toBeGreaterThan(15 * MINUTE);
    expect(stateOf(inputs({ declared: [declared({ lastEventAt: ago(2 * HOUR) })] }))).toBe(
      "healthy",
    );
  });

  it("an unparseable timestamp fails safe (never falsely healthy)", () => {
    expect(stateOf(inputs({ declared: [declared({ lastEventAt: "not-a-date" })] }))).toBe("idle");
  });
});

describe("shape", () => {
  it("CAPTURE_HEALTH_VERDICT has a key for every state, and only known verdicts", () => {
    const states: CaptureHealthState[] = [
      "healthy",
      "idle",
      "erroring",
      "needs-approval",
      "disabled",
      "silent",
      "unreported",
      "unknown",
    ];
    expect(Object.keys(CAPTURE_HEALTH_VERDICT).sort()).toEqual([...states].sort());
    for (const s of states) {
      expect(["capturing", "not-capturing", "broken", "unknown"]).toContain(
        CAPTURE_HEALTH_VERDICT[s],
      );
    }
  });

  it("never renders an 'I don't know' as capturing (M16 Risk 2)", () => {
    expect(CAPTURE_HEALTH_VERDICT.unreported).toBe("unknown");
    expect(CAPTURE_HEALTH_VERDICT.unknown).toBe("unknown");
  });

  it("stamps every row's verdict from the shared map, never re-decided", () => {
    const rows = deriveCaptureHealth(inputs({ declared: [declared()] }), NOW);
    expect(rows[0]?.verdict).toBe(CAPTURE_HEALTH_VERDICT[rows[0]!.state]);
  });

  it("a declared connector that is also observed yields ONE row, not two", () => {
    const i = inputs({
      declared: [declared()],
      observed: [
        {
          machineId: "m1",
          connectorId: "claude-code",
          lastEventAt: ago(MINUTE),
          eventCount: 12,
          parserVersions: ["claude-code@3"],
        },
      ],
    });
    expect(deriveCaptureHealth(i, NOW)).toHaveLength(1);
  });

  it("two machines running the same connector yield TWO rows", () => {
    const i = inputs({
      machines: [
        { id: "m1", name: "laptop", status: "online" },
        { id: "m2", name: "desktop", status: "online" },
      ],
      declared: [declared({ machineId: "m1" }), declared({ machineId: "m2" })],
    });
    const rows = deriveCaptureHealth(i, NOW);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.machineName)).toEqual(["desktop", "laptop"]);
  });

  it("falls back to the machine id when the machine is unknown, and reads offline", () => {
    const i = inputs({ machines: [], declared: [declared()] });
    const row = deriveCaptureHealth(i, NOW)[0];
    expect(row?.machineName).toBe("m1");
    expect(row?.state).toBe("unknown");
  });
});
