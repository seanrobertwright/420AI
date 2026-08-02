import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — mint an invitation. POST `/v1/members/invite {email, role}`, `admin`-gated upstream.
 *
 * The body is forwarded with `req.text()` rather than a re-serialized `req.json()`: `proxyJson`
 * takes a `body`/`contentType` pair for exactly this, and re-serializing would silently normalize a
 * payload the upstream schema is entitled to reject (`additionalProperties: false`).
 *
 * The 409 discriminants (already a member / user exists / invite pending) and the 403 ceiling all
 * reach the UI unchanged, because the upstream status is forwarded verbatim.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/members/invite", {
    method: "POST",
    body,
    contentType: "application/json",
    signal: req.signal,
  });
}
