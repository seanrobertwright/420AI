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
    if (!res.ok) {
      // LOGGED, not merely degraded. Returning an empty list makes an unreachable archive look
      // exactly like "no provider is configured" — SSO simply vanishes from the login page with
      // nothing anywhere saying why. That is the shape CLAUDE.md warns about: a best-effort path
      // is the worst place to lose a failure, because it is designed not to complain.
      console.error(`[dashboard] sso providers fetch failed: ingest returned ${res.status}`);
      return NextResponse.json({ providers: [] });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    // An unreachable archive must not break the password form beside these buttons — render none,
    // but say so on the server.
    console.error("[dashboard] sso providers fetch failed: ingest unreachable", err);
    return NextResponse.json({ providers: [] });
  }
}
