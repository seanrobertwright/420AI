import { NextResponse, type NextRequest } from "next/server";
import { verifySessionEdge, SESSION_COOKIE, sessionConfigError } from "@/lib/session";
import { isPublicPath } from "@/lib/public-paths";

/**
 * M12 12.3 login gate. Runs on the Edge runtime: verifies the `ai_session` cookie's HMAC
 * (via `crypto.subtle` in lib/session.ts — NOT node:crypto, which is unavailable on Edge) and
 * redirects to /login when the session is missing/invalid/expired. SESSION_SECRET must be set
 * in the DASHBOARD env and must MATCH the ingest signer's secret (else even a fresh cookie
 * fails to verify → fail-closed redirect to /login).
 *
 * `request.cookies.get()` is SYNC in middleware (distinct from the ASYNC `cookies()` from
 * next/headers used in Server Components / Route Handlers — don't mix them up).
 */
/**
 * WHICH PAGE PATHS NEVER REQUIRE A SESSION lives in `lib/public-paths.ts`, not here.
 *
 * M15 15.10 moved it, for one reason: `/invite/<token>` is a DYNAMIC path, and the old inline check
 * matched by exact equality — so an invited colleague would have been bounced to
 * `/login?next=/invite/<token>` with a one-time token in the query string of a URL they cannot use.
 * That is the same trap `/login/mfa` fell into in 15.8, and it is the highest-risk line in the
 * slice, so the decision had to become a pure function a unit test could drive without faking a
 * `NextRequest`. See that file for the exact-vs-prefix argument and for why `/login` deliberately
 * gets no prefix entry.
 */

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The login page, the invite-acceptance page + the auth route handlers (login/logout/invite)
  // must stay reachable while logged out.
  if (isPublicPath(pathname) || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET ?? "";
  // D.3: a present cookie that can't be verified because the secret is missing is a misconfig, not a
  // logged-out user — log it loudly (server console) so the cause is obvious instead of a silent loop.
  if (token && !secret) console.error(`[dashboard] ${sessionConfigError()}`);
  if (token && secret && (await verifySessionEdge(token, secret))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Gate everything except Next internals + static assets (and the public paths handled above).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
