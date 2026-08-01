import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { SESSION_COOKIE, sessionConfigError } from "@/lib/session";
import { MFA_CHALLENGE_COOKIE, MFA_CHALLENGE_PATH, parseMfaFlow } from "@/lib/mfa-flow";

/**
 * M15 15.8 — the second half of a login: exchange the stored challenge plus a presented code for a
 * session cookie. Structurally the twin of `api/auth/login/route.ts`, and UNAUTHENTICATED by
 * necessity — the caller has no session yet, which is the whole point of the endpoint.
 *
 * THE CHALLENGE COMES FROM THE COOKIE, NEVER FROM THE REQUEST BODY. The browser never holds it (it is
 * `httpOnly`), so client JS has nothing to send; and if the body could carry one, this route would
 * accept a challenge minted for somebody else's login — turning a stolen challenge into a session
 * without the attacker ever having to plant a cookie. The body carries only the code.
 *
 * A PLAIN `fetch`, not `proxyJson`: `proxyJson` attaches the caller's session bearer, and by
 * definition there is none.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // The same D.3 loud-failure guard the login proxy carries: without SESSION_SECRET the cookie we are
  // about to set can never be verified by the middleware, so this would appear to succeed (200) and
  // bounce straight back to /login.
  const cfgErr = sessionConfigError();
  if (cfgErr) {
    console.error(`[dashboard] ${cfgErr}`);
    return NextResponse.json({ error: cfgErr }, { status: 500 });
  }

  const jar = await cookies();
  const flow = parseMfaFlow(jar.get(MFA_CHALLENGE_COOKIE)?.value);
  if (!flow) {
    // No challenge in flight — the user waited out the cookie, or arrived here directly. 401 so the
    // form shows "start again" rather than silently failing.
    return NextResponse.json(
      { error: "no challenge in progress", reason: "expired" },
      { status: 401 },
    );
  }

  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (typeof code !== "string" || code.length < 6) {
    return NextResponse.json({ error: "a code is required" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${ingestUrl()}/v1/auth/mfa/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: flow.challenge, code }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }

  if (!res.ok) {
    // THE CHALLENGE COOKIE IS DELIBERATELY LEFT IN PLACE on 401/429, and that is the opposite of the
    // SSO callback's delete-immediately rule — because the situations are opposite. An authorization
    // code is single-use and a survivor is a replay window; a challenge is EXPECTED to be presented
    // more than once (a mistyped digit, a code that rolled over mid-submit), and ingest bounds the
    // retries itself with the per-user lockout and the signed 5-minute `exp`. Dropping it here would
    // force a full re-login for one typo while adding no security the server does not already provide.
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  // WITH THE PATH. `jar.delete(name)` defaults to `Path=/` and would not touch a cookie stored at
  // `/api/auth/mfa` — the 15.7 bug, documented at length in `lib/mfa-flow.ts`. The challenge is spent
  // now (its code was consumed server-side), so leaving it behind would be dead weight the browser
  // keeps sending.
  jar.delete({ name: MFA_CHALLENGE_COOKIE, path: MFA_CHALLENGE_PATH });
  return NextResponse.json({ ok: true });
}
