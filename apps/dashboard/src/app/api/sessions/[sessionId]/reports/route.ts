import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Generate a session autopsy report (M12 12.2b). POST `/v1/sessions/:sessionId/reports {type?}`
 * → 201 ReportArtifactRow. `sessionId` is a connector text id (not a uuid) so it is
 * percent-encoded onto the ingest path. Non-idempotent (bumps version) — disabled in-flight.
 */
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.text();
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/reports`, {
    method: "POST",
    body,
    contentType: "application/json",
  });
}
