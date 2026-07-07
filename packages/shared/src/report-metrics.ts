import type { NormalizedTokens } from "./tokens.js";
import type { GitCommitRow } from "./git.js";
import type { SessionProjection, UsageOverTimeRow, UsageTotals } from "./projections.js";

/**
 * M13 13.2 report-metrics: pure types + pure helpers for the five new project
 * report types (PRD §15) + the §17 context-governance recommendation list.
 * Same discipline as `alerts.ts`'s derive family: pure, clock-free, no I/O,
 * `@420ai/shared` stays dependency-free. `detectAnomalies`/`classifyContextPath`/
 * `contextWasteRecommendations` are exercised directly by unit tests; the *Input
 * types are what the `@420ai/shared` renderers (reports.ts) and the
 * `apps/ingest` orchestrators (generate-report-m13.ts) share as their contract.
 */

// --- Tool/model comparison (PRD §14 "tool/model comparison") ---------------

/** One model's aggregate tool/token/cost/session footprint on a project. */
export interface ToolModelComparisonRow {
  model: string | null;
  tokens: NormalizedTokens;
  costUsd: number;
  toolCalls: number; // terminal outcomes only (completed+failed) — mirrors ConnectorHealthRow.toolCalls
  toolsCompleted: number;
  toolsFailed: number;
  sessions: number;
  firstSeen: string | null; // ISO
  lastSeen: string | null; // ISO
}

export interface ToolModelComparisonInput {
  projectName: string;
  generatedAt: string; // ISO — injected by the caller (clock-free renderer)
  rows: ToolModelComparisonRow[];
}

// --- Failed tool calls (PRD §14 tool-call-failure classes) -----------------

/**
 * Decrypt-bearing classification of `tool.call.failed` payloads (D-M13-1). `byClass`
 * keys on the connector's own `failureClass` string when present (Codex: "environment"
 * | "state-mismatch" | "tool-runtime"), else "unclassified" (Claude does not emit one —
 * "label honestly"). `byTool` names are `redact()`-ed before ever reaching a renderer.
 */
export interface FailedToolBreakdown {
  byClass: Record<string, number>;
  byTool: { tool: string; count: number }[];
  coverage: { classified: number; total: number };
}

/** One time bucket of tool-call outcomes (failed-tool-calls trend + trend-anomalies input). */
export interface FailureSeriesRow {
  bucket: string; // ISO
  toolCalls: number; // toolsCompleted + toolsFailed (terminal outcomes)
  toolsFailed: number;
  sessions: number;
}

export interface FailedToolReportInput {
  projectName: string;
  generatedAt: string;
  bucket: "day" | "week";
  breakdown: FailedToolBreakdown;
  series: FailureSeriesRow[];
}

// --- Context waste / §17 context governance ---------------------------------

/**
 * The §17 ignore-recommendation taxonomy — a closed set of 6 pure, path-derived
 * classes. "repeated duplicated context" (the PRD's 7th category) is NOT a class
 * here: it requires cross-record duplicate detection, not single-path
 * classification, and is out of scope for this pure classifier.
 */
export const CONTEXT_WASTE_CLASSES = [
  "lockfile",
  "dependency-dir",
  "build-output",
  "generated",
  "log",
  "binary-or-large",
] as const;

export type ContextWasteClass = (typeof CONTEXT_WASTE_CLASSES)[number];

/** A zeroed per-class counter map — the additive identity `contextPathSample` starts from. */
export function zeroContextWasteCounts(): Record<ContextWasteClass, number> {
  return Object.fromEntries(CONTEXT_WASTE_CLASSES.map((c) => [c, 0])) as Record<
    ContextWasteClass,
    number
  >;
}

/** A zeroed per-class example-paths map. */
export function emptyContextWastePaths(): Record<ContextWasteClass, string[]> {
  return Object.fromEntries(CONTEXT_WASTE_CLASSES.map((c) => [c, [] as string[]])) as Record<
    ContextWasteClass,
    string[]
  >;
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
]);
const DEPENDENCY_DIR_SEGMENTS = ["/node_modules/", "/vendor/", "/.venv/", "/target/"];
const BUILD_OUTPUT_SEGMENTS = ["/dist/", "/build/", "/.next/", "/out/"];
const GENERATED_EXTENSIONS = [".min.js", ".map", ".d.ts"];
const LOG_EXTENSIONS = [".log"];
const BINARY_OR_LARGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mov",
  ".avi",
  ".mp3",
  ".wav",
];

