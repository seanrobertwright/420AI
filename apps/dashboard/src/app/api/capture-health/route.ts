import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M16 16.3 — same-origin proxy for `GET /v1/capture-health`.
 *
 * The browser never holds `ADMIN_TOKEN`; `proxyJson` adds the bearer on the server→ingest hop only.
 * `request.signal` is threaded so a client disconnect cancels the upstream fetch rather than leaving
 * it running to completion (CLAUDE.md's long-lived-resource rule).
 *
 * `proxyJson` forwards the upstream STATUS verbatim, which is what lets the panel distinguish a 403
 * from a 502 — and that distinction matters more here than almost anywhere else in the product: a
 * plausible-looking empty scorecard is a lie about capture health, which is the one thing this
 * surface exists to tell the truth about.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return proxyJson("/v1/capture-health", { signal: request.signal });
}
