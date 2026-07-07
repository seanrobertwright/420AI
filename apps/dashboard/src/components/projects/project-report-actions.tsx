"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Project-scoped report generation (M12 12.2b; widened M13 13.2 — PRD §15). A small
 * client island embedded in the (server) project detail view so the page stays a
 * Server Component. Mirrors the `alerts-panel.tsx` mutation discipline: POST the
 * same-origin proxy (token stays server-side, D8), CHECK `res.ok` (fetch resolves on
 * 4xx/5xx), disable in-flight to prevent a duplicate non-idempotent POST, then
 * `router.refresh()` so the server re-fetches and the new version appears.
 *
 * Two independent actions, two routes: the six DETERMINISTIC `project.*` report
 * types (this slice's new five + the original cost-over-time) all POST
 * `/reports {type}` — the proxy already forwards the body verbatim, so widening
 * the type-select from one option to six is a zero-proxy-change UI edit. The AI
 * interpretation is a SEPARATE, billable-provider route (`/interpretations`) with
 * its own confirm step — unrelated to 13.2's deterministic report engine, kept as
 * its own button rather than folded into the type-select.
 */

const PROJECT_REPORT_TYPES = [
  { value: "project.cost_over_time", label: "Cost over time" },
  { value: "project.tool_model_comparison", label: "Tool/model comparison" },
  { value: "project.failed_tool_calls", label: "Failed tool calls" },
  { value: "project.context_waste", label: "Context waste (§17)" },
  { value: "project.efficiency", label: "Efficiency" },
  { value: "project.trend_anomalies", label: "Trend anomalies" },
] as const;

type ProjectReportType = (typeof PROJECT_REPORT_TYPES)[number]["value"];

export function ProjectReportActions({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<ProjectReportType>(
    PROJECT_REPORT_TYPES[0].value,
  );
  const [busy, setBusy] = useState<null | ProjectReportType | "ai">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function generateReport(type: ProjectReportType): Promise<void> {
    setBusy(type);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) {
        setError(
          res.status === 404
            ? "Project has no events to report on."
            : `Generation failed (${res.status}).`,
        );
        return;
      }
      const label = PROJECT_REPORT_TYPES.find((t) => t.value === type)?.label ?? type;
      setDone(`${label} report generated.`);
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function generateAiInterpretation(): Promise<void> {
    if (!window.confirm("Generate an AI interpretation? This calls a billable provider.")) {
      return;
    }
    setBusy("ai");
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/interpretations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setError(
          res.status === 503
            ? "AI provider not configured."
            : res.status === 502
              ? "AI provider error — try again."
              : res.status === 404
                ? "Project has no events to report on."
                : `Generation failed (${res.status}).`,
        );
        return;
      }
      setDone("AI interpretation generated.");
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(null);
    }
  }

  const btn = cn(
    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
    "border-border hover:bg-muted disabled:opacity-50",
  );
  const select = cn(
    "rounded-md border px-2 py-1.5 text-xs",
    "border-border bg-background disabled:opacity-50",
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <select
          className={select}
          value={selectedType}
          disabled={busy !== null}
          onChange={(e) => setSelectedType(e.target.value as ProjectReportType)}
        >
          {PROJECT_REPORT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={btn}
          disabled={busy !== null}
          onClick={() => void generateReport(selectedType)}
        >
          {busy === selectedType ? "Generating…" : "Generate report"}
        </button>
        <button
          type="button"
          className={btn}
          disabled={busy !== null}
          onClick={() => void generateAiInterpretation()}
        >
          {busy === "ai" ? "Generating…" : "Generate AI interpretation"}
        </button>
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
      {done ? <span className="text-muted-foreground text-xs">{done}</span> : null}
    </div>
  );
}
