import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Approve a pending pricing catalog (M12 12.2b). POST `/v1/catalog/:id/approve` → the approved
 * row (atomically supersedes the current active). A non-pending/unknown id → 404 (forwarded) →
 * inline error. No request body. The admin bearer is added on the server→ingest hop (D8).
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/catalog/${id}/approve`, { method: "POST" });
}
