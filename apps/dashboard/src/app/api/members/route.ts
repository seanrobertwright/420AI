import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — the org roster for `/team`. GET `/v1/members` → `{members: MemberRow[]}`, gated at
 * `viewer` upstream, so a read-only account sees the roster.
 *
 * The browser sends NO auth header; `proxyJson` adds the session bearer on the server→ingest hop
 * (D8). It forwards the upstream status verbatim, which is what lets the page distinguish 403 from
 * 502 rather than collapsing both to "something broke".
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/members");
}
