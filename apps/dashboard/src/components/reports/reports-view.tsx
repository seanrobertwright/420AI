"use client";

import { useState } from "react";
import type { ReportArtifactRow } from "@/lib/types";
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
import { formatDate } from "@/lib/format";
import { ReportCompare } from "@/components/reports/report-compare";
import { ReportMarkdown } from "@/components/reports/report-markdown";

/** Page size — matches the server's default `limit` on GET /v1/reports (13.4). */
const REPORTS_PAGE = 50;

/**
 * Reports list + read + compare (M12; 12.2a list/read, 12.2b compare; M13 13.4 rich
 * markdown + pagination). Client component because selecting a row is local state — no
 * fetch on select: the list endpoint already returns each artifact's `markdown` inline.
 * The server page passes the FIRST page; "Load more" appends further pages through the
 * same-origin `/api/reports` proxy (offset paging, deduped by id). Generation lives on
 * the project/session surfaces (those carry the scope id).
 */
export function ReportsView({ reports: initialReports }: { reports: ReportArtifactRow[] }) {
  const [reports, setReports] = useState(initialReports);
  const [selectedId, setSelectedId] = useState<string | null>(initialReports[0]?.id ?? null);
  const [canLoadMore, setCanLoadMore] = useState(initialReports.length === REPORTS_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const selected = reports.find((r) => r.id === selectedId) ?? null;

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/reports?limit=${REPORTS_PAGE}&offset=${reports.length}`);
      if (!res.ok) {
        setCanLoadMore(false);
        return;
      }
      const page = (await res.json()) as ReportArtifactRow[];
      const seen = new Set(reports.map((r) => r.id));
      setReports([...reports, ...page.filter((r) => !seen.has(r.id))]);
      setCanLoadMore(page.length === REPORTS_PAGE);
    } catch {
      setCanLoadMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageShell
      title="Reports"
      subtitle="Versioned report artifacts (cost-over-time, session autopsy)."
    >
      <div className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
          </CardHeader>
          <CardContent>
            {reports.length === 0 ? (
              <p className="text-muted-foreground text-sm">No reports generated yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Catalog</TableHead>
                    <TableHead>Generated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((r) => (
                    <TableRow
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={cn("cursor-pointer", r.id === selectedId && "bg-muted/60")}
                    >
                      <TableCell className="font-medium">{r.reportType}</TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {r.scopeKind}:{r.scopeId}
                      </TableCell>
                      <TableCell>v{r.version}</TableCell>
                      <TableCell className="space-x-1">
                        {r.catalogVersion ? (
                          <Badge variant="outline" className="text-xs">
                            {r.catalogVersion}
                          </Badge>
                        ) : null}
                        {r.analysisVersion ? (
                          <Badge variant="outline" className="text-xs">
                            {r.analysisVersion}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(r.generatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {canLoadMore ? (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className={cn(
                    "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
                    "border-border hover:bg-muted disabled:opacity-50",
                  )}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {selected ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {selected.reportType}{" "}
                <span className="text-muted-foreground text-sm font-normal">
                  v{selected.version}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ReportMarkdown markdown={selected.markdown} />
            </CardContent>
          </Card>
        ) : null}

        <ReportCompare reports={reports} />
      </div>
    </PageShell>
  );
}
