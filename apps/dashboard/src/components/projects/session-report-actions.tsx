"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Per-session report generation (M12 12.2b) — a compact client island rendered in each row of
 * the (server) sessions table. Same mutation discipline as `ProjectReportActions`: same-origin
 * POST (token server-side, D8), `res.ok` check, in-flight disable (non-idempotent), refresh on
 * success. The AI interpretation is billable → confirm + distinct 503/502/404 messaging.
 */
export function SessionReportActions({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "autopsy" | "ai">(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(kind: "autopsy" | "ai"): Promise<void> {
    if (kind === "ai" && !window.confirm("Generate an AI interpretation? This calls a billable provider.")) {
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const enc = encodeURIComponent(sessionId);
      const path =
        kind === "autopsy"
          ? `/api/sessions/${enc}/reports`
          : `/api/sessions/${enc}/interpretations`;
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setError(
          res.status === 503
            ? "provider off"
            : res.status === 502
              ? "provider err"
              : res.status === 404
                ? "no events"
                : `failed (${res.status})`,
        );
        return;
      }
      router.refresh();
    } catch {
      setError("unreachable");
    } finally {
      setBusy(null);
    }
  }

  const btn = cn(
    "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
    "border-border hover:bg-muted disabled:opacity-50",
  );

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" className={btn} disabled={busy !== null} onClick={() => void generate("autopsy")}>
        {busy === "autopsy" ? "…" : "Autopsy"}
      </button>
      <button type="button" className={btn} disabled={busy !== null} onClick={() => void generate("ai")}>
        {busy === "ai" ? "…" : "AI"}
      </button>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </div>
  );
}
