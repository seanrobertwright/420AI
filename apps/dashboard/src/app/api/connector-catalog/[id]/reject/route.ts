import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Reject a pending connector catalog (M14 14.2). POST `/v1/connector-catalog/:id/reject` → the
 * rejected row. A non-pending/unknown id → 404 (forwarded) → inline error. No request body. The
 * admin bearer is added on the server→ingest hop (D8).
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/connector-catalog/${id}/reject`, { method: "POST" });
}
