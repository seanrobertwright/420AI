import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Generate a project AI interpretation (M12 12.2b). POST `/v1/projects/:id/interpretations`
 * → 201 ReportArtifactRow. This calls a **billable** provider, so the client gates it behind
 * a confirm + in-flight disable. The proxy FORWARDS the upstream status so the UI can tell
 * 503 (provider not configured) from 502 (provider error) from 404 (empty/unknown project).
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  return proxyJson(`/v1/projects/${id}/interpretations`, {
    method: "POST",
    body,
    contentType: "application/json",
  });
}
