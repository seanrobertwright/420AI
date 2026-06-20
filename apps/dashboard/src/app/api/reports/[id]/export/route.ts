import type { NextRequest } from "next/server";
import { proxyStream } from "@/lib/proxy";

/**
 * Report-artifact export download (M12 12.2b). GET `/v1/reports/:id/export?format=md|json`.
 * `proxyStream` adds the admin bearer on the server→ingest hop (D8), forwards the download
 * headers, and threads `req.signal` so a client disconnect cancels the upstream fetch. A
 * malformed/unknown id → 404 (forwarded). Already redacted server-side.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyStream(`/v1/reports/${id}/export${req.nextUrl.search}`, req.signal);
}
