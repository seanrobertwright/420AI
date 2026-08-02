import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — the pending invitations. GET `/v1/invites`, `admin`-gated upstream (an outstanding
 * invite names an address and a rung, which is org administration rather than "who do I work with").
 *
 * A `viewer` therefore gets a 403 here, forwarded verbatim, and the `/team` island treats that as
 * "render no invites panel" rather than as an error — the roster must still load.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyJson("/v1/invites", { signal: req.signal });
}
