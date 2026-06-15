import type { OperationalAlert, AlertSeverity } from "@420ai/shared";
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

/** Severity → badge colors, mirroring STATUS_BADGE in monitor-view.tsx. */
const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "border-transparent bg-destructive/15 text-destructive",
  warning: "border-transparent bg-amber-500/15 text-amber-400",
  info: "border-transparent bg-sky-500/15 text-sky-400",
};

/**
 * The M10 Operational Alerts panel (PRD §20). Presentational — renders the alerts the
 * server already derived (deriveAlerts) and carried on the snapshot. Critical-first
 * ordering is the server's responsibility; this just renders top-down.
 */
export function AlertsPanel({ alerts, nowMs }: { alerts: OperationalAlert[]; nowMs: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
      </CardHeader>
      <CardContent>
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
                  <TableCell className="text-muted-foreground">{formatAgo(a.since, nowMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
