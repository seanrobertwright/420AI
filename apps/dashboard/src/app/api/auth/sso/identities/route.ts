import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.7 — the caller's linked identities, for the Settings link surface.
 *
 * `proxyJson` HERE (unlike the sibling `providers` route) because this one IS authenticated: the
 * helper reads the httpOnly session cookie and adds the bearer on the server→ingest hop, so the
 * browser never holds a credential (D8).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/auth/sso/identities");
}
