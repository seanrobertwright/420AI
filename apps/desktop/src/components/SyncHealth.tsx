import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  ControlEvent,
  LiveMonitorSnapshot,
  AlertSeverity,
  MonitorStatus,
} from "@420ai/shared";
import { getMonitorSnapshot, onControlEvent } from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Sync & Health (M11 Slice 2). Two surfaces side by side:
 *  (a) the LOCAL sidecar capture state (pending/inflight), folded from the same
 *      `status` event the StatusBar consumes; and
 *  (b) the SERVER `LiveMonitorSnapshot`, fetched through the Rust `get_monitor_snapshot`
 *      proxy (which holds the admin token — the webview never sees it).
 *
 * The panel renders the snapshot's SERVER-DERIVED `alerts` directly — it does NOT
 * re-run `deriveAlerts` (the ingest route already folded them in; this mirrors the
 * dashboard's AlertsPanel). When the proxy rejects (admin token unset / ingest down),
 * the server section degrades to an error line + a hint and the local section stays live.
 */

/** Honest relative time (mirrors dashboard alerts-panel) — ISO ts + a client `now` (ms). */
function formatAgo(iso: string | null, nowMs: number): string {
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

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "border-transparent bg-destructive/15 text-destructive",
  warning: "border-transparent bg-amber-500/15 text-amber-400",
  info: "border-transparent bg-sky-500/15 text-sky-400",
};

const STATUS_BADGE: Record<MonitorStatus, string> = {
  online: "border-transparent bg-emerald-500/15 text-emerald-400",
  stale: "border-transparent bg-amber-500/15 text-amber-400",
  offline: "border-transparent bg-destructive/15 text-destructive",
};

interface LocalStatus {
  state: "running" | "paused" | "idle" | "error" | "connecting";
  pending: number;
  inflight: number;
}

export function SyncHealth() {
  const [local, setLocal] = useState<LocalStatus>({ state: "connecting", pending: 0, inflight: 0 });
  const [snapshot, setSnapshot] = useState<LiveMonitorSnapshot | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch the server snapshot via the Rust proxy. A rejection (token unset / ingest
  // down) is surfaced as panel state, never an unhandled rejection (StatusBar pattern).
  const refresh = (): void => {
    setLoading(true);
    getMonitorSnapshot()
      .then((snap) => {
        setSnapshot(snap);
        setServerError(null);
      })
      .catch((err) => setServerError(String(err)))
      .finally(() => setLoading(false));
  };

  // Subscribe to the local sidecar status stream (leak-window discipline: arm the
  // unlisten before the first await resolves — see StatusBar).
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const apply = (ev: ControlEvent): void => {
      if (ev.type === "status") {
        setLocal({ state: ev.state, pending: ev.pending, inflight: ev.inflight });
      }
    };

    onControlEvent(apply).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    refresh();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const nowMs = Date.now();
  const alerts = snapshot?.alerts ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Sync &amp; Health</CardTitle>
            <CardDescription>
              local backlog · server fleet view (machines, connectors, alerts)
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="border-input bg-background hover:bg-accent disabled:opacity-40 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Local sidecar backlog */}
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <Stat label="local state" value={local.state} />
          <Stat label="pending" value={local.pending} />
          <Stat label="inflight" value={local.inflight} />
        </dl>

        {/* Server view — degrades gracefully when the admin token is unset / ingest is down. */}
        {serverError ? (
          <div className="text-sm">
            <p className="text-destructive">{serverError}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              The server fleet view needs <code>ADMIN_TOKEN</code> — full Settings land in a later
              slice.
            </p>
          </div>
        ) : snapshot ? (
          <>
            <SummaryRow snapshot={snapshot} />
            <div>
              <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
                Alerts
              </p>
              {alerts.length === 0 ? (
                <p className="text-muted-foreground text-sm">No active alerts.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead>
                      <TableHead>Alert</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Since</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {alerts.map((a, i) => (
                      <TableRow key={`${a.code}:${a.machineId ?? a.connector ?? i}`}>
                        <TableCell>
                          <Badge className={cn(SEVERITY_BADGE[a.severity])}>{a.severity}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">{a.message}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {a.machineName ?? a.connector ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatAgo(a.since, nowMs)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">Loading server view…</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Compact machines/connectors/active-sessions counts (mirrors monitor-view summary). */
function SummaryRow({ snapshot }: { snapshot: LiveMonitorSnapshot }) {
  const counts: Record<MonitorStatus, number> = { online: 0, stale: 0, offline: 0 };
  for (const m of snapshot.machines) counts[m.status]++;
  const totalBacklog = snapshot.machines.reduce((sum, m) => sum + (m.queuePending ?? 0), 0);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Collectors</span>
        <span className="flex items-center gap-1.5 text-sm">
          <Badge className={cn(STATUS_BADGE.online)}>{counts.online} online</Badge>
          {counts.stale > 0 ? (
            <Badge className={cn(STATUS_BADGE.stale)}>{counts.stale} stale</Badge>
          ) : null}
          {counts.offline > 0 ? (
            <Badge className={cn(STATUS_BADGE.offline)}>{counts.offline} offline</Badge>
          ) : null}
        </span>
      </div>
      <Stat label="server backlog" value={totalBacklog} />
      <Stat label="connectors" value={snapshot.connectors.length} />
      <Stat label="active sessions" value={snapshot.activeSessions.length} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className="font-mono text-lg tabular-nums">{value}</span>
    </div>
  );
}
