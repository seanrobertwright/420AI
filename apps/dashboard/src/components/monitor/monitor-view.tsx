import type { LiveMonitorSnapshot, MonitorStatus } from "@420ai/shared";
import { DataCard } from "@/components/data-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AlertsPanel } from "@/components/monitor/alerts-panel";

/** Honest relative time (PRD §10.1.1) — computed from an ISO ts + an injected now (ms). */
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

const STATUS_BADGE: Record<MonitorStatus, string> = {
  online: "border-transparent bg-emerald-500/15 text-emerald-400",
  stale: "border-transparent bg-amber-500/15 text-amber-400",
  offline: "border-transparent bg-destructive/15 text-destructive",
};

/** theGridCN DataCard status maps from our derived MonitorStatus. */
function dataCardStatus(s: MonitorStatus): "active" | "inactive" | "alert" {
  return s === "online" ? "active" : s === "stale" ? "inactive" : "alert";
}

export function MonitorView({
  snapshot,
  nowMs,
}: {
  snapshot: LiveMonitorSnapshot;
  nowMs: number;
}) {
  const { machines, connectors, activeSessions } = snapshot;
  const counts: Record<MonitorStatus, number> = { online: 0, stale: 0, offline: 0 };
  for (const m of machines) counts[m.status]++;
  const totalBacklog = machines.reduce((sum, m) => sum + (m.queuePending ?? 0), 0);
  const anyBacklogHigh = machines.some((m) => m.backlogHigh);

  return (
    <div className="space-y-8">
      {/* Operational alerts (M10) — the most urgent surface, ranked critical-first, at the top. */}
      <AlertsPanel alerts={snapshot.alerts} nowMs={nowMs} />

      {/* Fleet summary — theGridCN DataCard widgets (self-contained 2D, build-verified, D10) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DataCard
          title={`${counts.online} online`}
          subtitle="Collectors"
          status={counts.online > 0 ? "active" : "inactive"}
          fields={[
            { label: "Stale", value: String(counts.stale) },
            { label: "Offline", value: String(counts.offline), highlight: counts.offline > 0 },
          ]}
        />
        <DataCard
          title={`${totalBacklog}`}
          subtitle="Sync backlog (pending)"
          status={anyBacklogHigh ? "alert" : "active"}
          fields={[{ label: "Backlog high", value: anyBacklogHigh ? "YES" : "no", highlight: anyBacklogHigh }]}
        />
        <DataCard
          title={`${activeSessions.length}`}
          subtitle="Active sessions"
          status={activeSessions.length > 0 ? "active" : "inactive"}
          fields={[{ label: "Connectors", value: String(connectors.length) }]}
        />
      </div>

      {/* Machines */}
      <Card>
        <CardHeader>
          <CardTitle>Machines</CardTitle>
        </CardHeader>
        <CardContent>
          {machines.length === 0 ? (
            <p className="text-muted-foreground text-sm">No machines paired yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Backlog</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Last heartbeat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {m.name}
                      <span className="text-muted-foreground ml-2 text-xs">
                        {[m.os, m.hostname].filter(Boolean).join(" · ")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn(STATUS_BADGE[m.status])}>{m.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className={cn(m.backlogHigh && "text-destructive font-semibold")}>
                        {m.queuePending ?? 0}
                      </span>
                      <span className="text-muted-foreground text-xs"> ({m.queueInflight ?? 0} in-flight)</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.collectorVersion ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAgo(m.lastHeartbeatAt ?? m.lastSeenAt, nowMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Connectors */}
      <Card>
        <CardHeader>
          <CardTitle>Connectors</CardTitle>
        </CardHeader>
        <CardContent>
          {connectors.length === 0 ? (
            <p className="text-muted-foreground text-sm">No connector activity yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connector</TableHead>
                  <TableHead>Last event</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Models</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectors.map((c) => (
                  <TableRow key={c.sourceConnector}>
                    <TableCell className="font-medium">{c.sourceConnector}</TableCell>
                    <TableCell className="text-muted-foreground">{formatAgo(c.lastEventAt, nowMs)}</TableCell>
                    <TableCell>{c.eventCount}</TableCell>
                    <TableCell>
                      <span className={cn(c.toolsFailed > 0 && "text-destructive font-semibold")}>
                        {c.toolsFailed}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {c.models.length ? c.models.join(", ") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Active sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {activeSessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No sessions active in the last 15 minutes.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Connector</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Last event</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeSessions.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell className="font-mono text-xs">{s.sessionId}</TableCell>
                    <TableCell>{s.sourceConnector}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {s.projectPath ?? "—"}
                      {s.gitBranch ? ` @ ${s.gitBranch}` : ""}
                    </TableCell>
                    <TableCell>{s.eventCount}</TableCell>
                    <TableCell className="text-muted-foreground">{formatAgo(s.lastEventAt, nowMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
