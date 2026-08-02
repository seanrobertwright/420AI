import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/** M15 15.10 — revoke a pending invitation. DELETE `/v1/invites/:id` → 204 (404 if not pending). */
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/invites/${id}`, { method: "DELETE" });
}
