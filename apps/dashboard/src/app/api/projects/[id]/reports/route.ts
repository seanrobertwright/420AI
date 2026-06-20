import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Generate a project cost report (M12 12.2b). POST `/v1/projects/:id/reports {type?,bucket?}`
 * → 201 with the new versioned ReportArtifactRow. The browser's JSON body is forwarded
 * verbatim; the admin bearer is added on the server→ingest hop (D8). Non-idempotent (each
 * POST appends a new version) — the client disables the button in-flight. A malformed/unknown
 * project id → 404 (forwarded).
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  return proxyJson(`/v1/projects/${id}/reports`, {
    method: "POST",
    body,
    contentType: "application/json",
  });
}
