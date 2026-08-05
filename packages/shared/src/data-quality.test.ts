import { describe, it, expect } from "vitest";
import type {
  ConnectorDeclarationRow,
  DataQualityInputs,
  GitLinkageRow,
  IngestLagRow,
  RecoverabilityRow,
  SessionQualityRow,
} from "./data-quality.js";
import {
  DATA_QUALITY_THRESHOLDS,
  DATA_QUALITY_VERSION,
  deriveDataQualityMetrics,
  ratioMetric,
} from "./data-quality.js";
import { CAPTURE_HEALTH_VERSION } from "./capture-health.js";

/**
 * M16 16.4 — the honesty rules, tested with NO database.
 *
 * That is the reason for the shared/db split, not an incidental benefit: the claims this module
 * makes are all of the form "we cannot tell", and a claim about the ABSENCE of evidence is exactly
 * the kind that must be provable without infrastructure (milestone Risk 2).
 */

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const SINCE = "2026-07-28T12:00:00.000Z";

function session(over: Partial<SessionQualityRow> = {}): SessionQualityRow {
  return {
    sessionId: "s1",
    sourceConnector: "claude-code",
    eventCount: 10,
    withTokens: 5,
    attributed: true,
    ...over,
  };
}

function declaration(over: Partial<ConnectorDeclarationRow> = {}): ConnectorDeclarationRow {
  return { connectorId: "claude-code", tokens: "exact", liveness: "streaming", ...over };
}

function recovered(over: Partial<RecoverabilityRow> = {}): RecoverabilityRow {
  return {
    sessionId: "s1",
    sourceConnector: "claude-code",
    machineId: "m1",
    storedEvents: 10,
    reparsedEvents: 10,
    missing: 0,
    extra: 0,
    ok: true,
    skippedReason: null,
    ...over,
  };
}

function inputs(over: Partial<DataQualityInputs> = {}): DataQualityInputs {
  return {
    windowDays: 7,
    sinceIso: SINCE,
    sessions: [session()],
    rawTotals: { rawRows: 4, yieldedEvents: 4 },
    duplicates: { duplicateEvents: 0, distinctEvents: 10 },
    lag: [{ sessionId: "s1", sourceConnector: "claude-code", lagMs: 1000 }],
    declarations: [declaration()],
    gitLinks: [],
    captureHealth: { machines: [], declared: [], observed: [] },
    sample: [],
    recoverability: [recovered()],
    ...over,
  };
}

describe("ratioMetric — the zero-denominator rule", () => {
  it("returns unknown for a zero denominator, and specifically NOT a 1.0 ratio", () => {
    const m = ratioMetric(0, 0, "nothing to divide");
    expect(m.kind).toBe("unknown");
    // The whole slice exists to prevent the other answer. Assert its ABSENCE explicitly.
    expect(m).not.toHaveProperty("ratio");
    expect(m).not.toMatchObject({ ratio: 1 });
    if (m.kind === "unknown") expect(m.reason).toBe("nothing to divide");
  });

  it("returns a measured 0 for a real zero over a real denominator — the OPPOSITE fact", () => {
    const m = ratioMetric(0, 4000, "nothing to divide");
    expect(m).toEqual({ kind: "measured", numerator: 0, denominator: 4000, ratio: 0 });
  });

  it("marks a result sampled when a sample size is supplied", () => {
    expect(ratioMetric(9, 10, "x", 10)).toEqual({
      kind: "sampled",
      numerator: 9,
      denominator: 10,
      ratio: 0.9,
      sampleSize: 10,
    });
  });

  it("treats a negative denominator as unknown too (defensive — never divides by it)", () => {
    expect(ratioMetric(1, -1, "bad").kind).toBe("unknown");
  });
});

