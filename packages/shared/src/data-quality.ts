import type {
  CaptureHealthInputs,
  CaptureHealthRow,
  CaptureHealthVerdict,
} from "./capture-health.js";
import { CAPTURE_HEALTH_VERSION, deriveCaptureHealth, isLiveCapture } from "./capture-health.js";
import type { ConnectorCatalogLiveness } from "./connector-catalog.js";
import type { ConnectorInfo } from "./control-protocol.js";
import type { CostConfidence } from "./cost.js";

/**
 * M16 16.4 — the §5.1 data-quality metric table, derived (research plan §7 P0.3 + P1.7).
 *
 * THE ORGANISING PRINCIPLE IS ONE SENTENCE FROM §5.1, AND IT IS THE WHOLE DESIGN CONSTRAINT:
 * "Record unknown values explicitly. Do not substitute zero for absent data."
 *
 * That rule exists because the archive's own numbers cannot see their own denominator. Every
 * existing projection (`connectorHealth`, `usageTotals`, `projectEventSummary`) aggregates WHAT
 * ARRIVED — a session that was never captured contributes to none of them — so eyeballing them
 * yields a coverage figure that is 100% by construction. This module is the instrument that grades
 * the capture pipeline, and the same operator built both (the milestone's Risk 2), so its
 * mitigation has to be structural rather than careful: a metric that cannot be measured must SAY SO.
 *
 * Pure + clock-injected, exactly like `capture-health.ts`: `@420ai/shared` stays dependency-free and
 * never reads the wall clock, so every classification below is unit-testable with no database and
 * the CALLER (the ingest route) owns `now`.
 */

/** Stamps the derivation shape so a stored artifact records which logic produced it (PRD §23). */
export const DATA_QUALITY_VERSION = "m16-data-quality-v1";

/**
 * A metric is NEVER a bare number.
 *
 * The failure this union prevents is not hypothetical — it is 16.3's healthy-looking zero, one
 * layer up. `0 parse failures / 0 raw records` and `0 / 4000` are OPPOSITE FACTS, and a bare
 * `ratio` renders both as "100% ✅". One of them means the pipeline is perfect; the other means it
 * captured nothing at all.
 */
export type MetricValue =
  /** A real ratio over a real, non-zero denominator across the whole window. */
  | { kind: "measured"; numerator: number; denominator: number; ratio: number }
  /** A real ratio, but over a bounded SAMPLE. `sampleSize` is rendered on the row. */
  | { kind: "sampled"; numerator: number; denominator: number; ratio: number; sampleSize: number }
  /** Not derivable from the archive. `reason` is rendered verbatim — never blank, never "0". */
  | { kind: "unknown"; reason: string };

/**
 * The ONLY constructor for a ratio metric.
 *
 * A zero denominator yields `unknown`, not a 100% pass. This is the single most important line in
 * the module, and it is the reason the two-line arithmetic is not simply inlined at its seven call
 * sites: inlined, one of them eventually gets written as `d === 0 ? 1 : n / d` and the honesty rule
 * becomes a habit instead of a property.
 *
 * Passing `sampleSize` marks the result `sampled` — a ratio over a bounded selection rather than
 * over the window. The renderer prints `sampled (n=N)` so a reader never mistakes the two.
 */
export function ratioMetric(
  numerator: number,
  denominator: number,
  emptyReason: string,
  sampleSize?: number,
): MetricValue {
  if (denominator <= 0) return { kind: "unknown", reason: emptyReason };
  const ratio = numerator / denominator;
  return sampleSize === undefined
    ? { kind: "measured", numerator, denominator, ratio }
    : { kind: "sampled", numerator, denominator, ratio, sampleSize };
}

/**
 * Thresholds this derivation applies, named so they are arguable rather than magic.
 */
export const DATA_QUALITY_THRESHOLDS = {
  /**
   * §5.1's sync freshness is "sessions visible in archive within agreed connector liveness window".
   * One hour is the window for a LIVE-CAPTURE connector, which is the only kind D-M16-1 puts in the
   * Phase 1 observation set (Claude Code + Codex CLI, both streaming/near-real-time). The collector
   * tails and syncs continuously, so an hour is generous against its real cadence while absorbing a
   * closed laptop over lunch.
   *
   * A batch/snapshot connector has NO archive-knowable window — its "agreed liveness" is "whenever
   * the operator drops an export file in", which may be never. Those sessions are NOT measured
   * against this number; they go to the `unknown` bucket, because scoring them against a live
   * connector's window would manufacture a failure out of a configuration choice.
   */
  syncFreshnessMs: 60 * 60 * 1000, // 1 hour
} as const;

