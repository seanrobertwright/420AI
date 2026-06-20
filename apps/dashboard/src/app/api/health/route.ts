import { proxyJson } from "@/lib/proxy";

/**
 * Ingest liveness (M12 12.2b). GET `/v1/health` → `{status,time}`. Same-origin proxy; the admin
 * bearer is added on the server→ingest hop (D8) even though health is open upstream. Used by the
 * (read-only) Settings surface to show "ingest: ok".
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/health");
}
