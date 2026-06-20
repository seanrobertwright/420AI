/**
 * The report-compare seam (M12 12.2b). `ReportArtifactRow.metrics` is `unknown` and its shape
 * VARIES by `reportType` (cost-over-time vs autopsy vs AI interpretation), so this is a pure,
 * defensive, shallow numeric-leaf diff — it never assumes a shape. Non-object inputs degrade to
 * `[]` (the compare view then falls back to markdown-only, no crash). A typed per-reportType
 * diff is deferred (NOTES). Pure + clock-free → unit-tested in `metrics-diff.test.ts`.
 */

export interface MetricDelta {
  key: string;
  a: number | null;
  b: number | null;
  delta: number | null;
}

/** Shallow numeric-leaf diff of two report `metrics` blobs. */
export function diffMetrics(a: unknown, b: unknown): MetricDelta[] {
  const oa = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const ob = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort();
  return keys
    .map((key) => {
      const av = typeof oa[key] === "number" ? (oa[key] as number) : null;
      const bv = typeof ob[key] === "number" ? (ob[key] as number) : null;
      return { key, a: av, b: bv, delta: av !== null && bv !== null ? bv - av : null };
    })
    .filter((d) => d.a !== null || d.b !== null);
}
