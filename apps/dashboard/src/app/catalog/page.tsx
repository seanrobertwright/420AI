import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { CatalogView } from "@/components/catalog/catalog-view";
import type { PricingCatalogRow } from "@/lib/types";

// Always render fresh server-side; the catalog list reflects live approval state (D8: the admin
// token is added on this server→ingest hop only and never reaches the browser).
export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  let catalogs: PricingCatalogRow[] = [];
  try {
    // GET /v1/catalog → a BARE array (newest-first server-side).
    const res = await fetch(`${ingestUrl()}/v1/catalog`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    if (res.ok) catalogs = (await res.json()) as PricingCatalogRow[];
  } catch {
    /* ingest unreachable — render an empty list rather than crashing the page */
  }
  return <CatalogView catalogs={catalogs} />;
}
