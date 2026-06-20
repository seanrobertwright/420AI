import type { ReactNode } from "react";

/**
 * The standard surface wrapper (M12 12.2a): the `<main className="mx-auto max-w-6xl px-6 py-10">`
 * + header block extracted from `live-monitor.tsx` so every read surface shares one layout.
 * Pure presentational server component (no state, no token) — a client page can still render
 * it. `actions` is an optional right-aligned slot (e.g. a status badge or a filter control).
 */
export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle ? <p className="text-muted-foreground text-sm">{subtitle}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {children}
    </main>
  );
}
