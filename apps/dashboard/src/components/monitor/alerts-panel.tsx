"use client";

import { useState } from "react";
import type { AlertFiring, AlertSeverity } from "@420ai/shared";
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

/** Severity → badge colors, mirroring STATUS_BADGE in monitor-view.tsx. */
const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "border-transparent bg-destructive/15 text-destructive",
  warning: "border-transparent bg-amber-500/15 text-amber-400",
  info: "border-transparent bg-sky-500/15 text-sky-400",
};

/**
 * The M10 3c persisted Alert Firings panel (PRD §20). Renders the firing history the
 * server reconciled on read — each row carries when it first fired and when it was last
 * seen. An OPEN, unacked firing gets an Ack button that POSTs the same-origin proxy
 * (the admin token stays server-side, D8); the next SSE snapshot (≤3 s) carries
 * `ackedAt`. Critical-first ordering + the open→acked→resolved precedence are the
 * server's responsibility; this just renders top-down.
 */
export function AlertsPanel({ firings, nowMs }: { firings: AlertFiring[]; nowMs: number }) {
  // Optimistic local set of acking ids so the button greys immediately (the reconciled
  // snapshot then carries the real ackedAt and this can be ignored).
  const [acking, setAcking] = useState<Set<string>>(new Set());

  const dropOptimistic = (id: string): void =>
    setAcking((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  async function ack(id: string): Promise<void> {
    setAcking((prev) => new Set(prev).add(id));
    try {
      // fetch resolves (does NOT reject) on a 4xx/5xx — check res.ok so a failed ack
      // (proxy 502 / ingest 404) reverts the optimistic flag instead of lying "acked".
      const res = await fetch(`/api/alerts/firings/${id}/ack`, { method: "POST" });
      if (!res.ok) dropOptimistic(id);
      // On success the next SSE snapshot (≤3 s) carries ackedAt — the source of truth.
    } catch {
      dropOptimistic(id);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
      </CardHeader>
      <CardContent>
        {firings.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active alerts.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Alert</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>First fired</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {firings.map((f) => {
                const resolved = f.status === "resolved";
                const acked = f.ackedAt !== null || acking.has(f.id);
                return (
                  <TableRow key={f.id} className={cn(resolved && "opacity-50")}>
                    <TableCell>
                      <Badge className={cn(SEVERITY_BADGE[f.severity])}>{f.severity}</Badge>
                    </TableCell>
                    <TableCell className={cn("font-medium", resolved && "line-through")}>
                      {f.message}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {f.machineName ?? f.connector ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAgo(f.firstFiredAt, nowMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAgo(f.lastSeenAt, nowMs)}
                    </TableCell>
                    <TableCell>
                      {resolved ? (
                        <span className="text-muted-foreground text-xs">resolved</span>
                      ) : acked ? (
                        <span className="text-muted-foreground text-xs">acked</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void ack(f.id)}
                          className={cn(
                            "rounded-md border px-2.5 py-1 text-xs font-medium",
                            "border-border hover:bg-muted transition-colors",
                          )}
                        >
                          Ack
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
