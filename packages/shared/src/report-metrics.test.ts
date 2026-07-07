import { describe, it, expect } from "vitest";
import {
  alignFailureRateSeries,
  classifyContextPath,
  contextWasteRecommendations,
  detectAnomalies,
  zeroContextWasteCounts,
  emptyContextWastePaths,
  CONTEXT_WASTE_CLASSES,
  type AnomalySeriesPoint,
  type FailureSeriesRow,
} from "./report-metrics.js";

describe("classifyContextPath (§17 taxonomy)", () => {
  it("classifies each of the 6 waste classes", () => {
    expect(classifyContextPath("package-lock.json")).toBe("lockfile");
    expect(classifyContextPath("/repo/yarn.lock")).toBe("lockfile");
    expect(classifyContextPath("C:\\repo\\Cargo.lock")).toBe("lockfile");
    expect(classifyContextPath("node_modules/foo/index.js")).toBe("dependency-dir");
    expect(classifyContextPath("/repo/vendor/bundle/gem.rb")).toBe("dependency-dir");
    expect(classifyContextPath("C:\\repo\\.venv\\lib\\site-packages\\x.py")).toBe("dependency-dir");
    expect(classifyContextPath("/repo/dist/bundle.js")).toBe("build-output");
    expect(classifyContextPath("/repo/.next/server/app.js")).toBe("build-output");
    expect(classifyContextPath("/repo/src/app.min.js")).toBe("generated");
    expect(classifyContextPath("/repo/src/app.js.map")).toBe("generated");
    expect(classifyContextPath("/repo/types/index.d.ts")).toBe("generated");
    expect(classifyContextPath("/var/log/app.log")).toBe("log");
    expect(classifyContextPath("/repo/assets/logo.png")).toBe("binary-or-large");
    expect(classifyContextPath("/repo/release/app.exe")).toBe("binary-or-large");
  });

  it("returns null for an ordinary source path (no waste signal)", () => {
    expect(classifyContextPath("/repo/src/index.ts")).toBeNull();
    expect(classifyContextPath("README.md")).toBeNull();
  });

  it("returns null for an empty path (defensive)", () => {
    expect(classifyContextPath("")).toBeNull();
  });

  it("a lockfile INSIDE a dependency dir still classifies as lockfile (basename wins)", () => {
    // Precedence follows the PRD §17 category order — lockfile checked before dependency-dir.
    expect(classifyContextPath("/repo/node_modules/some-pkg/package-lock.json")).toBe("lockfile");
  });

  it("a generated-looking file INSIDE a build-output dir classifies as build-output (structural wins)", () => {
    // Precedence follows the PRD §17 category order — build-output (structural) is
    // checked before generated (extension-only), so /dist/*.map reads as build-output.
    expect(classifyContextPath("/repo/dist/app.js.map")).toBe("build-output");
  });

  it("is case-insensitive on both directory segments and extensions", () => {
    expect(classifyContextPath("/repo/NODE_MODULES/foo.js")).toBe("dependency-dir");
    expect(classifyContextPath("/repo/IMAGE.PNG")).toBe("binary-or-large");
  });
});

describe("contextWasteRecommendations", () => {
  it("omits classes with zero hits and ranks the rest most-offending-first", () => {
    const byClass = zeroContextWasteCounts();
    byClass["dependency-dir"] = 12;
    byClass.log = 3;
    const topPaths = emptyContextWastePaths();
    topPaths["dependency-dir"] = ["node_modules/a", "node_modules/b"];
    topPaths.log = ["app.log"];

    const recs = contextWasteRecommendations(byClass, topPaths);
    expect(recs.map((r) => r.class)).toEqual(["dependency-dir", "log"]);
    expect(recs[0]!.count).toBe(12);
    expect(recs[0]!.examplePaths).toEqual(["node_modules/a", "node_modules/b"]);
  });

  it("returns an empty list when every class is clean (an honest all-good report)", () => {
    expect(contextWasteRecommendations(zeroContextWasteCounts(), emptyContextWastePaths())).toEqual(
      [],
    );
  });

  it("CONTEXT_WASTE_CLASSES has exactly the 6 documented classes", () => {
    expect(CONTEXT_WASTE_CLASSES).toEqual([
      "lockfile",
      "dependency-dir",
      "build-output",
      "generated",
      "log",
      "binary-or-large",
    ]);
  });
});

