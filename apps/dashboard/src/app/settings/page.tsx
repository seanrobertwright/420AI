import type { LiveMonitorSnapshot } from "@420ai/shared";
import { getIngestJson } from "@/lib/ingest";
import { SettingsView } from "@/components/settings/settings-view";
import type { PricingCatalogRow } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Health {
  status: string;
  time: string;
}

/**
 * Settings page (M12 12.2b) — READ-ONLY. There is no settings/config API yet (editable config
 * arrives in a later M12 slice), so this surfaces system status: ingest health, the monitor
 * version stamp, and the active pricing-catalog version. The admin token is read server-side only
 * and NEVER rendered (D8) — the view shows "configured", never a value.
 */
export default async function SettingsPage() {
  const [health, monitor, catalogs] = await Promise.all([
    getIngestJson<Health>("/v1/health"),
    getIngestJson<LiveMonitorSnapshot>("/v1/monitor"),
    getIngestJson<PricingCatalogRow[]>("/v1/catalog"),
  ]);
  const activeCatalog = catalogs?.find((c) => c.status === "active") ?? null;

  return (
    <SettingsView
      health={health}
      monitorVersion={monitor?.monitorVersion ?? null}
      activeCatalogVersion={activeCatalog?.version ?? null}
      ingestConfigured={Boolean(process.env.INGEST_URL)}
    />
  );
}