// --- Inputs (what the repositories return) --------------------------------

/**
 * One (session, connector) group inside the window.
 *
 * THE UNIT IS THE PAIR, NOT THE SESSION ID. `session_id` is a connector-supplied, globally-scoped
 * string (15.1/15.2) — grouping on it alone merges a collision between two connectors and forces an
 * aggregate over the connector, which is the 15.1 `min(org_id)` smell one column over.
 */
export interface SessionQualityRow {
  sessionId: string;
  sourceConnector: string;
  /** Events stored for this pair inside the window. */
  eventCount: number;
  /** Events carrying BOTH `tokens` and `model` — §5.1's "usable model + token data". */
  withTokens: number;
  /** True when `project_path` resolves to a `workspace_keys` row owned by THIS org. */
  attributed: boolean;
  firstTs: string | null;
  lastTs: string | null;
}

/** Parse success, counted on raw ROWS (never a join — a join double-counts, spike S1). */
export interface RawRecordTotals {
  /** Raw records ingested inside the window. */
  rawRows: number;
  /** Of those, how many produced at least one stored event. */
  yieldedEvents: number;
}

/** Duplicate rate, measured on `raw_source_records` — the only layer where duplicates survive. */
export interface DuplicateTotals {
  /** Collapsed duplicate events: Σ (copies − 1) × events-per-record. */
  duplicateEvents: number;
  /** Events from the distinct raw records — the other half of "ingested events". */
  distinctEvents: number;
}

/** Per (session, connector): how long after the last event the last raw record landed. */
export interface IngestLagRow {
  sessionId: string;
  sourceConnector: string;
  /**
   * Milliseconds between the session's last event timestamp and its last raw ingest. Null when
   * either end is missing — an unmeasurable lag, never a zero one.
   */
  lagMs: number | null;
}

/**
 * One machine's DECLARATION of a connector's fidelity (`machine_connectors`), reduced to the two
 * fields this module judges on. Several machines may declare the same connector; the reduction
 * rules are in `summarizeDeclarations` and both of them deliberately keep sessions IN a denominator.
 */
export interface ConnectorDeclarationRow {
  connectorId: string;
  tokens: ConnectorInfo["tokens"];
  liveness: ConnectorCatalogLiveness;
}

/** One distinct (session, git-link status) pair. The bucketing decision is made below, in TS. */
export interface GitLinkageRow {
  sessionId: string;
  /** `suggested` | `confirmed` | `rejected` (schema.ts:786 — free text, so treated as such). */
  status: string;
}

/**
 * One deterministically-sampled session for the §4.4 reconciliation worksheet, with the four
 * archive-answerable checks pre-filled. Checks 1 (tool-native session exists) and 4 (attribution is
 * CORRECT) have no archive answer at all and are left to the human.
 */
export interface ReconciliationSampleRow {
  sessionId: string;
  sourceConnector: string;
  machineId: string | null;
  /** §4.4 check 2 — a raw record exists. */
  rawRecordCount: number;
  /** §4.4 check 3 — normalized events + token data are plausible. */
  eventCount: number;
  eventsWithTokens: number;
  models: string[];
  /** §4.4 check 5 — the cost figures carry a confidence label that explains them. */
  costConfidences: CostConfidence[];
  /** §4.4 check 6 — the session is visible in the search surface. */
  indexed: boolean;
  projectPath: string | null;
  /** Attribution COVERAGE only. Whether it is the RIGHT project is check 4, and human-only. */
  attributed: boolean;
  firstTs: string | null;
  lastTs: string | null;
}

/**
 * One dry-run re-parse result. `missing`/`extra` compare FINGERPRINT SETS, which is the strongest
 * available claim: the fingerprint is the dedup/idempotency key (PRD §12/§23), so reproducing the
 * same set proves the derived layer is fully re-derivable from the sacred raw records.
 */
