import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { SESSION_COOKIE, sessionConfigError } from "@/lib/session";

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
  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  return NextResponse.json({ ok: true });
}
