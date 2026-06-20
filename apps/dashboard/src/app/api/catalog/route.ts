import { proxyJson } from "@/lib/proxy";

/**
 * List pricing catalogs (M12 12.2b). GET `/v1/catalog` → `PricingCatalogRow[]`. Same-origin
 * proxy; the admin bearer is added on the server→ingest hop (D8). Upload (POST /v1/catalog) is
 * offline ed25519-signed only and intentionally NOT proxied — the dashboard is the approval gate.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/catalog");
}
