import type { NextRequest } from "next/server";
import { proxyStream } from "@/lib/proxy";

/**
 * Session transcript export download (M12 12.2b). GET
 * `/v1/sessions/:sessionId/transcript/export?format=md|json|jsonl`. This is the only export that
 * decrypts server-side; it redacts each entry before serializing (§18). `proxyStream` adds the
 * admin bearer on the server→ingest hop (D8), forwards download headers, and threads `req.signal`
 * so a client disconnect cancels the upstream fetch. `sessionId` is a connector text id →
 * percent-encoded onto the ingest path.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return proxyStream(
    `/v1/sessions/${encodeURIComponent(sessionId)}/transcript/export${req.nextUrl.search}`,
    req.signal,
  );
}
