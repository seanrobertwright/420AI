/**
 * Pure display formatters (M12 12.2a). Kept side-effect-free and clock-injected — `formatAgo`
 * takes `nowMs` rather than calling `Date.now()` internally — so they are deterministic and
 * unit-testable (mirrors the `@420ai/shared` clock-free convention). `formatAgo` is lifted
 * VERBATIM from `monitor/alerts-panel.tsx` so the monitor and the new surfaces share one
 * relative-time renderer (DRY, no behavior change).
 */

/** Honest relative time (PRD §10.1.1) — computed from an ISO ts + an injected now (ms). */
export function formatAgo(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const deltaMs = nowMs - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return "—";
  const s = Math.max(0, Math.round(deltaMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** USD to 4 dp ($0.0000) — cost figures are sub-cent (token pricing). NaN → "$0.0000". */
export function formatUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

/** Integer token counts with thousands separators (e.g. 1,234,567). NaN → "0". */
export function formatTokens(n: number): string {
  return (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString("en-US");
}

/** An ISO timestamp as a compact local date-time, or "—" when absent/unparseable. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
