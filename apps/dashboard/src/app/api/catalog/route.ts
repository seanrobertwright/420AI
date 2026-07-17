import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Pricing-catalog list + upload proxy (M12 12.2b list; M14 14.2 upload).
 *
 * GET  → `/v1/catalog` → `PricingCatalogRow[]` (newest first).
 * POST → `/v1/catalog` — submit an offline ed25519-SIGNED bundle (`{version, payload,
 * signature}` from `scripts/sign-catalog.ts`). Signing stays offline (the private key never
 * touches the browser); ingest re-verifies the signature and a bad one is a forwarded 400.
 * The uploaded catalog lands `pending` — the approval gate on this same page still applies.
 * The admin bearer is added on the server→ingest hop only (D8).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/catalog");
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/catalog", { method: "POST", body, contentType: "application/json" });
}
