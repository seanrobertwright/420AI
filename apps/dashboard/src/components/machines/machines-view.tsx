import type { LiveMonitorSnapshot, MonitorStatus } from "@420ai/shared";
import type { WorkspaceRow } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
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

type MachineRow = LiveMonitorSnapshot["machines"][number];

/** Status → badge tint (mirrors STATUS_BADGE in monitor-view.tsx). */
const STATUS_BADGE: Record<MonitorStatus, string> = {
  online: "border-transparent bg-emerald-500/15 text-emerald-400",
  stale: "border-transparent bg-amber-500/15 text-amber-400",
  offline: "border-transparent bg-destructive/15 text-destructive",
};

/**
 * Machines + workspaces (M12 12.2a, read-only). Pure-render Server Component over the live
 * monitor snapshot's `machines` and the workspace mapping. No mutations this slice — token
 * revoke has no endpoint (deferred) and workspace→project remap is 12.2b.
 */
export function MachinesView({
  machines,
  workspaces,
  nowMs,
}: {
  machines: MachineRow[];
  workspaces: WorkspaceRow[];
  nowMs: number;
}) {
  return (
    <PageShell title="Machines" subtitle="Collector health, sync backlog, and workspace mapping.">
      <div className="space-y-8">
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

        <Card>
          <CardHeader>
            <CardTitle>Workspaces</CardTitle>
          </CardHeader>
          <CardContent>
            {workspaces.length === 0 ? (
              <p className="text-muted-foreground text-sm">No workspaces discovered yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Root path</TableHead>
                    <TableHead>Git remote</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspaces.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="font-mono text-xs">{w.rootPath}</TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {w.gitRemote ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {w.gitBranch ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{w.projectId ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatAgo(w.lastSeenAt, nowMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
