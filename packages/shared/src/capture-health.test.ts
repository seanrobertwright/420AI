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

  /**
   * THIS TEST USED TO ASSERT `idle`, AND IT WAS ENCODING THE BUG (corrected in PR #77 review).
   *
   * A machine where nothing captured is the OUTAGE case, not the quiet-week case, and `idle`'s
   * verdict is `capturing` — so the suite was actively certifying that a total capture failure
   * reads as "Capturing". A connector that has produced NOTHING, EVER is an unproven capture path
   * and does not get the benefit of the doubt; sibling evidence remains the trigger for a connector
   * that used to produce and stopped. The stale-but-non-null sibling below is deliberately kept so
   * this still exercises "no fresh activity anywhere on the machine".
   */
  it("a live connector that never produced is silent even when NOTHING else captured either", () => {
    const i = inputs({
      declared: [
        declared({ connectorId: "codex-cli", lastEventAt: null }),
        declared({ connectorId: "claude-code", lastEventAt: ago(5 * DAY) }),
      ],
    });
    expect(stateOf(i, "codex-cli")).toBe("silent");
    // Its sibling HAS produced before, just not recently, and no fresh sibling accuses it — so it
    // stays `idle`. The two rules coexist rather than one swallowing the other.
    expect(stateOf(i, "claude-code")).toBe("idle");
  });

  it("a sibling on a DIFFERENT machine does not make this one silent", () => {
    // The connector under test has a STALE but non-null `lastEventAt` on purpose: with `null` it
    // would now be `silent` for the never-produced reason and this test would pass without ever
    // exercising the machine-scoping it exists to check (it did, until PR #77 review).
    const i = inputs({
      machines: [
        { id: "m1", name: "laptop", status: "online" },
        { id: "m2", name: "desktop", status: "online" },
      ],
      declared: [
        declared({ machineId: "m1", connectorId: "codex-cli", lastEventAt: ago(5 * DAY) }),
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

/**
 * PR #77 review. Every case below was a gap that a MUTATION survived — the reviewer broke the
 * production code and all 30 existing tests still passed. A test suite that stays green while the
 * decision it is supposed to pin is inverted is measuring nothing, so each of these was written
 * against the specific mutation that escaped.
 */
describe("deriveCaptureHealth — the decisions nothing was pinning", () => {
  it("a live connector that NEVER produced is silent, with no sibling to accuse it", () => {
    // THE OUTAGE CASE, and the one that made the whole scorecard lie. A machine-wide failure (the
    // documented LocalSystem `--home` footgun) leaves every connector with no events and no error,
    // so before the fix each fell through to `idle` — whose verdict is `capturing` — and the panel
    // reported "2 Capturing" for a machine capturing NOTHING.
    const i = inputs({
      declared: [
        declared({ connectorId: "claude-code", lastEventAt: null, eventCount: 0 }),
        declared({ connectorId: "codex-cli", lastEventAt: null, eventCount: 0 }),
      ],
    });
    const rows = deriveCaptureHealth(i, NOW);
    expect(rows.map((r) => r.state)).toEqual(["silent", "silent"]);
    // The verdict is what the operator actually reads.
    expect(rows.every((r) => r.verdict === "broken")).toBe(true);
  });

  it("a BATCH connector that never produced is still idle — the D-16.3-4 gate holds", () => {
    // The guard on the fix above: an export connector may legitimately never have run.
    const i = inputs({
      declared: [declared({ liveness: "batch", lastEventAt: null, eventCount: 0 })],
    });
    expect(stateOf(i)).toBe("idle");
  });

  it("sibling evidence counts OBSERVED rows, not just declared ones", () => {
    // Mutation that escaped: deleting `...inputs.observed` from the evidence set. A machine whose
    // only fresh activity comes from an UNDECLARED (pre-16.3) connector must still incriminate its
    // declared siblings. Uses a stale-but-non-null lastEventAt so the never-produced rule above is
    // not what makes it pass.
    const i = inputs({
      declared: [declared({ lastEventAt: ago(3 * DAY) })],
      observed: [
        {
          machineId: "m1",
          connectorId: "cursor",
          lastEventAt: ago(MINUTE),
          eventCount: 5,
          parserVersions: [],
        },
      ],
    });
    expect(stateOf(i)).toBe("silent");
  });

  it("an error EXACTLY at the last event is erroring — the >= boundary", () => {
    // Mutation that escaped: weakening `errorMs >= eventMs` to `>`. This is the single comparison
    // deciding erroring-vs-healthy, and the comment documents "at or after".
    const at = ago(30 * MINUTE);
    const i = inputs({
      declared: [declared({ lastEventAt: at, lastErrorAt: at, lastErrorMessage: "EACCES" })],
    });
    expect(stateOf(i)).toBe("erroring");
  });

  it("an observed-only row on an OFFLINE machine stays unreported, never unknown", () => {
    // The observed branch hardcodes `unreported` and the comment says machine status must not
    // override it: "your collector does not report this yet" is the more actionable of two unknowns.
    const i = inputs({
      machines: [{ id: "m1", name: "laptop", status: "offline" }],
      observed: [
        {
          machineId: "m1",
          connectorId: "cursor",
          lastEventAt: ago(2 * DAY),
          eventCount: 3,
          parserVersions: [],
        },
      ],
    });
    expect(stateOf(i, "cursor")).toBe("unreported");
  });

  it("an unparseable lastErrorAt is not treated as an error", () => {
    // `msOf` returns null on garbage, so the connector is NEVER erroring. Pinned so the direction is
    // a decision rather than an accident: an unreadable error timestamp must not manufacture a red
    // row, and the freshness side already fails safe the same way.
    const i = inputs({
      declared: [declared({ lastErrorAt: "not a date", lastErrorMessage: "EACCES" })],
    });
    expect(stateOf(i)).toBe("healthy");
  });

  it("sorts by machine id when two machines share a name — row order is the panel's contract", () => {
    const i = inputs({
      machines: [
        { id: "m2", name: "laptop", status: "online" },
        { id: "m1", name: "laptop", status: "online" },
      ],
      declared: [declared({ machineId: "m2" }), declared({ machineId: "m1" })],
    });
    expect(deriveCaptureHealth(i, NOW).map((r) => r.machineId)).toEqual(["m1", "m2"]);
  });
});