export interface RecoverabilityRow {
  sessionId: string;
  sourceConnector: string;
  machineId: string;
  storedEvents: number;
  reparsedEvents: number;
  /** Stored but not reproduced — the failure that matters. */
  missing: number;
  /** Reproduced but not stored — a parser-drift signal. */
  extra: number;
  ok: boolean;
  /**
   * Non-null ⇒ this row was NOT attempted and is excluded from the ratio entirely. Never counted
   * as a failure (that would be a fabricated defect) and never silently dropped (that would
   * inflate the ratio).
   *
   * `no-raw-records` is its own reason rather than being folded into `unsupported-connector`, even
   * though it is unreachable by construction today (targets are selected FROM `raw_source_records`,
   * so a race is the only way to get there). Reusing a neighbouring label would put a wrong
   * explanation on the worksheet row, which is the one failure mode this whole module exists to
   * prevent — an honest "cannot tell" beats a tidy but false one.
   */
  skippedReason: "gemini" | "unsupported-connector" | "no-raw-records" | "decrypt-error" | null;
}

export interface DataQualityInputs {
  windowDays: number;
  /** ISO lower bound of the window (inclusive), as passed to every repository read. */
  sinceIso: string;
  sessions: SessionQualityRow[];
  rawTotals: RawRecordTotals;
  duplicates: DuplicateTotals;
  lag: IngestLagRow[];
  declarations: ConnectorDeclarationRow[];
  gitLinks: GitLinkageRow[];
  /** 16.3's inputs, passed through so THIS module calls `deriveCaptureHealth` (D-16.4-2). */
  captureHealth: CaptureHealthInputs;
  sample: ReconciliationSampleRow[];
  recoverability: RecoverabilityRow[];
}

// --- Output ---------------------------------------------------------------

/** The seven §5.1 rows, plus the two that §5.1's single "Project attribution" row conflates. */
export interface DataQualityMetricTable {
  captureCoverage: MetricValue;
  attributionCoverage: MetricValue;
  attributionCorrectness: MetricValue;
  tokenCompleteness: MetricValue;
  parseSuccess: MetricValue;
  duplicateRate: MetricValue;
  syncFreshness: MetricValue;
  recoverability: MetricValue;
}

export interface TokenEligibilityCounts {
  /** Sessions on a connector some machine declares with `tokens !== "none"`. IN the denominator. */
  eligible: number;
  /** Sessions on a connector every declaring machine reports as `tokens:"none"`. EXCLUDED. */
  ineligible: number;
  /** Sessions on a connector NOTHING declares (a pre-16.3 collector). Neither — `unknown`. */
  undeclared: number;
}

export interface SyncFreshnessCounts {
  fresh: number;
  stale: number;
  /** No computable lag, or a connector whose liveness window the archive cannot know. */
  unknown: number;
}

export interface GitConfidenceCounts {
  /** A human confirmed the link. Evidence. */
  confirmed: number;
  /** A `suggested` link and nothing stronger. A CORRELATION, not causation (§7 P1.7). */
  heuristic: number;
  /** No link, or only rejected ones. */
  none: number;
  /** Distinct sessions in the window — the denominator the three buckets sum to. */
  sessions: number;
}

export interface CaptureHealthRollup {
  captureHealthVersion: string;
  verdicts: Record<CaptureHealthVerdict, number>;
  rows: CaptureHealthRow[];
}

export interface RecoverabilityRollup {
  /** Rows the dry run actually attempted (skipped rows excluded). */
  attempted: number;
  ok: number;
  skipped: {
    gemini: number;
    unsupportedConnector: number;
    noRawRecords: number;
    decryptError: number;
  };
  rows: RecoverabilityRow[];
}

export interface DataQualityMetrics {
  dataQualityVersion: string;
  captureHealthVersion: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** (session, connector) pairs inside the window — the unit every session ratio is taken over. */
  sessionsInWindow: number;
  /** Distinct `session_id` values inside the window. Differs from the above on a collision. */
  distinctSessions: number;
  eventsInWindow: number;
  metrics: DataQualityMetricTable;
  tokenEligibility: TokenEligibilityCounts;
  syncFreshness: SyncFreshnessCounts;
  gitConfidence: GitConfidenceCounts;
  captureHealth: CaptureHealthRollup;
  recoverability: RecoverabilityRollup;
  reconciliation: { sampleSize: number; sample: ReconciliationSampleRow[] };
}

