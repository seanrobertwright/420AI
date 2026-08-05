import type { DataQualityMetrics, MetricValue } from "./data-quality.js";

/**
 * M16 16.4 — the Markdown renderer for the org-scoped data-quality audit (research plan §7 P0.3).
 *
 * Same contract as every other renderer in this package (`reports.ts`): PURE, clock-free
 * (`generatedAt` is caller-injected), Markdown TABLES are the source of truth and the one Mermaid
 * block is explicitly labelled illustrative.
 *
 * The output feeds `.agents/research/weekly/YYYY-WW.md`, but NOT one-table-to-one-table, and the
 * difference matters because the template is an operator instruction. §10's "Capture health" block
 * and §5.1's metric table are two different seven-row lists that only partly overlap:
 *
 *   §10 row                      ← where it comes from in this report
 *   ---------------------------------------------------------------------------------------------
 *   Captured sessions            ← the header bullet "Sessions in window", NOT the §5.1 table
 *   Capture coverage (audit)     ← §5.1 table (always `unknown` — answer it from the worksheet)
 *   Correct project attribution  ← §5.1 table, the CORRECTNESS row (also always `unknown`)
 *   Token completeness           ← §5.1 table
 *   Parse success                ← §5.1 table
 *   Duplicate rate               ← §5.1 table
 *   Stale/unhealthy connectors   ← "Capture health (from 16.3)" verdict counts, NOT the §5.1 table
 *
 * The §5.1 table additionally carries `Project attribution — coverage`, `Sync freshness` and
 * `Recoverability`, for which §10 has no slot at all.
 *
 * §5.3 IS WHY EVERY ROW CARRIES ITS BASIS AND ITS WINDOW: "No recommendation presented without its
 * source metrics, data range, and confidence caveat." A bare percentage in a weekly scorecard four
 * weeks later cannot be re-derived or challenged; a percentage next to `measured` / `sampled (n=10)`
 * / `unknown` and a date range can be.
 */

/** Renderer identity stamped on every audit artifact (PRD §23). Its own lineage, like M13's. */
export const AUDIT_REPORT_VERSION = "m16-audit-v1";

export interface DataQualityAuditInput extends DataQualityMetrics {
  /** ISO — injected by the caller (clock-free renderer, CLAUDE.md). */
  generatedAt: string;
}

/**
 * The §5.1 targets, transcribed verbatim from the research plan's table — EXCEPT recoverability's,
 * which §5.1 words as "100% of monthly sample".
 *
 * That literal is deliberately not used. The empty-org regression test asserts the string `100%`
 * appears NOWHERE in a report whose every metric is `unknown`, because that is the exact badge a
 * healthy-looking zero would wear; a target column that always contains it would make the assertion
 * unwritable. A measured ratio of 1.0 still renders as `100.0%`, so a genuine perfect score remains
 * expressible — it is only the bare token that is reserved.
 */
const TARGETS = {
  captureCoverage: "≥95%",
  attributionCoverage: "≥90%",
  attributionCorrectness: "≥90%",
  tokenCompleteness: "≥95%",
  parseSuccess: "≥99%",
  duplicateRate: "<1%",
  syncFreshness: "≥95%",
  recoverability: "all sampled records",
} as const;

/** `2026-08-04T09:00:00.000Z` → `2026-08-04`. Null-safe; never throws on a malformed stamp. */
function isoDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}

/** A percentage with one decimal. `1` renders `100.0%`, never the bare `100%` token (see TARGETS). */
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * The VALUE cell. An `unknown` metric renders its REASON here — never `—`, never `0%`, never an
 * empty cell. That is the whole point of the three-state union: the cell a reader's eye lands on
 * has to carry the fact that there is no number, and why.
 */
function renderValue(m: MetricValue): string {
  if (m.kind === "unknown") return `**unknown** — ${m.reason}`;
  return `${pct(m.ratio)} (${m.numerator} / ${m.denominator})`;
}

/** The BASIS cell — how the value was arrived at, which §5.3 requires beside the value itself. */
function renderBasis(m: MetricValue): string {
  switch (m.kind) {
    case "measured":
      return "measured";
    case "sampled":
      return `sampled (n=${m.sampleSize})`;
    case "unknown":
      return "unknown";
  }
}

