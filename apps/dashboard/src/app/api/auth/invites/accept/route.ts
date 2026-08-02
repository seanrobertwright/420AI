import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { SESSION_COOKIE, sessionConfigError } from "@/lib/session";

/**
 * M15 15.10 — PUBLIC invite ACCEPT proxy, and the reason the whole onboarding path finally works.
 * POST `{token, password}` → ingest creates the user + exactly one membership and returns
 * `{token, expiresAt}` — the same shape login returns — which this route stores in the httpOnly
 * session cookie so the new colleague lands LOGGED IN.
 *
 * A ROUTE HANDLER RATHER THAN A SERVER COMPONENT because `cookies().set()` is legal only in a Route
 * Handler or Server Action. `api/auth/login/route.ts` records the same constraint, and this file is
 * deliberately a near-copy of it.
 *
 * NOT `proxyJson`/`adminHeaders()` — see the sibling preview route: the caller has no session. And
 * the `/api/auth/` prefix is what keeps `middleware.ts` from redirecting this unauthenticated POST
 * to `/login`.
 *
 * THERE IS NO MFA BRANCH TO HANDLE, and login's must not be copied here. A user who was created a
 * millisecond ago cannot have a second factor, and ingest calls `mintSession` directly rather than
 * `mintSessionOrChallenge` on this path, so the payload is always `{token, expiresAt}`.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // D.3, FIRST, exactly as login does it: without SESSION_SECRET the cookie set below can never be
  // verified by the middleware, so the accept would return 200 and then bounce the brand-new user
  // straight to a login page they have no password history with. Fail loudly instead.
  const cfgErr = sessionConfigError();
  if (cfgErr) {
    console.error(`[dashboard] ${cfgErr}`);
    return NextResponse.json({ error: cfgErr }, { status: 500 });
  }
  const body = await req.text(); // {token, password} forwarded verbatim
  let res: Response;
  try {
    res = await fetch(`${ingestUrl()}/v1/auth/invites/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
  // 409 (an account already exists for this address), 410 (the token expired mid-flight) and 429
  // (rate limited) all reach the form unchanged — each has its own copy there.
  if (!res.ok) {
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  // `{ok: true}` and never the token: the browser must not hold a credential in JS (D8).
  return NextResponse.json({ ok: true });
}
