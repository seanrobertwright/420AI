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
    // that navigates away should not leave THIS hop's socket open.
    //
    // WHAT IT DOES NOT DO — stated precisely, because the obvious reading is wrong: aborting here
    // cancels the RESPONSE, not the work. Ingest installs no disconnect handling, so
    // `generateDataQualityAuditReport` runs to completion and `insertReportArtifact` COMMITS.
    // `scripts/generate-reports.mjs` states the same mechanic for the same endpoint from the cron
    // side. The user-visible consequence is real and worth knowing: navigate away mid-generation,
    // see no artifact, click Generate again, and two versions now exist for one intended run
    // (generation is deliberately non-idempotent). What IS guaranteed is that the write is a
    // single terminal append, so an aborted hop yields a committed-but-unreported artifact —
    // never a half-written one.
    signal: req.signal,
  });
}
