import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Rebuild the search index (M12 12.2b). POST `/v1/search/reindex` → `ReindexCounts`
 * `{reports,projects,sessions,total}`. A FULL rebuild (can be slow on a big archive) so the
 * client disables the button in-flight. No request body. Admin bearer added on the
 * server→ingest hop (D8).
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  return proxyJson("/v1/search/reindex", { method: "POST" });
}
