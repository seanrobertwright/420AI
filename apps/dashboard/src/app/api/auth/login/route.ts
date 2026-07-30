import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { SESSION_COOKIE, sessionConfigError } from "@/lib/session";
import { MFA_CHALLENGE_COOKIE, mfaChallengeCookieOptions } from "@/lib/mfa-flow";

/**
 * M12 12.3 login proxy. Forwards {email,password} to ingest's POST /v1/auth/login; on success it
 * stores the returned HMAC session token in an httpOnly cookie (the browser never sees the token
 * in JS — D8). `cookies().set()` is only allowed in a Route Handler / Server Action (not a Server
 * Component) — that's why login + logout are route handlers.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // D.3: fail LOUDLY if SESSION_SECRET is missing. Without it the cookie we are about to set can
  // never be verified by the middleware, so login would appear to succeed (200) yet bounce straight
  // back to /login. Surface a clear 500 (shown on the login form) instead of that silent loop.
  const cfgErr = sessionConfigError();
  if (cfgErr) {
    console.error(`[dashboard] ${cfgErr}`);
    return NextResponse.json({ error: cfgErr }, { status: 500 });
  }
  const body = await req.text(); // {email,password} forwarded verbatim
  let res: Response;
  try {
    res = await fetch(`${ingestUrl()}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
  if (!res.ok) {
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  const payload = (await res.json()) as
    | { token: string; expiresAt: string }
    | { mfaRequired: true; challenge: string; expiresAt: string };

  // M15 15.8 — THE SECOND-FACTOR BRANCH. An enrolled user's login returns a challenge, not a token,
  // and NO SESSION COOKIE IS SET here: the login is not complete until `/api/auth/mfa/verify`
  // exchanges the challenge for a session. The challenge goes into its own path-scoped httpOnly
  // cookie so client JS never holds it (D8) and the form only learns *that* a second step is needed.
  //
  // Note the ordering: the `sessionConfigError()` guard above still runs FIRST, deliberately. A
  // deployment with no `SESSION_SECRET` must fail loudly at step one rather than let the user type a
  // code into step two and fail there — the same D.3 reasoning, one step later.
  if ("mfaRequired" in payload) {
    (await cookies()).set(
      MFA_CHALLENGE_COOKIE,
      JSON.stringify({ challenge: payload.challenge }),
      mfaChallengeCookieOptions(),
    );
    return NextResponse.json({ mfaRequired: true });
  }

  const { token, expiresAt } = payload;
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  return NextResponse.json({ ok: true });
}