/** Windows AND POSIX separators — a decrypted payload path may carry either. */
function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function basename(normalizedPath: string): string {
  const idx = normalizedPath.lastIndexOf("/");
  return idx >= 0 ? normalizedPath.slice(idx + 1) : normalizedPath;
}

function hasExtension(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

/**
 * Classify a file path into a §17 ignore-recommendation class, or `null` if it is
 * fine (no waste signal). Pure, deterministic, clock-free. Precedence — most
 * specific structural signal first, extension checks last — matches the PRD §17
 * category order: lockfile → dependency-dir → build-output → generated → log →
 * binary-or-large.
 */
export function classifyContextPath(path: string): ContextWasteClass | null {
  if (!path) return null;
  const normalized = normalizeSlashes(path);
  // Pad with a leading slash so a segment check matches BOTH a path rooted at the
  // segment ("node_modules/foo.js") and one nested under it ("a/node_modules/foo.js").
  const padded = ("/" + normalized).toLowerCase();
  const base = basename(normalized);
  const baseLower = base.toLowerCase();

  if (LOCKFILE_NAMES.has(baseLower)) return "lockfile";
  if (DEPENDENCY_DIR_SEGMENTS.some((seg) => padded.includes(seg))) return "dependency-dir";
  if (BUILD_OUTPUT_SEGMENTS.some((seg) => padded.includes(seg))) return "build-output";
  if (hasExtension(base, GENERATED_EXTENSIONS)) return "generated";
  if (hasExtension(base, LOG_EXTENSIONS)) return "log";
  if (hasExtension(base, BINARY_OR_LARGE_EXTENSIONS)) return "binary-or-large";
  return null;
}

export interface ContextWasteRecommendation {
  class: ContextWasteClass;
  count: number;
  recommendation: string;
  examplePaths: string[];
}

const RECOMMENDATION_TEXT: Record<ContextWasteClass, string> = {
  lockfile:
    "Add lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, …) to your tool's ignore/context-exclude list — they are large, machine-generated, and rarely relevant to a coding task.",
  "dependency-dir":
    "Add dependency directories (node_modules/, vendor/, .venv/, target/) to your ignore list — third-party code should not be re-read into context.",
  "build-output":
    "Add build output directories (dist/, build/, .next/, out/) to your ignore list — compiled artifacts add no value as context.",
  generated:
    "Add generated files (*.min.js, *.map, *.d.ts) to your ignore list — they are derived from source already in context.",
  log: "Add log files (*.log) to your ignore list — logs are typically noisy and rarely needed for coding tasks.",
  "binary-or-large":
    "Exclude binary/large artifacts (images, archives, executables, fonts, media) from context — they cannot be usefully read as text.",
};

/**
 * The deterministic §17 deliverable: turn classified path counts into a
 * project-specific, ranked (most-offending-first) ignore-recommendation list.
 * A class with zero hits is omitted — the recommendation is honest about what
 * THIS project actually shows, not a boilerplate checklist.
 */
export function contextWasteRecommendations(
  byClass: Record<ContextWasteClass, number>,
  topPaths: Record<ContextWasteClass, string[]>,
): ContextWasteRecommendation[] {
  return CONTEXT_WASTE_CLASSES.filter((c) => byClass[c] > 0)
    .map((c) => ({
      class: c,
      count: byClass[c],
      recommendation: RECOMMENDATION_TEXT[c],
      examplePaths: topPaths[c],
    }))
    .sort((a, b) => b.count - a.count);
}

export interface ContextWasteInput {
  projectName: string;
  generatedAt: string;
  byClass: Record<ContextWasteClass, number>;
  topPaths: Record<ContextWasteClass, string[]>;
  recommendations: ContextWasteRecommendation[];
  /** Per-connector, per-event-type counts — the honest coverage table (D-M13-2). */
  coverage: { sourceConnector: string; eventType: string; count: number }[];
}

// --- Project efficiency (PRD §14 outcome proxies / rework signals) ---------

export interface EfficiencyInput {
  projectName: string;
  generatedAt: string;
  totals: UsageTotals;
  sessions: SessionProjection[];
  commits: GitCommitRow[];
}

// --- Trend anomalies ---------------------------------------------------------

/** One point of a named metric series, in bucket order. */
export interface AnomalySeriesPoint {
  bucket: string; // ISO
  value: number;
}

export interface AnomalyFlag {
  bucket: string;
  value: number;
  zScore: number;
  direction: "spike" | "drop";
}

export interface DetectAnomaliesOptions {
  /** Trailing buckets used to compute the rolling mean/stddev. Default 4. */
  windowSize?: number;
  /** |z| at or above this threshold is flagged. Default 2. */
  zThreshold?: number;
}

/**
 * A perfectly flat trailing window (stddev 0) is the common case for a quiet
 * project (e.g. 4 zero-failure days) — substituting a tiny epsilon instead of
 * skipping the window means a genuine change off a flat baseline (0 → any
 * nonzero value) still scores as a huge, finite z rather than being silently
 * ignored, while an UNCHANGED point (value === mean) still scores exactly 0.
 */
const ZERO_VARIANCE_EPSILON = 1e-9;

/**
 * Pure rolling z-score anomaly detector. For each point at index `i >= windowSize`,
 * compares it against the mean/stddev of the `windowSize` points immediately
 * before it (NOT including itself — a genuine "does this look different from
 * recent history" test). Requires at least `windowSize` points of history before
 * the first point can be flagged, so a series shorter than `windowSize + 1` never
 * flags anything. Deterministic, clock-free.
 */
export function detectAnomalies(
  series: AnomalySeriesPoint[],
  opts: DetectAnomaliesOptions = {},
): AnomalyFlag[] {
  const windowSize = opts.windowSize ?? 4;
  const zThreshold = opts.zThreshold ?? 2;
  const flags: AnomalyFlag[] = [];
  if (series.length <= windowSize) return flags;

  for (let i = windowSize; i < series.length; i++) {
    const window = series.slice(i - windowSize, i);
    const mean = window.reduce((sum, p) => sum + p.value, 0) / window.length;
    const variance = window.reduce((sum, p) => sum + (p.value - mean) ** 2, 0) / window.length;
    const stddev = Math.sqrt(variance) || ZERO_VARIANCE_EPSILON;

    const point = series[i]!;
    const zScore = (point.value - mean) / stddev;
    if (Math.abs(zScore) >= zThreshold) {
      flags.push({
        bucket: point.bucket,
        value: point.value,
        zScore,
        direction: zScore > 0 ? "spike" : "drop",
      });
    }
  }
  return flags;
}

/**
 * Reindex a failure series onto a reference bucket set (the cost series is the
 * natural choice — it is a superset, grouping over ALL event types rather than
 * just terminal tool calls). `failureSeries` OMITS a bucket entirely when it had
 * zero terminal tool calls, so building a rate series from its rows directly
 * would silently treat two non-adjacent calendar buckets as neighbors in
 * `detectAnomalies`'s rolling window. A reference bucket missing from `series`
 * contributes a genuine 0 rate instead of a gap.
 */
export function alignFailureRateSeries(
  referenceBuckets: { bucket: string }[],
  series: FailureSeriesRow[],
): AnomalySeriesPoint[] {
  const byBucket = new Map(series.map((r) => [r.bucket, r]));
  return referenceBuckets.map((r) => {
    const f = byBucket.get(r.bucket);
    return { bucket: r.bucket, value: f && f.toolCalls > 0 ? f.toolsFailed / f.toolCalls : 0 };
  });
}

export interface TrendAnomaliesInput {
  projectName: string;
  generatedAt: string;
  bucket: "day" | "week";
  costSeries: UsageOverTimeRow[];
  costAnomalies: AnomalyFlag[];
  failureSeries: FailureSeriesRow[];
  failureAnomalies: AnomalyFlag[];
}
