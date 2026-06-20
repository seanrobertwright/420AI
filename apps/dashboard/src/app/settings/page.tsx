import type { LiveMonitorSnapshot } from "@420ai/shared";
import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { SettingsView } from "@/components/settings/settings-view";
import type { PricingCatalogRow } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Health {
  status: string;
  time: string;
}

/** GET ingest JSON on the server→ingest hop (D8), returning null on any non-200/throw. */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, { headers: adminHeaders(), cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Settings page (M12 12.2b) — READ-ONLY. There is no settings/config API yet (editable config
 * arrives in a later M12 slice), so this surfaces system status: ingest health, the monitor
 * version stamp, and the active pricing-catalog version. The admin token is read server-side only
 * and NEVER rendered (D8) — the view shows "configured", never a value.
 */
export default async function SettingsPage() {
  const [health, monitor, catalogs] = await Promise.all([
    getJson<Health>("/v1/health"),
    getJson<LiveMonitorSnapshot>("/v1/monitor"),
    getJson<PricingCatalogRow[]>("/v1/catalog"),
  ]);
  const activeCatalog = catalogs?.find((c) => c.status === "active") ?? null;

  return (
    <SettingsView
      health={health}
      monitorVersion={monitor?.monitorVersion ?? null}
      activeCatalogVersion={activeCatalog?.version ?? null}
      ingestConfigured={Boolean(process.env.INGEST_URL)}
      adminTokenConfigured={Boolean(process.env.ADMIN_TOKEN)}
    />
  );
}