describe("detectAnomalies (rolling z-score)", () => {
  function series(values: number[]): AnomalySeriesPoint[] {
    return values.map((value, i) => ({ bucket: `b${i}`, value }));
  }

  it("flags nothing with fewer than windowSize+1 points (needs history first)", () => {
    expect(detectAnomalies(series([1, 1, 1, 1]))).toEqual([]);
    expect(detectAnomalies(series([1, 1, 1]))).toEqual([]);
    expect(detectAnomalies([])).toEqual([]);
  });

  it("flags no anomalies over a stable series", () => {
    expect(detectAnomalies(series([10, 10, 10, 10, 10, 10, 10]))).toEqual([]);
  });

  it("flags a clear spike relative to trailing history", () => {
    const flags = detectAnomalies(series([10, 10, 10, 10, 100]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.bucket).toBe("b4");
    expect(flags[0]!.value).toBe(100);
    expect(flags[0]!.direction).toBe("spike");
    expect(flags[0]!.zScore).toBeGreaterThanOrEqual(2);
  });

  it("flags a clear drop relative to trailing history", () => {
    const flags = detectAnomalies(series([10, 10, 10, 10, 0]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.direction).toBe("drop");
    expect(flags[0]!.zScore).toBeLessThanOrEqual(-2);
  });

  it("does not flag a point within the window used to score it (only later points can be flagged)", () => {
    // The spike at index 4 becomes part of history for index 5+ — it is not re-flagged twice,
    // and a single one-off spike does not retroactively flag its own trailing window.
    const flags = detectAnomalies(series([10, 10, 10, 10, 100, 10, 10, 10, 10]));
    expect(flags.map((f) => f.bucket)).toEqual(["b4"]);
  });

  it("skips a zero-variance window instead of throwing/producing Infinity", () => {
    const flags = detectAnomalies(series([5, 5, 5, 5, 5, 5]));
    expect(flags).toEqual([]);
  });

  it("respects custom windowSize/zThreshold options", () => {
    const flags = detectAnomalies(series([10, 10, 12]), { windowSize: 2, zThreshold: 1 });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.bucket).toBe("b2");
  });
});

describe("alignFailureRateSeries", () => {
  function row(bucket: string, toolCalls: number, toolsFailed: number): FailureSeriesRow {
    return { bucket, toolCalls, toolsFailed, sessions: 1 };
  }

  it("fills a gap bucket (present in reference, absent from series) with a 0 rate", () => {
    const reference = [{ bucket: "d1" }, { bucket: "d2" }, { bucket: "d3" }];
    // d2 had zero terminal tool calls → `failureSeries` (report-projections.ts) omits it entirely.
    const series = [row("d1", 4, 2), row("d3", 2, 2)];
    expect(alignFailureRateSeries(reference, series)).toEqual([
      { bucket: "d1", value: 0.5 },
      { bucket: "d2", value: 0 },
      { bucket: "d3", value: 1 },
    ]);
  });

  it("a bucket with terminal tool calls but zero failures aligns to a 0 rate (not absent)", () => {
    const reference = [{ bucket: "d1" }];
    expect(alignFailureRateSeries(reference, [row("d1", 5, 0)])).toEqual([
      { bucket: "d1", value: 0 },
    ]);
  });

  it("composes with detectAnomalies to correctly surface an anomaly across a quiet gap (the bug this fixes)", () => {
    // Without gap-filling, the 4 quiet days (0, 1, 2, 3) would sit directly beside the
    // spike (5) with day 4's true quiet gap silently dropped from the window — this
    // wouldn't have changed THIS particular result, but a differently-shaped gap could
    // shift which points end up adjacent. Gap-filling makes the window's "last 4
    // calendar buckets" claim actually true, regardless of gap position/shape.
    const reference = Array.from({ length: 6 }, (_, i) => ({ bucket: `d${i}` }));
    const series = [
      row("d0", 4, 0),
      row("d1", 4, 0),
      row("d2", 4, 0),
      row("d3", 4, 0),
      // d4: a quiet day with zero terminal tool calls — omitted from `failureSeries`.
      row("d5", 4, 4),
    ];
    const aligned = alignFailureRateSeries(reference, series);
    expect(aligned.map((p) => p.value)).toEqual([0, 0, 0, 0, 0, 1]);
    const flags = detectAnomalies(aligned);
    expect(flags.map((f) => f.bucket)).toEqual(["d5"]);
  });
});
