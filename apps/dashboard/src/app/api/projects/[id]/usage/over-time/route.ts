import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Usage over time (M12 12.2a). GET `/v1/projects/:id/usage/over-time?bucket=day|week` →
 * `UsageOverTimeRow[]`. Forwards the `bucket` querystring verbatim (ingest validates it).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/projects/${id}/usage/over-time${req.nextUrl.search}`);
}
