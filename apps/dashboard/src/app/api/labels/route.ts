import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M16 16.2 — the org's outcome labels for the `/labels` review table. GET
 * `/v1/labels?status=&outcome=&taskType=&sessionId=&limit=&offset=`, `viewer`-gated upstream.
 *
 * The querystring is PASSED THROUGH rather than reconstructed, so the filter set is owned in one
 * place (`listOutcomeLabelsQuerySchema`) instead of being mirrored here and drifting.
 *
 * NOT REDACTED, and that is correct: this is an authenticated in-app read by the label's own org,
 * the same asymmetry `GET /v1/reports/:id` has with its `/export` sibling (D-16.1-7). The
 * redacting path is `api/labels/export`.
 *
 * THERE IS DELIBERATELY NO `api/labels/queue` PROXY. The queue is the desktop panel's surface
 * (D-16.2-3); the dashboard reviews labels that exist and never nags about ones that do not. Do
 * not add one "for symmetry" — a second nagging surface is the thing §4.3 forbids.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyJson(`/v1/labels${req.nextUrl.search}`, { signal: req.signal });
}
