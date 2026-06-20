import { describe, it, expect } from "vitest";
import { diffMetrics } from "./metrics-diff.js";

describe("diffMetrics", () => {
  it("computes a numeric delta for shared keys", () => {
    expect(diffMetrics({ costUsd: 1, tokens: 100 }, { costUsd: 1.5, tokens: 80 })).toEqual([
      { key: "costUsd", a: 1, b: 1.5, delta: 0.5 },
      { key: "tokens", a: 100, b: 80, delta: -20 },
    ]);
  });

  it("returns sorted keys (union of both blobs)", () => {
    const out = diffMetrics({ b: 2, a: 1 }, { c: 3 });
    expect(out.map((d) => d.key)).toEqual(["a", "b", "c"]);
  });

  it("leaves delta null when a key is present on only one side", () => {
    expect(diffMetrics({ only_a: 5 }, { only_b: 9 })).toEqual([
      { key: "only_a", a: 5, b: null, delta: null },
      { key: "only_b", a: null, b: 9, delta: null },
    ]);
  });

  it("drops non-numeric leaves (both sides null → filtered out)", () => {
    expect(diffMetrics({ label: "x", costUsd: 2 }, { label: "y", costUsd: 2 })).toEqual([
      { key: "costUsd", a: 2, b: 2, delta: 0 },
    ]);
  });

  it("treats a non-numeric value on one side as null (no NaN delta)", () => {
    expect(diffMetrics({ n: 10 }, { n: "ten" })).toEqual([
      { key: "n", a: 10, b: null, delta: null },
    ]);
  });

  it("degrades to [] for non-object metrics (null / undefined / primitive / array-empty)", () => {
    expect(diffMetrics(null, undefined)).toEqual([]);
    expect(diffMetrics(42, "x")).toEqual([]);
    expect(diffMetrics(undefined, undefined)).toEqual([]);
  });

  it("ignores NaN-producing combos by leaving delta null only when a side is non-numeric", () => {
    // both numeric → real delta even if one is 0
    expect(diffMetrics({ x: 0 }, { x: 0 })).toEqual([{ key: "x", a: 0, b: 0, delta: 0 }]);
  });
});