// --- Reasons, written once so the renderer and the tests agree ------------

/**
 * Why a metric is `unknown` STRUCTURALLY — not "we had no data this week" but "the archive cannot
 * answer this question at all" (§4.4 puts the ground truth outside the product). These two strings
 * are rendered verbatim on their rows, and both point at the worksheet that CAN answer them.
 */
export const UNKNOWN_REASONS = {
  captureCoverage:
    "Not derivable from the archive. The denominator is tool-native sessions that ACTUALLY happened, " +
    "which exists only on disk under ~/.claude/projects and ~/.codex/sessions (§4.4 check 1). " +
    "Anything computed from captured sessions alone scores a perfect result by construction. " +
    "Answer it by hand-counting the worksheet sample below.",
  attributionCorrectness:
    "Not derivable from the archive. The archive can tell that `project_path` RESOLVES to a " +
    "workspace key (that is the coverage row above); it cannot tell that it resolves to the RIGHT " +
    "project, because the ground truth is what the operator believes the session was about " +
    "(§4.4 check 4). Answer it by hand on the worksheet sample below.",
} as const;

// --- Derivation -----------------------------------------------------------

/** Best-of ladder for one session's git links: a confirmed link outranks every suggestion. */
type GitBucket = "confirmed" | "heuristic" | "none";

/**
 * Reduce every machine's declaration of a connector to one verdict per connector.
 *
 * BOTH REDUCTIONS DELIBERATELY KEEP SESSIONS IN A DENOMINATOR, which is the direction that cannot
 * flatter the result. Marking a connector token-INELIGIBLE removes its sessions from token
 * completeness and raises the ratio; marking it NOT-live-capture removes them from sync freshness
 * and raises that one. So a connector counts as token-eligible if ANY machine declares it capable,
 * and as live-capture if ANY machine declares it so. A machine that reports lower fidelity for the
 * same connector is a real gap worth measuring, not a reason to stop measuring.
 */
function summarizeDeclarations(
  rows: ConnectorDeclarationRow[],
): Map<string, { tokenEligible: boolean; liveCapture: boolean }> {
  const byConnector = new Map<string, { tokenEligible: boolean; liveCapture: boolean }>();
  for (const r of rows) {
    const prev = byConnector.get(r.connectorId);
    const tokenEligible = r.tokens !== "none";
    const liveCapture = isLiveCapture(r.liveness);
    byConnector.set(r.connectorId, {
      tokenEligible: (prev?.tokenEligible ?? false) || tokenEligible,
      liveCapture: (prev?.liveCapture ?? false) || liveCapture,
    });
  }
  return byConnector;
}

/**
 * Derive the whole §5.1 table plus its two additions (the 16.3 roll-up and §7 P1.7's git
 * confidence). `nowMs` is injected — the route owns the clock — so the window bounds and every
 * judgement below are deterministic and testable with no database.
 */
