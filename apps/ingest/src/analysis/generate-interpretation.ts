import type { Db, ReportArtifactRow } from "@420ai/db";
import {
  sessionDetail,
  sessionTranscript,
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionProjections,
  getProjectName,
  insertReportArtifact,
} from "@420ai/db";
import {
  redact,
  buildAnalysisPrompt,
  AI_REPORT_VERSION,
  REDACTION_VERSION,
  type RedactionFinding,
  type SessionBundle,
  type ProjectBundle,
} from "@420ai/shared";
import type { AnalysisProvider } from "./provider.js";

/**
 * M8 interpretation orchestrators (PRD §16.2, §18). The single seam that composes
 * the M6 read projections + the FIRST decrypt-for-render transcript read + the pure
 * `@420ai/shared` redaction & prompt builder + the injected provider + the M7
 * versioned `report_artifacts` store. Mirrors `reports/generate-report.ts` (compose
 * db + pure builder + store; clock injected via `generatedAt`; silent/throws).
 *
 * §18 REDACT-BEFORE-SEND GATE: decrypted session text exists in plaintext only here,
 * transiently, between the `sessionTranscript` read and the `redact()` call below. It
 * is redacted BEFORE it is put in a provider request and BEFORE anything is written
 * to `report_artifacts`. Unredacted decrypted content is NEVER sent to a provider,
 * NEVER logged, and NEVER stored. (Empty/unknown-scope guarding is the ROUTE's job,
 * D8 — these orchestrators assume a non-empty, existing scope.)
 */

/** Combine per-entry findings into one finding per kind (counts summed). */
function mergeFindings(findings: RedactionFinding[]): RedactionFinding[] {
  const byKind = new Map<string, RedactionFinding>();
  for (const f of findings) {
    const existing = byKind.get(f.kind);
    if (existing) existing.count += f.count;
    else byKind.set(f.kind, { ...f });
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export async function generateSessionInterpretation(
  db: Db,
  provider: AnalysisProvider,
  userId: string,
  sessionId: string,
  generatedAt: string,
  maxOutputTokens: number,
): Promise<ReportArtifactRow> {
  const metrics = await sessionDetail(db, sessionId);
  const raw = await sessionTranscript(db, sessionId); // DECRYPTED plaintext (transient)

  // §18: redact each decrypted entry BEFORE it enters the bundle.
  const transcriptFindings: RedactionFinding[] = [];
  const transcript = raw.entries.map((e) => {
    const r = redact(e.text);
    transcriptFindings.push(...r.findings);
    return { role: e.role, text: r.redacted };
  });

  const bundle: SessionBundle = {
    kind: "session",
    sessionId,
    generatedAt,
    metrics,
    transcript,
    redactionFindings: mergeFindings(transcriptFindings),
    transcriptTruncated: raw.truncated,
  };
  const { system, user } = buildAnalysisPrompt(bundle);
  // Defensive second pass: catch any PII (home-dir paths/emails) that the metrics
  // section embedded as plaintext. Idempotent — transcript placeholders never re-match.
  const final = redact(user);
  const findings = mergeFindings([...transcriptFindings, ...final.findings]);

  const result = await provider.interpret({ system, user: final.redacted, maxOutputTokens });

  return insertReportArtifact(db, {
    userId,
    projectId: null,
    reportType: "session.ai_interpretation",
    scopeKind: "session",
    scopeId: sessionId,
    reportVersion: AI_REPORT_VERSION,
    params: { model: result.model, maxOutputTokens },
    metrics: {
      kind: "session",
      metrics,
      redactionFindings: findings,
      redactionVersion: REDACTION_VERSION,
      model: result.model,
      usage: result.usage ?? null,
      transcriptTruncated: raw.truncated,
      bundleChars: final.redacted.length,
    },
    markdown: result.markdown,
  });
}

export async function generateProjectInterpretation(
  db: Db,
  provider: AnalysisProvider,
  userId: string,
  projectId: string,
  generatedAt: string,
  maxOutputTokens: number,
): Promise<ReportArtifactRow> {
  // Project interpretation is metrics-only — NO transcript/decrypt (D4: cross-session
  // content is unbounded). The route already guaranteed the project exists + has events.
  const [totals, byModel, overTime, sessions, projectName] = await Promise.all([
    usageTotals(db, projectId),
    usageByModel(db, projectId),
    usageOverTime(db, projectId, "day"),
    sessionProjections(db, projectId),
    getProjectName(db, projectId),
  ]);

  const bundle: ProjectBundle = {
    kind: "project",
    projectId,
    projectName: projectName ?? "(unknown)",
    generatedAt,
    metrics: { totals, byModel, overTime, sessions },
  };
  const { system, user } = buildAnalysisPrompt(bundle);
  // Defensive redaction of the metrics-derived prompt (project paths may carry a
  // home-dir username; session ids/paths are plaintext metric fields).
  const final = redact(user);

  const result = await provider.interpret({ system, user: final.redacted, maxOutputTokens });

  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.ai_interpretation",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: AI_REPORT_VERSION,
    params: { model: result.model, maxOutputTokens },
    metrics: {
      kind: "project",
      metrics: { totals, byModel, overTime, sessions },
      redactionFindings: final.findings,
      redactionVersion: REDACTION_VERSION,
      model: result.model,
      usage: result.usage ?? null,
      bundleChars: final.redacted.length,
    },
    markdown: result.markdown,
  });
}