describe("deriveDataQualityMetrics — the §5.1 table", () => {
  it("emits every §5.1 metric and stamps both derivation versions", () => {
    const out = deriveDataQualityMetrics(inputs(), NOW);
    expect(out.dataQualityVersion).toBe(DATA_QUALITY_VERSION);
    expect(out.captureHealthVersion).toBe(CAPTURE_HEALTH_VERSION);
    expect(out.captureHealth.captureHealthVersion).toBe(CAPTURE_HEALTH_VERSION);
    expect(Object.keys(out.metrics).sort()).toEqual([
      "attributionCorrectness",
      "attributionCoverage",
      "captureCoverage",
      "duplicateRate",
      "parseSuccess",
      "recoverability",
      "syncFreshness",
      "tokenCompleteness",
    ]);
    expect(out.windowStart).toBe(SINCE);
    expect(out.windowEnd).toBe("2026-08-04T12:00:00.000Z");
  });

  it("always reports capture coverage and attribution CORRECTNESS as unknown, with a reason", () => {
    // Even with a full, healthy window: these two need ground truth that lives outside the product
    // (§4.4), so no amount of captured data can make them measurable.
    const out = deriveDataQualityMetrics(inputs(), NOW);
    for (const m of [out.metrics.captureCoverage, out.metrics.attributionCorrectness]) {
      expect(m.kind).toBe("unknown");
      if (m.kind === "unknown") {
        expect(m.reason.length).toBeGreaterThan(0);
        expect(m.reason).toMatch(/§4\.4/);
      }
    }
  });

  it("reports attribution COVERAGE as a real measured ratio — a different metric", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [
          session({ sessionId: "a", attributed: true }),
          session({ sessionId: "b", attributed: false }),
        ],
      }),
      NOW,
    );
    expect(out.metrics.attributionCoverage).toMatchObject({
      kind: "measured",
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
    });
  });

  it("renders every ratio as unknown on an empty window — never a passing zero", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [],
        rawTotals: { rawRows: 0, yieldedEvents: 0 },
        duplicates: { duplicateEvents: 0, distinctEvents: 0 },
        lag: [],
        declarations: [],
        recoverability: [],
      }),
      NOW,
    );
    for (const [name, m] of Object.entries(out.metrics)) {
      expect(m.kind, `${name} must be unknown on an empty window`).toBe("unknown");
    }
  });

  it("counts parse success on raw ROWS, so one unyielding record is 1/2 and not unknown", () => {
    const out = deriveDataQualityMetrics(
      inputs({ rawTotals: { rawRows: 2, yieldedEvents: 1 } }),
      NOW,
    );
    expect(out.metrics.parseSuccess).toMatchObject({
      kind: "measured",
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
    });
  });

  it("divides duplicates by INGESTED events (distinct + duplicate), not by distinct alone", () => {
    const out = deriveDataQualityMetrics(
      inputs({ duplicates: { duplicateEvents: 2, distinctEvents: 3 } }),
      NOW,
    );
    expect(out.metrics.duplicateRate).toMatchObject({ numerator: 2, denominator: 5 });
  });
});

