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
import { formatAgo } from "@/lib/format";
import { AlertsPanel } from "@/components/monitor/alerts-panel";
import { CaptureHealthPanel } from "@/components/monitor/capture-health-panel";

const STATUS_BADGE: Record<MonitorStatus, string> = {
  online: "border-transparent bg-emerald-500/15 text-emerald-400",
  stale: "border-transparent bg-amber-500/15 text-amber-400",
  offline: "border-transparent bg-destructive/15 text-destructive",
};

/** theGridCN DataCard status maps from our derived MonitorStatus. */
function dataCardStatus(s: MonitorStatus): "active" | "inactive" | "alert" {
  return s === "online" ? "active" : s === "stale" ? "inactive" : "alert";
}

export function MonitorView({ snapshot, nowMs }: { snapshot: LiveMonitorSnapshot; nowMs: number }) {
  const { machines, connectors, activeSessions } = snapshot;
  const counts: Record<MonitorStatus, number> = { online: 0, stale: 0, offline: 0 };
  for (const m of machines) counts[m.status]++;
  const totalBacklog = machines.reduce((sum, m) => sum + (m.queuePending ?? 0), 0);
  const anyBacklogHigh = machines.some((m) => m.backlogHigh);

  return (
    <div className="space-y-8">
      {/* Operational alerts (M10 3c) — the persisted firing history, ranked critical-first, at the top. */}
      <AlertsPanel firings={snapshot.alertFirings} nowMs={nowMs} />

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
          fields={[
            {
              label: "Backlog high",
              value: anyBacklogHigh ? "YES" : "no",
              highlight: anyBacklogHigh,
            },
          ]}
        />
        <DataCard
          title={`${activeSessions.length}`}
          subtitle="Active sessions"
          status={activeSessions.length > 0 ? "active" : "inactive"}
          // M16 16.3: labelled "Connectors seen", NOT "Connectors". This count comes from
          // `connectorHealth`, a GROUP BY over OBSERVED events, so it can only ever include
          // connectors that already produced something — a broken or disabled one is absent. The
          // Capture health panel below reports the DECLARED inventory and will legitimately show a
          // different, larger number. Two connector counts on one screen is the "which number do I
          // believe?" problem D-16.3-1 refuses to create, so the label names which question this
          // one answers rather than leaving the reader to reconcile them.
          fields={[{ label: "Connectors seen", value: String(connectors.length) }]}
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
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        ({m.queueInflight ?? 0} in-flight)
                      </span>
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

      {/* M16 16.3 — replaces the old Connectors card, which was a projection over OBSERVED events
          and so could only list connectors that had already produced something. A connector that was
          enabled but BROKEN emitted nothing and had no row at all — indistinguishable from disabled,
          and from healthy-on-a-quiet-day. This panel joins the collector's DECLARED inventory
          against the observation, so every connector appears with an explicit state. */}
      <CaptureHealthPanel nowMs={nowMs} />

      {/* Active sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {activeSessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No sessions active in the last 15 minutes.
            </p>
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
                    <TableCell className="text-muted-foreground">
                      {formatAgo(s.lastEventAt, nowMs)}
                    </TableCell>
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
