"use client";

import { useMemo, useState } from "react";
import type { ReportArtifactRow } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { diffMetrics } from "@/lib/metrics-diff";

/** A comparable group = artifacts sharing (reportType, scopeId) with ≥2 versions. */
interface Group {
  key: string;
  reportType: string;
  scopeKind: string;
  scopeId: string;
  rows: ReportArtifactRow[]; // newest-first (the list arrives newest-first)
}

/** Group artifacts by reportType+scopeId; only groups with ≥2 versions are comparable. */
function comparableGroups(reports: ReportArtifactRow[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const r of reports) {
    const key = `${r.reportType}::${r.scopeId}`;
    const g = byKey.get(key);
    if (g) g.rows.push(r);
    else byKey.set(key, { key, reportType: r.reportType, scopeKind: r.scopeKind, scopeId: r.scopeId, rows: [r] });
  }
  return [...byKey.values()].filter((g) => g.rows.length >= 2);
}

/** Format a numeric delta with an explicit sign; null (incomparable) → em dash. */
function fmtDelta(d: number | null): string {
  if (d === null) return "—";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}`;
}

/**
 * Two-version report compare (M12 12.2b). The headline feature of this slice's reports work:
 * pick a group (same reportType + scopeId), pick version A and B, and see their markdown
 * side-by-side plus a numeric delta table over the `metrics` blob (the compare seam —
 * `diffMetrics` is defensive over the per-reportType `unknown` shape). Comparing across
 * different reportType/scope is deliberately impossible (the diff would be meaningless).
 */
export function ReportCompare({ reports }: { reports: ReportArtifactRow[] }) {
  const groups = useMemo(() => comparableGroups(reports), [reports]);
  const [groupKey, setGroupKey] = useState<string>(groups[0]?.key ?? "");
  const group = groups.find((g) => g.key === groupKey) ?? groups[0] ?? null;

  // Default A = second-newest, B = newest (newest-first list) so the delta reads "since last".
  const [aId, setAId] = useState<string>("");
  const [bId, setBId] = useState<string>("");
  const aRow = group?.rows.find((r) => r.id === aId) ?? group?.rows[1] ?? null;
  const bRow = group?.rows.find((r) => r.id === bId) ?? group?.rows[0] ?? null;

  const deltas = useMemo(
    () => (aRow && bRow ? diffMetrics(aRow.metrics, bRow.metrics) : []),
    [aRow, bRow],
  );

  if (groups.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Compare versions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No comparable reports yet — generate at least two versions of the same report.
          </p>
        </CardContent>
      </Card>
    );
  }

  const versionSelect = "border-border bg-background rounded-md border px-2 py-1 text-xs";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare versions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <select
            value={group?.key ?? ""}
            onChange={(e) => {
              setGroupKey(e.target.value);
              setAId("");
              setBId("");
            }}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Report group"
          >
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.reportType} · {g.scopeKind}:{g.scopeId} ({g.rows.length})
              </option>
            ))}
          </select>
          {group ? (
            <>
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                A
                <select
                  value={aRow?.id ?? ""}
                  onChange={(e) => setAId(e.target.value)}
                  className={versionSelect}
                  aria-label="Version A"
                >
                  {group.rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version} · {formatDate(r.generatedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                B
                <select
                  value={bRow?.id ?? ""}
                  onChange={(e) => setBId(e.target.value)}
                  className={versionSelect}
                  aria-label="Version B"
                >
                  {group.rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version} · {formatDate(r.generatedAt)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>

        {aRow && bRow ? (
          <div className="space-y-6">
            {/* Numeric delta table (the metrics seam) */}
            {deltas.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No numeric metrics to diff — compare the markdown below.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead>A (v{aRow.version})</TableHead>
                    <TableHead>B (v{bRow.version})</TableHead>
                    <TableHead>Δ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deltas.map((d) => (
                    <TableRow key={d.key}>
                      <TableCell className="font-mono text-xs">{d.key}</TableCell>
                      <TableCell>{d.a ?? "—"}</TableCell>
                      <TableCell>{d.b ?? "—"}</TableCell>
                      <TableCell
                        className={cn(
                          d.delta !== null && d.delta > 0 && "text-amber-400",
                          d.delta !== null && d.delta < 0 && "text-emerald-400",
                        )}
                      >
                        {fmtDelta(d.delta)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* Markdown side-by-side */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <div className="text-muted-foreground mb-2 text-xs uppercase tracking-widest">
                  A · v{aRow.version}
                </div>
                <pre className="bg-muted/40 max-h-96 overflow-auto rounded-md p-4 text-xs whitespace-pre-wrap">
                  {aRow.markdown}
                </pre>
              </div>
              <div>
                <div className="text-muted-foreground mb-2 text-xs uppercase tracking-widest">
                  B · v{bRow.version}
                </div>
                <pre className="bg-muted/40 max-h-96 overflow-auto rounded-md p-4 text-xs whitespace-pre-wrap">
                  {bRow.markdown}
                </pre>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
