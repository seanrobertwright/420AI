import { getIngestJson } from "@/lib/ingest";
import { PageShell } from "@/components/page-shell";
import { LabelsView } from "@/components/labels/labels-view";

/**
 * M16 16.2 — `/labels`: review, edit, retract, delete and export the §4.3 outcome labels that 16.1
 * shipped as curl-only endpoints.
 *
 * A Server Component fetches the first page so the table is in the first paint; `LabelsView` owns
 * every subsequent read (the prop is a seed — React ignores a changed prop on a mounted island).
 *
 * AN UNREACHABLE ARCHIVE IS NOT ZERO LABELS, and the lie is MORE dangerous here than on `/team`.
 * There, "0 members" is impossible by construction — the caller is a member of their own org — so
 * the empty table is obviously wrong. Here, "no labels yet" is a PLAUSIBLE state early in the
 * research period, so an operator who saw it during an outage would reasonably conclude their
 * labels were never saved. `getIngestJson` returns null on any non-200 or throw; say what actually
 * happened instead of substituting `[]`.
 */
export const dynamic = "force-dynamic";

interface LabelRow {
  id: string;
  sessionId: string;
  authorUserId: string;
  status: string;
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  confidence: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export default async function LabelsPage() {
  const response = await getIngestJson<{ labels: LabelRow[] }>("/v1/labels?limit=200");

  if (!response) {
    return (
      <PageShell title="Labels">
        <p className="text-muted-foreground text-sm">
          Could not reach the archive. Refresh to try again.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Labels"
      subtitle="What you said happened — the ground truth automatic capture cannot infer."
    >
      <LabelsView labels={response.labels} />
    </PageShell>
  );
}
