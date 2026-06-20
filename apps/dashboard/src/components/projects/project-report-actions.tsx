"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Project-scoped report generation (M12 12.2b) — a small client island embedded in the
 * (server) project detail view so the page stays a Server Component. Mirrors the
 * `alerts-panel.tsx` mutation discipline: POST the same-origin proxy (token stays server-side,
 * D8), CHECK `res.ok` (fetch resolves on 4xx/5xx), disable in-flight to prevent a duplicate
 * non-idempotent POST, then `router.refresh()` so the server re-fetches and the new version
 * appears. The AI interpretation hits a BILLABLE provider → a confirm step + distinct 503
 * (not configured) / 502 (provider error) messages.
 */
export function ProjectReportActions({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "cost" | "ai">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function generate(kind: "cost" | "ai"): Promise<void> {
    if (kind === "ai" && !window.confirm("Generate an AI interpretation? This calls a billable provider.")) {
      return;
    }
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      const path =
        kind === "cost"
          ? `/api/projects/${projectId}/reports`
          : `/api/projects/${projectId}/interpretations`;
      const res = await fetch(path, {
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
      setDone(kind === "cost" ? "Cost report generated." : "AI interpretation generated.");
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

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button type="button" className={btn} disabled={busy !== null} onClick={() => void generate("cost")}>
          {busy === "cost" ? "Generating…" : "Generate cost report"}
        </button>
        <button type="button" className={btn} disabled={busy !== null} onClick={() => void generate("ai")}>
          {busy === "ai" ? "Generating…" : "Generate AI interpretation"}
        </button>
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
      {done ? <span className="text-muted-foreground text-xs">{done}</span> : null}
    </div>
  );
}
