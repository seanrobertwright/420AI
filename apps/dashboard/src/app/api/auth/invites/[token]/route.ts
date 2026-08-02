import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";

/**
 * M15 15.10 — PUBLIC invite PREVIEW proxy. GET `/v1/auth/invites/:token` →
 * `{email, role, orgName, expiresAt}`, or 410 + `reason` for an unknown / revoked / accepted /
 * expired token.
 *
 * IT DELIBERATELY DOES NOT USE `proxyJson`. That helper calls `adminHeaders()`, which reads the
 * session cookie — and the caller of this route has no session, which is the entire point: they are
 * an invited colleague who does not have an account yet. Attaching a bearer would be meaningless at
 * best. `routes/auth.ts`'s login proxy has the same shape and the same reason.
 *
 * THE `/api/auth/` PREFIX IS LOAD-BEARING, NOT COSMETIC. `middleware.ts` exempts
 * `pathname.startsWith("/api/auth/")` from the session gate; placed anywhere else (say
 * `/api/invites/[token]`), the middleware would redirect this unauthenticated GET to `/login` and
 * the invite page would fail with no useful error.
 *
 * The upstream status is forwarded verbatim because the 410's `reason` is what the page renders as
 * its terminal state ("this invitation has already been used") rather than a generic failure.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let res: Response;
  try {
    res = await fetch(`${ingestUrl()}/v1/auth/invites/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
