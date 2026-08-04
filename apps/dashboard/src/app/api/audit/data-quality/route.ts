import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Generate the org-scoped data-quality audit (M16 16.4). POST
 * `/v1/audit/data-quality {windowDays?,sampleSize?}` → 201 with the new versioned
 * ReportArtifactRow. The browser's JSON body is forwarded verbatim; the bearer is added on the
 * server→ingest hop (D8) and never reaches the browser.
 *
 * No route param, unlike its project sibling: the scope is the authenticated principal's org, so
 * there is no id in the path to forward and none to validate. Non-idempotent (each POST appends a
 * new version) — the client disables the button in-flight.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/audit/data-quality", {
    method: "POST",
    body,
    contentType: "application/json",
    // 15.10's optional signal, threaded here where every pre-15.10 sibling omits it: this is the
    // most expensive JSON hop in the dashboard (it decrypts and re-parses a sample), so a client
    // that navigates away should not leave it running to completion. Safe because the artifact
    // commits only at the very END of generation — an aborted hop cannot leave a half-written
    // report, only an unwritten one.
    signal: req.signal,
  });
}
