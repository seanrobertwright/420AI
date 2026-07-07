"use client";

import { useState } from "react";
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
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { ProjectCreate } from "@/components/projects/project-create";

/** Page size — matches the server's default `limit` on GET /v1/projects (13.4). */
const PROJECTS_PAGE = 50;

/**
 * Projects list (M12; 12.2a list, 12.2b create form, M13 13.4 pagination). Client
 * component: the page server-fetches the FIRST page; "Load more" appends further pages
 * through the same-origin `/api/projects` proxy (offset paging, deduped by id — the
 * admin token stays server-side, D8). Each row links to the per-project detail.
 */
export function ProjectsView({ projects: initialProjects }: { projects: ProjectRow[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [canLoadMore, setCanLoadMore] = useState(initialProjects.length === PROJECTS_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/projects?limit=${PROJECTS_PAGE}&offset=${projects.length}`);
      if (!res.ok) {
        setCanLoadMore(false);
        return;
      }
      const page = ((await res.json()) as { projects: ProjectRow[] }).projects;
      const seen = new Set(projects.map((p) => p.id));
      setProjects([...projects, ...page.filter((p) => !seen.has(p.id))]);
      setCanLoadMore(page.length === PROJECTS_PAGE);
    } catch {
      setCanLoadMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

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
                      <TableCell className="text-muted-foreground">
                        {formatDate(p.createdAt)}
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
      </div>
    </PageShell>
  );
}