describe("token completeness — three buckets, not two", () => {
  it("excludes a tokens:'none' connector from the denominator entirely", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [
          session({ sessionId: "a", sourceConnector: "claude-code", withTokens: 4 }),
          session({ sessionId: "b", sourceConnector: "gemini-cli", withTokens: 0 }),
        ],
        declarations: [
          declaration({ connectorId: "claude-code", tokens: "exact" }),
          declaration({ connectorId: "gemini-cli", tokens: "none" }),
        ],
      }),
      NOW,
    );
    expect(out.tokenEligibility).toEqual({ eligible: 1, ineligible: 1, undeclared: 0 });
    // 1/1, NOT 1/2 — a connector that genuinely cannot report tokens is not a defect.
    expect(out.metrics.tokenCompleteness).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("routes an UNDECLARED connector's sessions to a third bucket, neither eligible nor not", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ sessionId: "a", sourceConnector: "mystery-connector" })],
        declarations: [],
      }),
      NOW,
    );
    expect(out.tokenEligibility).toEqual({ eligible: 0, ineligible: 0, undeclared: 1 });
    expect(out.metrics.tokenCompleteness.kind).toBe("unknown");
    if (out.metrics.tokenCompleteness.kind === "unknown") {
      expect(out.metrics.tokenCompleteness.reason).toMatch(/no machine declares/i);
    }
  });

  it("keeps a session eligible when ANY machine declares the connector token-capable", () => {
    // The reduction that does NOT flatter the ratio: excluding it would raise the score.
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ withTokens: 0 })],
        declarations: [
          declaration({ connectorId: "claude-code", tokens: "none" }),
          declaration({ connectorId: "claude-code", tokens: "exact" }),
        ],
      }),
      NOW,
    );
    expect(out.tokenEligibility.eligible).toBe(1);
    expect(out.metrics.tokenCompleteness).toMatchObject({ numerator: 0, denominator: 1, ratio: 0 });
  });
});

describe("sync freshness", () => {
  const lag = (ms: number | null, connector = "claude-code"): IngestLagRow => ({
    sessionId: "s1",
    sourceConnector: connector,
    lagMs: ms,
  });

  it("splits fresh from stale at the threshold", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        lag: [
          lag(DATA_QUALITY_THRESHOLDS.syncFreshnessMs),
          lag(DATA_QUALITY_THRESHOLDS.syncFreshnessMs + 1),
        ],
      }),
      NOW,
    );
    expect(out.syncFreshness).toEqual({ fresh: 1, stale: 1, unknown: 0 });
  });

  it("excludes a batch connector — its liveness window is not archive-knowable", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        lag: [lag(999_999_999, "claude-export")],
        declarations: [declaration({ connectorId: "claude-export", liveness: "batch" })],
      }),
      NOW,
    );
    // NOT counted as stale — that would manufacture a failure out of a configuration choice.
    expect(out.syncFreshness).toEqual({ fresh: 0, stale: 0, unknown: 1 });
    expect(out.metrics.syncFreshness.kind).toBe("unknown");
  });

  it("excludes a session whose lag cannot be computed at all", () => {
    const out = deriveDataQualityMetrics(inputs({ lag: [lag(null)] }), NOW);
    expect(out.syncFreshness).toEqual({ fresh: 0, stale: 0, unknown: 1 });
  });
});

describe("recoverability — a sampled metric with skips excluded", () => {
  it("reports sampled, with the sample size, over the ATTEMPTED rows only", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        recoverability: [
          recovered({ sessionId: "a" }),
          recovered({ sessionId: "b", ok: false, missing: 2 }),
          recovered({ sessionId: "c", skippedReason: "gemini" }),
        ],
      }),
      NOW,
    );
    expect(out.recoverability.attempted).toBe(2);
    expect(out.recoverability.skipped.gemini).toBe(1);
    // A Gemini skip is a known scope boundary (D-M13-2), never a failure — 1/2, not 1/3.
    expect(out.metrics.recoverability).toEqual({
      kind: "sampled",
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
      sampleSize: 2,
    });
  });

  it("is unknown — not a pass — when every sampled session was skipped", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        recoverability: [
          recovered({ skippedReason: "gemini" }),
          recovered({ skippedReason: "decrypt-error" }),
        ],
      }),
      NOW,
    );
    expect(out.metrics.recoverability.kind).toBe("unknown");
    expect(out.recoverability.skipped).toEqual({
      gemini: 1,
      unsupportedConnector: 0,
      noRawRecords: 0,
      decryptError: 1,
    });
  });
});

