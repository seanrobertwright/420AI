import { NextResponse, type NextRequest } from "next/server";
import { verifySessionEdge, SESSION_COOKIE } from "@/lib/session";

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
const PUBLIC = ["/login"]; // page paths that never require a session

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The login page + the auth route handlers (login/logout) must stay reachable while logged out.
  if (PUBLIC.some((p) => pathname === p) || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET ?? "";
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