export function deriveDataQualityMetrics(
  inputs: DataQualityInputs,
  nowMs: number,
): DataQualityMetrics {
  const declarations = summarizeDeclarations(inputs.declarations);
  const sessions = inputs.sessions;
  const distinctSessionIds = new Set(sessions.map((s) => s.sessionId));
  const eventsInWindow = sessions.reduce((n, s) => n + s.eventCount, 0);

  // --- Attribution COVERAGE (measured) and CORRECTNESS (structurally unknown) --------------
  //
  // §5.1 asks for "sessions with CORRECT project/workspace attribution". Shipping coverage under
  // that label would be the milestone's Risk 2 in one line: the instrument grading itself with the
  // easier question. Two rows, and only one of them carries a number (D-16.4-4).
  const attributed = sessions.filter((s) => s.attributed).length;
  const attributionCoverage = ratioMetric(
    attributed,
    sessions.length,
    "No sessions in the window, so attribution coverage has no denominator. This is not a perfect " +
      "score — it is the absence of anything to attribute.",
  );

  // --- Token completeness -------------------------------------------------------------------
  //
  // Denominator is sessions on ELIGIBLE connectors only (§5.1: "for eligible connectors"). A
  // connector declaring `tokens:"none"` genuinely cannot report them, so counting its sessions as
  // incomplete would be a fabricated defect. A connector NOTHING declares is neither — a pre-16.3
  // collector reports no fidelity at all, so asserting either answer would be a fabricated fact.
  // Its sessions go to a third bucket, mirroring 16.3's `unreported` state.
  const tokenEligibility: TokenEligibilityCounts = { eligible: 0, ineligible: 0, undeclared: 0 };
  let tokenUsable = 0;
  for (const s of sessions) {
    const decl = declarations.get(s.sourceConnector);
    if (decl === undefined) {
      tokenEligibility.undeclared += 1;
      continue;
    }
    if (!decl.tokenEligible) {
      tokenEligibility.ineligible += 1;
      continue;
    }
    tokenEligibility.eligible += 1;
    if (s.withTokens > 0) tokenUsable += 1;
  }
  const tokenCompleteness = ratioMetric(
    tokenUsable,
    tokenEligibility.eligible,
    tokenEligibility.undeclared > 0
      ? `No sessions on a connector declared token-capable. ${tokenEligibility.undeclared} session(s) ` +
          "ran on a connector no machine declares (a pre-16.3 collector), which is neither eligible " +
          "nor ineligible — upgrade the collector to make this measurable."
      : "No sessions on a token-eligible connector in the window, so token completeness has no " +
          "denominator.",
  );

  // --- Parse success ------------------------------------------------------------------------
  //
  // Denominator is raw ROWS. Spike S1 measured the trap this avoids: the same `source_record_id`
  // held by two machines produces two raw rows that each join to the same events, so a join-based
  // denominator inflates and the ratio silently drifts.
  const parseSuccess = ratioMetric(
    inputs.rawTotals.yieldedEvents,
    inputs.rawTotals.rawRows,
    "No raw records were ingested in the window, so parse success has no denominator. `0 failures ÷ " +
      "0 records` is not a perfect pass — it is a silent capture outage wearing the same badge.",
  );

  // --- Duplicate rate -----------------------------------------------------------------------
  const ingestedEvents = inputs.duplicates.distinctEvents + inputs.duplicates.duplicateEvents;
  const duplicateRate = ratioMetric(
    inputs.duplicates.duplicateEvents,
    ingestedEvents,
    "No events were ingested in the window, so the duplicate rate has no denominator.",
  );

  // --- Sync freshness -----------------------------------------------------------------------
  //
  // Only LIVE-CAPTURE connectors have an archive-knowable window (see DATA_QUALITY_THRESHOLDS).
  // Everything else — a batch connector, an undeclared one, or a session whose lag cannot be
  // computed at all — lands in `unknown` and is excluded from BOTH halves of the ratio, exactly as
  // an undeclared connector is for token completeness.
  const syncFreshness: SyncFreshnessCounts = { fresh: 0, stale: 0, unknown: 0 };
  for (const row of inputs.lag) {
    const decl = declarations.get(row.sourceConnector);
    if (row.lagMs === null || decl === undefined || !decl.liveCapture) {
      syncFreshness.unknown += 1;
      continue;
    }
    if (row.lagMs <= DATA_QUALITY_THRESHOLDS.syncFreshnessMs) syncFreshness.fresh += 1;
    else syncFreshness.stale += 1;
  }
  const freshDenominator = syncFreshness.fresh + syncFreshness.stale;
  const syncFreshnessMetric = ratioMetric(
    syncFreshness.fresh,
    freshDenominator,
    syncFreshness.unknown > 0
      ? `No session on a live-capture connector had a measurable ingest lag. ${syncFreshness.unknown} ` +
          "session(s) sit outside this metric: a batch/snapshot connector has no archive-knowable " +
          "liveness window, and an undeclared one has no declaration to read."
      : "No sessions in the window, so sync freshness has no denominator.",
  );

  // --- Recoverability (SAMPLED, never measured) ----------------------------------------------
  //
  // Skipped rows are excluded from the denominator, never counted as failures. A Gemini session's
  // raw records cannot reconstruct the parser's whole-file input (D-M13-2) — that is a known scope
  // boundary, not a recoverability defect, and scoring it as one would put a permanent false red on
  // a metric whose target is 100%.
  const recoverabilityRollup: RecoverabilityRollup = {
    attempted: 0,
    ok: 0,
    skipped: { gemini: 0, unsupportedConnector: 0, noRawRecords: 0, decryptError: 0 },
    rows: inputs.recoverability,
  };
  for (const r of inputs.recoverability) {
    switch (r.skippedReason) {
      case "gemini":
        recoverabilityRollup.skipped.gemini += 1;
        break;
      case "unsupported-connector":
        recoverabilityRollup.skipped.unsupportedConnector += 1;
        break;
      case "no-raw-records":
        recoverabilityRollup.skipped.noRawRecords += 1;
        break;
      case "decrypt-error":
        recoverabilityRollup.skipped.decryptError += 1;
        break;
      case null:
        recoverabilityRollup.attempted += 1;
        if (r.ok) recoverabilityRollup.ok += 1;
        break;
    }
  }
  const recoverability = ratioMetric(
    recoverabilityRollup.ok,
    recoverabilityRollup.attempted,
    "No sampled session could be re-parsed: every one was skipped (an unsupported connector, or a " +
      "raw record that would not decrypt). Recoverability is unproven for this window — which is a " +
      "different fact from 'nothing failed'.",
    recoverabilityRollup.attempted,
  );

  // --- Git outcome confidence (§7 P1.7) -------------------------------------------------------
  //
  // Bucketed in TS rather than SQL so the two judgements that matter are unit-testable: a session
  // holding BOTH a confirmed and a suggested link counts ONCE as confirmed, and a session holding
  // only REJECTED links counts as no linkage — a human looked and said no, which is the opposite of
  // a weak signal.
  const bucketBySession = new Map<string, GitBucket>();
  for (const id of distinctSessionIds) bucketBySession.set(id, "none");
  for (const link of inputs.gitLinks) {
    const current = bucketBySession.get(link.sessionId);
    if (current === undefined) continue; // a link to a session outside the window
    if (current === "confirmed") continue;
    if (link.status === "confirmed") bucketBySession.set(link.sessionId, "confirmed");
    else if (link.status === "suggested") bucketBySession.set(link.sessionId, "heuristic");
    // "rejected" (or any future status) leaves the bucket where it is — never promotes.
  }
  const gitConfidence: GitConfidenceCounts = {
    confirmed: 0,
    heuristic: 0,
    none: 0,
    sessions: distinctSessionIds.size,
  };
  for (const bucket of bucketBySession.values()) gitConfidence[bucket] += 1;

  // --- Capture health roll-up (D-16.4-2) ------------------------------------------------------
  //
  // `deriveCaptureHealth` is CALLED here rather than handed pre-counted verdicts, which is the
  // strongest form of the decision: there is no code path in which a second, disagreeing connector
  // verdict can exist. Two independently-derived numbers on one screen is the "which number do I
  // believe?" problem the milestone exists to remove.
  const captureHealthRows = deriveCaptureHealth(inputs.captureHealth, nowMs);
  const verdicts: Record<CaptureHealthVerdict, number> = {
    capturing: 0,
    "not-capturing": 0,
    broken: 0,
    unknown: 0,
  };
  for (const row of captureHealthRows) verdicts[row.verdict] += 1;

  return {
    dataQualityVersion: DATA_QUALITY_VERSION,
    captureHealthVersion: CAPTURE_HEALTH_VERSION,
    windowDays: inputs.windowDays,
    windowStart: inputs.sinceIso,
    windowEnd: new Date(nowMs).toISOString(),
    sessionsInWindow: sessions.length,
    distinctSessions: distinctSessionIds.size,
    eventsInWindow,
    metrics: {
      // Structurally unknown — the reason is the value, and it never renders as "0%".
      captureCoverage: { kind: "unknown", reason: UNKNOWN_REASONS.captureCoverage },
      attributionCoverage,
      attributionCorrectness: {
        kind: "unknown",
        reason: UNKNOWN_REASONS.attributionCorrectness,
      },
      tokenCompleteness,
      parseSuccess,
      duplicateRate,
      syncFreshness: syncFreshnessMetric,
      recoverability,
    },
    tokenEligibility,
    syncFreshness,
    gitConfidence,
    captureHealth: {
      captureHealthVersion: CAPTURE_HEALTH_VERSION,
      verdicts,
      rows: captureHealthRows,
    },
    recoverability: recoverabilityRollup,
    reconciliation: { sampleSize: inputs.sample.length, sample: inputs.sample },
  };
}