describe("git outcome confidence (§7 P1.7)", () => {
  const links = (...rows: GitLinkageRow[]): GitLinkageRow[] => rows;

  it("counts a session with BOTH a confirmed and a suggested link once, as confirmed", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ sessionId: "a" })],
        gitLinks: links(
          { sessionId: "a", status: "suggested" },
          { sessionId: "a", status: "confirmed" },
        ),
      }),
      NOW,
    );
    expect(out.gitConfidence).toEqual({ confirmed: 1, heuristic: 0, none: 0, sessions: 1 });
  });

  it("does not let a later suggestion demote a confirmed session", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ sessionId: "a" })],
        gitLinks: links(
          { sessionId: "a", status: "confirmed" },
          { sessionId: "a", status: "suggested" },
        ),
      }),
      NOW,
    );
    expect(out.gitConfidence.confirmed).toBe(1);
    expect(out.gitConfidence.heuristic).toBe(0);
  });

  it("counts a rejected-only session as NO linkage, not heuristic", () => {
    // A human looked and said no. That is the opposite of a weak signal, not a version of one.
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ sessionId: "a" })],
        gitLinks: links({ sessionId: "a", status: "rejected" }),
      }),
      NOW,
    );
    expect(out.gitConfidence).toEqual({ confirmed: 0, heuristic: 0, none: 1, sessions: 1 });
  });

  it("ignores a link to a session outside the window", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [session({ sessionId: "a" })],
        gitLinks: links({ sessionId: "outside", status: "confirmed" }),
      }),
      NOW,
    );
    expect(out.gitConfidence).toEqual({ confirmed: 0, heuristic: 0, none: 1, sessions: 1 });
  });

  it("counts DISTINCT session ids, so one session on two connectors is one row", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        sessions: [
          session({ sessionId: "a", sourceConnector: "claude-code" }),
          session({ sessionId: "a", sourceConnector: "codex-cli" }),
        ],
        declarations: [
          declaration({ connectorId: "claude-code" }),
          declaration({ connectorId: "codex-cli" }),
        ],
      }),
      NOW,
    );
    expect(out.sessionsInWindow).toBe(2);
    expect(out.distinctSessions).toBe(1);
    expect(out.gitConfidence.sessions).toBe(1);
  });
});

describe("capture-health roll-up (D-16.4-2)", () => {
  it("counts CAPTURE_HEALTH_VERDICT buckets from deriveCaptureHealth, not a second derivation", () => {
    const out = deriveDataQualityMetrics(
      inputs({
        captureHealth: {
          machines: [{ id: "m1", name: "laptop", status: "online" }],
          declared: [
            // healthy → capturing
            {
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
              requiredPermissions: [],
              custom: false,
              lastErrorMessage: null,
              lastErrorAt: null,
              errorCount: 0,
              reportedAt: "2026-08-04T11:59:00.000Z",
              lastEventAt: "2026-08-04T11:00:00.000Z",
              eventCount: 12,
              parserVersions: ["claude-code@1"],
            },
            // disabled → not-capturing
            {
              machineId: "m1",
              connectorId: "codex-cli",
              enabled: false,
              approval: "approved",
              status: "stable",
              captureMethod: "rollout tail",
              liveness: "streaming",
              tokens: "estimated",
              cost: "computed",
              knownGaps: [],
              requiredPermissions: [],
              custom: false,
              lastErrorMessage: null,
              lastErrorAt: null,
              errorCount: 0,
              reportedAt: "2026-08-04T11:59:00.000Z",
              lastEventAt: null,
              eventCount: 0,
              parserVersions: [],
            },
          ],
          // observed-but-undeclared → unreported → unknown
          observed: [
            {
              machineId: "m1",
              connectorId: "mystery",
              lastEventAt: "2026-08-04T11:00:00.000Z",
              eventCount: 3,
              parserVersions: ["mystery@1"],
            },
          ],
        },
      }),
      NOW,
    );
    expect(out.captureHealth.verdicts).toEqual({
      capturing: 1,
      "not-capturing": 1,
      broken: 0,
      unknown: 1,
    });
    expect(out.captureHealth.rows).toHaveLength(3);
  });
});
