import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { ProjectsView } from "@/components/projects/projects-view";
import type { ProjectRow } from "@/lib/types";

// Always render fresh server-side; the project list reflects live archive state (D8: the
// admin token is added on this server→ingest hop only and never reaches the browser).
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let projects: ProjectRow[] = [];
  try {
    const res = await fetch(`${ingestUrl()}/v1/projects`, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (res.ok) projects = ((await res.json()) as { projects: ProjectRow[] }).projects;
  } catch {
    /* ingest unreachable — render an empty list rather than crashing the page */
  }
  return <ProjectsView projects={projects} />;
}
