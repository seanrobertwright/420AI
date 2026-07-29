import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { proxyJson } from "@/lib/proxy";
import { SSO_FLOW_COOKIE, SSO_FLOW_MAX_AGE_SECONDS, type SsoFlowState } from "@/lib/sso-flow";

/**
 * M15 15.7 — begin an SSO authorization request and bounce the browser to the provider.
 *
 * `mode=login` (logged out) vs `mode=link` (logged in) is the one thing in this slice easiest to
 * get subtly wrong, so it is stated plainly: `proxyJson` attaches `adminHeaders()` — the CALLER'S
 * SESSION — and a logged-out user has none. So `login` mode calls ingest with a PLAIN fetch, and
 * only `link` mode goes through `proxyJson`. Using the helper for both would make the login button
 * work in every test written by someone already signed in, and fail for every real visitor.
 *
 * The `state` and `codeVerifier` come back from ingest and are stored in ONE short-lived httpOnly
 * cookie. Ingest holds no per-flow server state deliberately (an unauthenticated endpoint that
 * allocated a row per click would be a free write amplifier).
 */
export const dynamic = "force-dynamic";

interface SsoStartResponse {
  authorizeUrl: string;
  state: string;
  codeVerifier?: string;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const q = req.nextUrl.searchParams;
  const mode: SsoFlowState["mode"] = q.get("mode") === "link" ? "link" : "login";
  const inviteToken = q.get("inviteToken") ?? undefined;
  const path = `/v1/auth/sso/${encodeURIComponent(provider)}/start`;
  const body = JSON.stringify(inviteToken ? { inviteToken } : {});

  let started: SsoStartResponse;
  try {
    const res =
      mode === "link"
        ? await proxyJson(path, { method: "POST", body, contentType: "application/json" })
        : await fetch(`${ingestUrl()}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            cache: "no-store",
          });
    if (!res.ok) {
      // An unconfigured provider is a 404 upstream. Bounce back to the page the user came from
      // with a reason rather than rendering a bare JSON error at a URL they navigated to.
      return NextResponse.redirect(new URL("/login?error=sso_unavailable", req.nextUrl));
    }
    started = (await res.json()) as SsoStartResponse;
  } catch {
    return NextResponse.redirect(new URL("/login?error=sso_unavailable", req.nextUrl));
  }

  const flow: SsoFlowState = {
    state: started.state,
    codeVerifier: started.codeVerifier,
    mode,
    next: q.get("next") ?? undefined,
    inviteToken,
  };
  (await cookies()).set(SSO_FLOW_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    // `lax`, NEVER `strict`. The provider returns the user via a top-level CROSS-SITE GET, and a
    // `strict` cookie is not sent on one — `state` would be missing on every real login while
    // working perfectly in any same-site test.
    sameSite: "lax",
    // Scoped to the SSO routes: this cookie carries a PKCE verifier and has no business riding
    // along on every request to the app.
    path: "/api/auth/sso",
    maxAge: SSO_FLOW_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.redirect(started.authorizeUrl);
}
