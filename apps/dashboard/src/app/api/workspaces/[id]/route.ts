import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Remap a workspace to a project (M12 12.2b). PATCH `/v1/workspaces/:id {projectId}` →
 * `{id,projectId}` (400 malformed projectId / 404 missing workspace or project, forwarded).
 * The browser's JSON body is forwarded verbatim; the admin bearer is added on the
 * server→ingest hop (D8). `projectId` is chosen from a list client-side so it is a real uuid.
 */
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  return proxyJson(`/v1/workspaces/${id}`, {
    method: "PATCH",
    body,
    contentType: "application/json",
  });
}
