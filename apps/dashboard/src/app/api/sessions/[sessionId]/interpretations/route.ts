import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Generate a session AI interpretation (M12 12.2b). POST
 * `/v1/sessions/:sessionId/interpretations` → 201 ReportArtifactRow. **Billable** provider
 * call → confirm + in-flight disable client-side; the proxy forwards 503/502/404 distinctly.
 * `sessionId` is a connector text id (not a uuid) → percent-encoded onto the ingest path.
 */
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.text();
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/interpretations`, {
    method: "POST",
    body,
    contentType: "application/json",
  });
}
