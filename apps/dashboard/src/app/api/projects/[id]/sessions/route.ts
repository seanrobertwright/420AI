import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/** Project session list (M12 12.2a). GET `/v1/projects/:id/sessions` → `SessionProjection[]`. */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/projects/${id}/sessions`);
}
