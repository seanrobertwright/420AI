import { proxyJson } from "@/lib/proxy";

/**
 * List connector catalogs (M14 14.2). GET `/v1/connector-catalog` → `ConnectorCatalogRow[]`
 * (newest first). Same-origin proxy; the admin bearer is added on the server→ingest hop (D8).
 * Upload (POST /v1/connector-catalog) is intentionally NOT proxied — connector-catalog bundles
 * stay offline-signed CLI-only (`sign-catalog.ts --connector`); the dashboard is the approval gate.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/connector-catalog");
}
