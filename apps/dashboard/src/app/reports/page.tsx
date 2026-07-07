import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { ReportsView } from "@/components/reports/reports-view";
import type { ReportArtifactRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  let reports: ReportArtifactRow[] = [];
  try {
    // GET /v1/reports → a BARE array (newest-first server-side), each row carrying its markdown.
    // First page only (13.4): the view's "Load more" pager appends further pages.
    const res = await fetch(`${ingestUrl()}/v1/reports?limit=50`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    if (res.ok) reports = (await res.json()) as ReportArtifactRow[];
  } catch {
    /* ingest unreachable — render an empty list */
  }
  return <ReportsView reports={reports} />;
}
