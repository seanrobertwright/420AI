import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * List report artifacts (M12 12.2a). GET `/v1/reports?type=&scopeId=` → `ReportArtifactRow[]`
 * (a bare array, newest-first server-side). Forwards the optional filters verbatim.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyJson(`/v1/reports${req.nextUrl.search}`);
}
