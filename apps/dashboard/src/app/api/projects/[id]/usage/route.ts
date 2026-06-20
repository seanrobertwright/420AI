import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/** Per-project usage totals (M12 12.2a). GET `/v1/projects/:id/usage` → `UsageTotals`. */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/projects/${id}/usage`);
}