/** Escape a cell so an embedded pipe (a path, a reason) cannot break the table. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderDataQualityAuditReport(input: DataQualityAuditInput): string {
  const lines: string[] = [];
  const m = input.metrics;

  lines.push("# Data-Quality Audit");
  lines.push("");
  lines.push(`- **Generated:** ${input.generatedAt}`);
  lines.push(
    `- **Window:** ${isoDay(input.windowStart)} → ${isoDay(input.windowEnd)} (${input.windowDays} days)`,
  );
  lines.push(
    `- **Sessions in window:** ${input.sessionsInWindow} (session×connector groups; ${input.distinctSessions} distinct session ids)`,
  );
  lines.push(`- **Events in window:** ${input.eventsInWindow}`);
  lines.push(`- **Derivation:** \`${input.dataQualityVersion}\``);
  lines.push(
    `- **Connector verdicts:** \`${input.captureHealthVersion}\` (imported, not re-derived)`,
  );
  lines.push("");

  // --- 1. The §5.1 table ------------------------------------------------------------------
  lines.push("## §5.1 Data quality");
  lines.push("");
  lines.push(
    "_Every row carries its basis. `unknown` is a real answer here and is never rendered as a zero " +
      'or a dash — §5.1 closes with "Record unknown values explicitly. Do not substitute zero for ' +
      'absent data."_',
  );
  lines.push("");
  lines.push("| metric | value | target | basis | notes |");
  lines.push("| ------ | ----- | ------ | ----- | ----- |");
  const row = (label: string, value: MetricValue, target: string, notes: string): void => {
    lines.push(
      `| ${cell(label)} | ${cell(renderValue(value))} | ${cell(target)} | ${cell(renderBasis(value))} | ${cell(notes)} |`,
    );
  };
  row(
    "Capture coverage",
    m.captureCoverage,
    TARGETS.captureCoverage,
    "Requires ground truth outside the product (§4.4). See the worksheet below.",
  );
  row(
    "Project attribution — coverage",
    m.attributionCoverage,
    TARGETS.attributionCoverage,
    "`project_path` resolves to a workspace key owned by this org.",
  );
  row(
    "Project attribution — correctness",
    m.attributionCorrectness,
    TARGETS.attributionCorrectness,
    "A DIFFERENT metric from coverage, and the one §5.1 actually asks for.",
  );
  row(
    "Token completeness",
    m.tokenCompleteness,
    TARGETS.tokenCompleteness,
    `Eligible ${input.tokenEligibility.eligible} / ineligible ${input.tokenEligibility.ineligible} / undeclared ${input.tokenEligibility.undeclared} sessions.`,
  );
  row(
    "Parse success",
    m.parseSuccess,
    TARGETS.parseSuccess,
    "Raw records that yielded at least one event ÷ raw records ingested.",
  );
  row(
    "Duplicate rate",
    m.duplicateRate,
    TARGETS.duplicateRate,
    "Measured on `raw_source_records` — see the caveats below for what it cannot see.",
  );
  row(
    "Sync freshness",
    m.syncFreshness,
    TARGETS.syncFreshness,
    `Fresh ${input.syncFreshness.fresh} / stale ${input.syncFreshness.stale} / not applicable ${input.syncFreshness.unknown}.`,
  );
  row(
    "Recoverability",
    m.recoverability,
    TARGETS.recoverability,
    `Dry-run re-parse; skipped: ${input.recoverability.skipped.gemini} gemini, ${input.recoverability.skipped.unsupportedConnector} unsupported, ${input.recoverability.skipped.noRawRecords} no-raw-records, ${input.recoverability.skipped.decryptError} decrypt-error.`,
  );
  lines.push("");

  // --- 2. Capture health, imported from 16.3 ------------------------------------------------
  lines.push("## Capture health (from 16.3)");
  lines.push("");
  lines.push(
    `- **Capturing:** ${input.captureHealth.verdicts.capturing} · **Not capturing:** ${input.captureHealth.verdicts["not-capturing"]} · **Broken:** ${input.captureHealth.verdicts.broken} · **Unknown:** ${input.captureHealth.verdicts.unknown}`,
  );
  lines.push(
    "- These counts come from `deriveCaptureHealth`, the same derivation the Capture Health panel " +
      "renders. They are never re-derived here (D-16.4-2) — two independently-derived numbers on " +
      'one screen is the "which number do I believe?" problem this milestone exists to remove.',
  );
  lines.push("");
  lines.push("| machine | connector | state | verdict | last event | events | last error |");
  lines.push("| ------- | --------- | ----- | ------- | ---------- | ------ | ---------- |");
  for (const r of input.captureHealth.rows) {
    lines.push(
      `| ${cell(r.machineName)} | ${cell(r.connectorId)} | ${cell(r.state)} | ${cell(r.verdict)} | ${cell(r.lastEventAt ?? "(never)")} | ${r.eventCount} | ${cell(r.lastErrorMessage ?? "—")} |`,
    );
  }
  if (input.captureHealth.rows.length === 0) {
    lines.push("| _No connectors declared or observed._ | | | | | | |");
  }
  lines.push("");

  // --- 3. Git outcome confidence (§7 P1.7) --------------------------------------------------
  lines.push("## Git outcome confidence (§7 P1.7)");
  lines.push("");
  lines.push(
    "**A heuristic link is a time/file-overlap correlation, not evidence of causation.** It is " +
      "reported separately from confirmed linkage precisely so a productivity claim cannot be built " +
      "on one without the reader noticing.",
  );
  lines.push("");
  lines.push("| linkage | sessions | meaning |");
  lines.push("| ------- | -------- | ------- |");
  lines.push(
    `| confirmed | ${input.gitConfidence.confirmed} | A human confirmed this session produced this commit. |`,
  );
  lines.push(
    `| heuristic | ${input.gitConfidence.heuristic} | Suggested by time/file overlap only. NOT causal evidence. |`,
  );
  lines.push(
    `| none | ${input.gitConfidence.none} | No link, or every link was rejected by a human. |`,
  );
  lines.push(
    `| **total** | **${input.gitConfidence.sessions}** | Distinct sessions in the window. |`,
  );
  lines.push("");

  // --- 4. The §4.4 reconciliation worksheet -------------------------------------------------
  lines.push("## §4.4 Reconciliation worksheet");
  lines.push("");
  lines.push(
    `_${input.reconciliation.sampleSize} session(s), selected deterministically by \`md5(session_id)\` (D-16.4-5) — ` +
      "a re-run over the same window picks the SAME sessions, so a hand-count four weeks later " +
      "audits exactly what this report did._",
  );
  lines.push("");
  lines.push(
    "Checks 2, 3, 5 and 6 are pre-filled from the archive. **Checks 1 and 4 have no archive answer " +
      "and are left blank on purpose** — check them against the tool-native files under " +
      "`~/.claude/projects` and `~/.codex/sessions`, then log every mismatch in " +
      "`.agents/research/incidents.md`, categorized per §4.4.",
  );
  lines.push("");
  lines.push(
    "| session | connector | 1. tool-native exists | 2. raw record | 3. events + tokens | 4. attribution correct | 5. cost confidence | 6. visible in search |",
  );
  lines.push(
    "| ------- | --------- | --------------------- | ------------- | ------------------ | ---------------------- | ------------------ | -------------------- |",
  );
  for (const s of input.reconciliation.sample) {
    const check3 = `${s.eventCount} events, ${s.eventsWithTokens} with tokens${s.models.length > 0 ? ` (${s.models.join(", ")})` : ""}`;
    const check5 = s.costConfidences.length > 0 ? s.costConfidences.join(", ") : "(none costed)";
    lines.push(
      `| ${cell(s.sessionId)} | ${cell(s.sourceConnector)} | ( ) | ${s.rawRecordCount} | ${cell(check3)} | ( ) | ${cell(check5)} | ${s.indexed ? "yes" : "no"} |`,
    );
  }
  if (input.reconciliation.sample.length === 0) {
    lines.push("| _No sessions in the window to sample._ | | | | | | | |");
  }
  lines.push("");

  // --- 5. Scope and caveats -----------------------------------------------------------------
  lines.push("## Scope and caveats");
  lines.push("");
  lines.push(
    "- **Fixed observation set (D-M16-1).** Phase 1 runs Claude Code + Codex CLI only. The browser " +
      "extension is deliberately NOT run, so the D1 `claude-live` vs `claude-export` cross-connector " +
      "dedup gap cannot contaminate the duplicate rate. Read every figure here as a statement about " +
      "that configuration, not a global claim.",
  );
  lines.push(
    "- **What the duplicate rate cannot see (D-16.4-3).** It counts duplicates VISIBLE as redundant " +
      "raw rows — the same `(connector, source_record_id)` shipped by two machines. It does not see " +
      "duplicates the collector suppressed at its queue cursor before upload, and it does not see " +
      "the cross-connector gap above (a different connector yields a different fingerprint, so two " +
      "legitimate-looking sessions result). It also counts copies only INSIDE this window, so a " +
      "second machine backfilling records whose first copy landed before the window start reports " +
      "one copy and is invisible here — widen the window to see it. It cannot be measured on " +
      "`events` at all: that table " +
      "upserts by fingerprint, so a duplicate has already collapsed before any query runs — a count " +
      "there is a structural zero, i.e. success by blindness.",
  );
  lines.push(
    '- **Coverage is not correctness (D-16.4-4).** The archive can answer "does `project_path` ' +
      'resolve to a workspace key"; it cannot answer "does it resolve to the RIGHT project". Both ' +
      "rows appear above and only one carries a number. Do not quote the coverage figure as if it " +
      "were §5.1's attribution target.",
  );
  lines.push(
    "- **Recoverability is a DRY RUN.** It decrypts a bounded sample server-side, re-parses it, and " +
      "compares fingerprint sets. It writes nothing, and no decrypted content is stored in or " +
      "rendered into this artifact — only counts.",
  );
  lines.push("");

  // --- 6. One illustrative chart ------------------------------------------------------------
  lines.push("## Connector verdicts (chart)");
  lines.push("");
  lines.push("<!-- The tables above are the source of truth; this chart is illustrative. -->");
  if (input.captureHealth.rows.length > 0) {
    lines.push("```mermaid");
    lines.push("pie showData");
    lines.push("    title Connector verdicts");
    lines.push(`    "capturing" : ${input.captureHealth.verdicts.capturing}`);
    lines.push(`    "not-capturing" : ${input.captureHealth.verdicts["not-capturing"]}`);
    lines.push(`    "broken" : ${input.captureHealth.verdicts.broken}`);
    lines.push(`    "unknown" : ${input.captureHealth.verdicts.unknown}`);
    lines.push("```");
  } else {
    lines.push("_No connector verdicts to chart._");
  }
  lines.push("");

  return lines.join("\n");
}
