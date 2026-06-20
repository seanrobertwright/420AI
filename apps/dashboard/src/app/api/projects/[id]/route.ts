import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Rename a project (M12 12.2b). PATCH `/v1/projects/:id {name}` → `{id,name}` (404 on a
 * malformed/unknown id, forwarded). The browser's JSON body is forwarded verbatim; the admin
 * bearer is added on the server→ingest hop (D8). (GET projections live on the nested routes.)
 */
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  return proxyJson(`/v1/projects/${id}`, {
    method: "PATCH",
    body,
    contentType: "application/json",
  });
}
