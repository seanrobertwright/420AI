import { emptyMonitorSnapshot, type LiveMonitorSnapshot } from "@420ai/shared";
import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { MachinesView } from "@/components/machines/machines-view";
import type { ProjectOption } from "@/components/machines/workspace-remap";
import type { ProjectRow, WorkspaceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function MachinesPage() {
  const now = new Date();
  let snapshot: LiveMonitorSnapshot = emptyMonitorSnapshot(now.toISOString());
  let workspaces: WorkspaceRow[] = [];
  let projects: ProjectOption[] = [];
  try {
    // The projects list feeds the workspace-remap picker (real uuids → no malformed 400).
    const [snapRes, wsRes, projRes] = await Promise.all([
      fetch(`${ingestUrl()}/v1/monitor`, { headers: adminHeaders(), cache: "no-store" }),
      fetch(`${ingestUrl()}/v1/workspaces`, { headers: adminHeaders(), cache: "no-store" }),
      fetch(`${ingestUrl()}/v1/projects`, { headers: adminHeaders(), cache: "no-store" }),
    ]);
    if (snapRes.ok) snapshot = (await snapRes.json()) as LiveMonitorSnapshot;
    if (wsRes.ok) workspaces = ((await wsRes.json()) as { workspaces: WorkspaceRow[] }).workspaces;
    if (projRes.ok) {
      const rows = ((await projRes.json()) as { projects: ProjectRow[] }).projects;
      projects = rows.map((p) => ({ id: p.id, name: p.name }));
    }
  } catch {
    /* ingest unreachable — render empty tables */
  }
  // A request-time snapshot (not a live ticker — live updates are the Monitor's job): the
  // relative "N ago" labels are computed once from the server clock at render.
  return (
    <MachinesView
      machines={snapshot.machines}
      workspaces={workspaces}
      projects={projects}
      nowMs={now.getTime()}
    />
  );
}
