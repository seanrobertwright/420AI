import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Redacted full-text search (M12 12.2a / 12.1). GET `/v1/search?q=&type=&projectId=&limit=` →
 * `SearchResults`. Forwards the querystring verbatim; ingest validates `q` (minLength 1 → 400)
 * and guards `projectId` (malformed → 404). Hits are already redacted server-side (PRD §18.1).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyJson(`/v1/search${req.nextUrl.search}`);
}
