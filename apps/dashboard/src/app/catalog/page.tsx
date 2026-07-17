import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { CatalogView } from "@/components/catalog/catalog-view";
import type { ConnectorCatalogRow, PricingCatalogRow } from "@/lib/types";

// Always render fresh server-side; both catalog lists reflect live approval state (D8: the admin
// token is added on this server→ingest hop only and never reaches the browser).
export const dynamic = "force-dynamic";

/** Fetch one catalog list (bare array, newest-first server-side); unreachable/error → []. */
async function fetchList<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    if (res.ok) return (await res.json()) as T[];
  } catch {
    /* ingest unreachable — render an empty list rather than crashing the page */
  }
  return [];
}

export default async function CatalogPage() {
  // M14 14.2: the page carries BOTH signed-catalog lifecycles (pricing + connector).
  const [pricing, connectors] = await Promise.all([
    fetchList<PricingCatalogRow>("/v1/catalog"),
    fetchList<ConnectorCatalogRow>("/v1/connector-catalog"),
  ]);
  return <CatalogView pricing={pricing} connectors={connectors} />;
}
