import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — turn the second factor off. Requires a LIVE code in the body (D-15.8-12), which ingest
 * enforces: a session alone must not be enough, or a stolen session cookie could switch MFA off.
 *
 * Note this proxy adds NO check of its own, deliberately. The requirement lives at ingest, where it
 * cannot be bypassed by a caller who reaches the port directly — a dashboard-side guard would be
 * decoration that implies a protection it does not provide.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyJson("/v1/auth/mfa/disable", {
    method: "POST",
    body: await req.text(),
    contentType: "application/json",
  });
}
