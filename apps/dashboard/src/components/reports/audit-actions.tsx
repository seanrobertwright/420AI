"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { FORBIDDEN_MESSAGE } from "@/lib/mutation-error";

/**
 * Generate the org-scoped data-quality audit (M16 16.4, research plan §7 P0.3).
 *
 * ONE BUTTON ON THE EXISTING REPORTS PAGE — no new dashboard section (D-16.4-7). The milestone's
 * non-goals name "new dashboard sections that do not improve capture quality", and the artifact
 * already appears in the list above with zero changes to it (`reports-view.tsx` renders
 * `r.reportType` generically). A button is included rather than omitted because without it the
 * only trigger is `curl` or cron, and §7 P0.3's acceptance criterion — "weekly scorecard values are
 * QUERYABLE rather than manually guessed" — is not met by a report nobody can run.
 *
 * Same mutation discipline as `project-report-actions.tsx`: POST the same-origin proxy (the token
 * stays server-side, D8), CHECK `res.ok` (fetch resolves on 4xx/5xx), disable in-flight so a
 * double-click cannot append two versions, then `router.refresh()` so the new artifact appears.
 */

/** 7 fills §10's WEEKLY scorecard; 30 covers §4.4's monthly reconciliation cadence. */
const WINDOWS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
] as const;

export function AuditActions() {
  const router = useRouter();
  const [windowDays, setWindowDays] = useState<number>(WINDOWS[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/audit/data-quality", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ windowDays }),
      });
      if (!res.ok) {
        // `fetch` RESOLVES on 4xx/5xx — without this check a 403 would render as success.
        setError(
          res.status === 403 ? FORBIDDEN_MESSAGE : `Audit generation failed (${res.status}).`,
        );
        return;
      }
      setDone("Data-quality audit generated.");
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(false);
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
          value={windowDays}
          disabled={busy}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          aria-label="Audit window"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <button type="button" className={btn} disabled={busy} onClick={() => void generate()}>
          {busy ? "Generating…" : "Generate audit"}
        </button>
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
      {done ? <span className="text-muted-foreground text-xs">{done}</span> : null}
    </div>
  );
}
