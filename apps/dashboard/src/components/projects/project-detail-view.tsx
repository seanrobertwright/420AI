import Link from "next/link";
import type {
  ProjectGitMetadata,
  SessionProjection,
  UsageByModelRow,
  UsageOverTimeRow,
  UsageTotals,
} from "@420ai/shared";
import type { ProjectEventSummary, ProjectRow } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
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
import { formatDate, formatTokens, formatUsd } from "@/lib/format";

/**
 * Per-project detail (M12 12.2a, read-only). Pure-render Server Component: usage tiles
 * (cost/tokens/activity), a by-model table, an over-time list, a sessions table, and the git
 * block. All figures arrive pre-coerced from the M6 projections (numbers + ISO strings) — no
 * re-coercion here. `project === null` (unknown id) renders a friendly not-found state.
 */
export function ProjectDetailView({
  id,
  project,
  summary,
  usage,
  byModel,
  overTime,
  git,
  sessions,
}: {
  id: string;
  project: ProjectRow | null;
  summary: ProjectEventSummary;
  usage: UsageTotals;
  byModel: UsageByModelRow[];
  overTime: UsageOverTimeRow[];
  git: ProjectGitMetadata;
  sessions: SessionProjection[];
}) {
  if (!project) {
    return (
      <PageShell title="Project not found" subtitle={id}>
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No project matches this id.{" "}
            <Link href="/projects" className="text-primary hover:underline">
              Back to projects
            </Link>
            .
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={project.name}
      subtitle={project.gitRemote ?? "no git remote"}
      actions={
        <Link href="/projects" className="text-muted-foreground hover:text-foreground text-sm">
          ← Projects
        </Link>
      }
    >
      <div className="space-y-8">
        {/* Usage tiles */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DataCard
            title={formatUsd(usage.costUsd)}
            subtitle="Total cost"
            status="active"
            fields={[
              { label: "Confidence", value: usage.costConfidence },
              { label: "Events", value: String(usage.eventCount) },
            ]}
          />
          <DataCard
            title={formatTokens(usage.tokens.total)}
            subtitle="Total tokens"
            status="active"
            fields={[
              { label: "Input", value: formatTokens(usage.tokens.input) },
              { label: "Output", value: formatTokens(usage.tokens.output) },
            ]}
          />
          <DataCard
            title={String(summary.eventCount)}
            subtitle="Events"
            status={summary.eventCount > 0 ? "active" : "inactive"}
            fields={[
              { label: "Last activity", value: formatDate(summary.lastActivity) },
              { label: "Sessions", value: String(sessions.length) },
            ]}
          />
        </div>

        {/* Usage by model */}
        <Card>
          <CardHeader>
            <CardTitle>Usage by model</CardTitle>
          </CardHeader>
          <CardContent>
            {byModel.length === 0 ? (
              <p className="text-muted-foreground text-sm">No usage recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byModel.map((m) => (
                    <TableRow key={m.model ?? "—"}>
                      <TableCell className="font-mono text-xs">{m.model ?? "—"}</TableCell>
                      <TableCell>{formatTokens(m.tokens.total)}</TableCell>
                      <TableCell>{formatUsd(m.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Usage over time */}
        <Card>
          <CardHeader>
            <CardTitle>Usage over time</CardTitle>
          </CardHeader>
          <CardContent>
            {overTime.length === 0 ? (
              <p className="text-muted-foreground text-sm">No usage recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overTime.map((b) => (
                    <TableRow key={b.bucket}>
                      <TableCell className="text-muted-foreground">{formatDate(b.bucket)}</TableCell>
                      <TableCell>{formatTokens(b.tokens.total)}</TableCell>
                      <TableCell>{formatUsd(b.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Sessions */}
        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <p className="text-muted-foreground text-sm">No sessions recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Connector</TableHead>
                    <TableHead>Models</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.sessionId}>
                      <TableCell className="font-mono text-xs">{s.sessionId}</TableCell>
                      <TableCell>{s.sourceConnector}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {s.models.length ? s.models.join(", ") : "—"}
                      </TableCell>
                      <TableCell>{s.eventCount}</TableCell>
                      <TableCell>{formatUsd(s.costUsd)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(s.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Git metadata */}
        <Card>
          <CardHeader>
            <CardTitle>Git</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-muted-foreground mb-2 text-xs uppercase tracking-widest">Branches</div>
              {git.branches.length === 0 ? (
                <p className="text-muted-foreground text-sm">—</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {git.branches.map((b) => (
                    <Badge key={b} variant="outline" className="font-mono text-xs">
                      {b}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground mb-2 text-xs uppercase tracking-widest">
                Project paths
              </div>
              {git.projectPaths.length === 0 ? (
                <p className="text-muted-foreground text-sm">—</p>
              ) : (
                <ul className="space-y-1">
                  {git.projectPaths.map((p) => (
                    <li key={p} className="text-muted-foreground font-mono text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
