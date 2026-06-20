import { ingestUrl, adminHeaders } from "@/lib/ingest";
import type {
  ProjectGitMetadata,
  SessionProjection,
  UsageByModelRow,
  UsageOverTimeRow,
  UsageTotals,
} from "@420ai/shared";
import type { ProjectEventSummary, ProjectRow } from "@/lib/types";
import { ProjectDetailView } from "@/components/projects/project-detail-view";

export const dynamic = "force-dynamic";

/** GET ingest JSON on the server→ingest hop (D8), returning a fallback on any non-200/throw. */
async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, { headers: adminHeaders(), cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The projects list is the existence authority: a well-formed-but-unknown uuid returns
  // ZEROED projections (200), not 404 — so membership in the list, not a projection status,
  // is what tells "real project" from "valid uuid that doesn't exist". It also gives the name.
  const [{ projects }, summary, usage, byModel, overTime, git, sessions] = await Promise.all([
    getJson<{ projects: ProjectRow[] }>("/v1/projects", { projects: [] }),
    getJson<ProjectEventSummary>(`/v1/projects/${id}/summary`, { eventCount: 0, lastActivity: null }),
    getJson<UsageTotals>(`/v1/projects/${id}/usage`, {
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, tool: 0, total: 0 },
      costUsd: 0,
      costConfidence: "unknown",
      eventCount: 0,
    }),
    getJson<UsageByModelRow[]>(`/v1/projects/${id}/usage/by-model`, []),
    getJson<UsageOverTimeRow[]>(`/v1/projects/${id}/usage/over-time`, []),
    getJson<ProjectGitMetadata>(`/v1/projects/${id}/git`, { branches: [], projectPaths: [] }),
    getJson<SessionProjection[]>(`/v1/projects/${id}/sessions`, []),
  ]);

  const project = projects.find((p) => p.id === id) ?? null;

  return (
    <ProjectDetailView
      id={id}
      project={project}
      summary={summary}
      usage={usage}
      byModel={byModel}
      overTime={overTime}
      git={git}
      sessions={sessions}
    />
  );
}
