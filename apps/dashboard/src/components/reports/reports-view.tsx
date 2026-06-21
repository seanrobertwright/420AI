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

/**
 * Reports list + read + compare (M12; 12.2a list/read, 12.2b compare). Client component
 * because selecting a row is local state — no fetch on select: the list endpoint already
 * returns each artifact's `markdown` inline. Markdown is shown as PREFORMATTED text this slice
 * (a rich Markdown/Mermaid renderer is deferred). Generation lives on the project/session
 * surfaces (those carry the scope id); this view adds the two-version Compare (12.2b).
 */
export function ReportsView({ reports }: { reports: ReportArtifactRow[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(reports[0]?.id ?? null);
  const selected = reports.find((r) => r.id === selectedId) ?? null;

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
              <pre className="bg-muted/40 overflow-x-auto rounded-md p-4 text-xs whitespace-pre-wrap">
                {selected.markdown}
              </pre>
            </CardContent>
          </Card>
        ) : null}

        <ReportCompare reports={reports} />
      </div>
    </PageShell>
  );
}
