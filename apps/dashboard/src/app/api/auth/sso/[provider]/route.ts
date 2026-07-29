import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.7 — DELETE /api/auth/sso/:provider, the unlink hop for the Settings surface.
 *
 * Authenticated, so `proxyJson`. Ingest answers 409 `last_credential` when this would leave the
 * account with no way in at all; the status and body are forwarded verbatim so the client island
 * can render that specific copy rather than a generic failure.
 *
 * Next 16: the dynamic route's `params` is a Promise and MUST be awaited (matching
 * `api/alerts/firings/[id]/ack/route.ts`).
 */
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return proxyJson(`/v1/auth/sso/${encodeURIComponent(provider)}`, { method: "DELETE" });
}
