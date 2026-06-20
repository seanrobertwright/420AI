import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/** Fetch one report artifact (M12 12.2a). GET `/v1/reports/:id` → `ReportArtifactRow` (404 if absent). */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/reports/${id}`);
}
