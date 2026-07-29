import { NextResponse } from "next/server";
import { ingestUrl } from "@/lib/ingest";

/**
 * M15 15.7 — which SSO providers this deployment configured, so the LOGIN PAGE can render exactly
 * the buttons that can work.
 *
 * A plain `fetch`, NOT `proxyJson`: the caller is logged OUT, so `adminHeaders()` would attach
 * nothing and the helper's value (adding the session bearer) does not apply. Ingest's providers
 * endpoint is unauthenticated for the same reason.
 *
 * A static segment sitting beside `[provider]` — Next resolves static before dynamic, so
 * `/api/auth/sso/providers` reaches this file rather than the provider routes.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${ingestUrl()}/v1/auth/sso/providers`, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ providers: [] });
    return NextResponse.json(await res.json());
  } catch {
    // An unreachable archive must not break the password form beside these buttons — render none.
    return NextResponse.json({ providers: [] });
  }
}
