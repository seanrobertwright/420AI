import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — revoke ONE of the caller's own keys. DELETE `/v1/auth/api-keys/:id` → 204.
 *
 * 404 covers "unknown", "already revoked" and "not yours" deliberately upstream, so this route
 * cannot be used to enumerate other people's key ids. The UI says "no longer available", not
 * "not yours".
 */
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/auth/api-keys/${id}`, { method: "DELETE", signal: req.signal });
}
