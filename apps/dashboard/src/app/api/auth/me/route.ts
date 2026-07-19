import { proxyJson } from "@/lib/proxy";

/**
 * Admin identity probe (M14 14.3). GET → /v1/auth/me → { email }. The admin bearer (the
 * logged-in admin's session cookie) is added on the server→ingest hop only (D8); the browser
 * never holds the token. Reachable while logged out (middleware allows /api/auth/*) — ingest
 * returns 401 with no session, which the nav swallows.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/auth/me");
}
