import { emptyMonitorSnapshot, type LiveMonitorSnapshot } from "@420ai/shared";
import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { MachinesView } from "@/components/machines/machines-view";
import type { WorkspaceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function MachinesPage() {
  const now = new Date();
  let snapshot: LiveMonitorSnapshot = emptyMonitorSnapshot(now.toISOString());
  let workspaces: WorkspaceRow[] = [];
  try {
    const [snapRes, wsRes] = await Promise.all([
      fetch(`${ingestUrl()}/v1/monitor`, { headers: adminHeaders(), cache: "no-store" }),
      fetch(`${ingestUrl()}/v1/workspaces`, { headers: adminHeaders(), cache: "no-store" }),
    ]);
    if (snapRes.ok) snapshot = (await snapRes.json()) as LiveMonitorSnapshot;
    if (wsRes.ok) workspaces = ((await wsRes.json()) as { workspaces: WorkspaceRow[] }).workspaces;
  } catch {
    /* ingest unreachable — render empty tables */
  }
  // A request-time snapshot (not a live ticker — live updates are the Monitor's job): the
  // relative "N ago" labels are computed once from the server clock at render.
  return <MachinesView machines={snapshot.machines} workspaces={workspaces} nowMs={now.getTime()} />;
}
