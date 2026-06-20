import Link from "next/link";
import type { ProjectRow } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { ProjectCreate } from "@/components/projects/project-create";

/**
 * Projects list (M12; 12.2a list, 12.2b adds the create form). A Server Component rendering the
 * server-fetched rows as a linked table, with a small `ProjectCreate` client island above it for
 * the mutation. Each row links to the per-project detail (where rename + report generation live).
 */
export function ProjectsView({ projects }: { projects: ProjectRow[] }) {
  return (
    <PageShell title="Projects" subtitle="Software efforts unified across machines by git remote.">
      <div className="space-y-6">
        <ProjectCreate />
        <Card>
          <CardContent className="pt-6">
            {projects.length === 0 ? (
              <p className="text-muted-foreground text-sm">No projects yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Git remote</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        <Link href={`/projects/${p.id}`} className="text-primary hover:underline">
                          {p.name}
                        </Link>
                        {p.archivedAt ? (
                          <span className="text-muted-foreground ml-2 text-xs">(archived)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {p.gitRemote ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(p.createdAt)}</TableCell>
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
