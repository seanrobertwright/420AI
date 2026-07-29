import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { proxyJson } from "@/lib/proxy";
import { safeNext } from "@/lib/safe-next";
import { SESSION_COOKIE, sessionConfigError } from "@/lib/session";
import { parseSsoFlow, SSO_FLOW_COOKIE } from "@/lib/sso-flow";

/**
 * M15 15.7 — the provider's redirect target. Validates `state`, exchanges the code through ingest,
 * and (in `login` mode) sets the session cookie exactly as `api/auth/login/route.ts` does.
 *
 * THE STATE COMPARISON HAPPENS BEFORE ANY INGEST HOP, and the flow cookie is deleted on EVERY
 * path, success or failure — a verifier that survives a failed attempt is a replay window.
 *
 * The redirect URI registered with the provider is this route's own URL, and ingest DERIVES the
 * same string from `APP_BASE_URL` (D-15.7-6). Neither side reads it from the request, which is
 * what stops an authorization code from being steered to a host somebody else controls.
 */
export const dynamic = "force-dynamic";

/** Bounce to the login page with a machine-readable reason the form turns into copy. */
function refuse(req: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}`, req.nextUrl));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const jar = await cookies();
  const flow = parseSsoFlow(jar.get(SSO_FLOW_COOKIE)?.value);
  // Deleted IMMEDIATELY after reading, before any await that could fail — one authorization code,
  // one attempt. Every `return` below therefore leaves no verifier behind.
  jar.delete(SSO_FLOW_COOKIE);

  const q = req.nextUrl.searchParams;
  const code = q.get("code");
  const state = q.get("state");
  // The provider reports user-side refusals (`?error=access_denied`) rather than sending a code.
  if (q.get("error")) return refuse(req, "sso_denied");
  if (!flow || !code || !state) return refuse(req, "sso_state");
  // THE CSRF CHECK. A mismatch means this callback was not started by this browser, so nothing
  // downstream may run — no exchange, no session, no link.
  if (state !== flow.state) return refuse(req, "sso_state");

  const target = flow.mode === "link" ? "link" : "callback";
  const path = `/v1/auth/sso/${encodeURIComponent(provider)}/${target}`;
  const body = JSON.stringify({
    code,
    codeVerifier: flow.codeVerifier,
    // Only ever sent on the login path. Ingest ignores it on `link` anyway (it would silently move
    // or double an existing member's membership), but not sending it says so at both ends.
    ...(flow.mode === "login" && flow.inviteToken ? { inviteToken: flow.inviteToken } : {}),
  });

  if (flow.mode === "link") {
    // Authenticated hop — `proxyJson` attaches the caller's session bearer. A 409 here is
    // `identity_taken`; anything else is a provider or archive problem.
    const res = await proxyJson(path, {
      method: "POST",
      body,
      contentType: "application/json",
    });
    const dest = new URL(safeNext(flow.next ?? "/settings"), req.nextUrl);
    if (!res.ok)
      dest.searchParams.set("ssoError", res.status === 409 ? "identity_taken" : "failed");
    else dest.searchParams.set("ssoLinked", provider);
    return NextResponse.redirect(dest);
  }

  // ── login mode ──────────────────────────────────────────────────────────────────────────────
  // D.3's loud-failure guard, copied from the login route: without SESSION_SECRET the cookie we
  // are about to set can never be verified by the middleware, so the login would appear to
  // succeed and bounce straight back to /login.
  const cfgErr = sessionConfigError();
  if (cfgErr) {
    console.error(`[dashboard] ${cfgErr}`);
    return refuse(req, "config");
  }

  let res: Response;
  try {
    // A PLAIN fetch, not `proxyJson`: this caller is logged OUT by definition, so there is no
    // session bearer to attach and the helper would add nothing.
    res = await fetch(`${ingestUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    return refuse(req, "unreachable");
  }
  if (!res.ok) {
    // Ingest's policy refusals ride back as a typed `reason` (`link_required`, `signup_disabled`,
    // `email_unverified`, `invite_mismatch`), which the login form renders as specific copy —
    // `link_required` in particular needs "sign in and connect it from Settings", or operators
    // file the slice's central behaviour as a bug.
    const reason = await res
      .json()
      .then((b: { reason?: string }) => b?.reason)
      .catch(() => undefined);
    return refuse(req, reason ?? "failed");
  }

  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  return NextResponse.redirect(new URL(safeNext(flow.next), req.nextUrl));
}
