import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/** Per-project event summary (M12 12.2a). Next 16 → `params` is a Promise (awaited). */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/v1/projects/${id}/summary`);
}
