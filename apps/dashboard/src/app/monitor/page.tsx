import { emptyMonitorSnapshot, type LiveMonitorSnapshot } from "@420ai/shared";
import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { LiveMonitor } from "@/components/live-monitor";

// Always render fresh server-side (the snapshot reflects live state, never a build cache).
export const dynamic = "force-dynamic";

/** A safe empty snapshot when ingest is unreachable — the page still renders + SSE recovers. */
const emptySnapshot = (): LiveMonitorSnapshot => emptyMonitorSnapshot(new Date().toISOString());

/**
 * The Live Monitor page (M9). Server Component: fetches the initial snapshot directly from
 * ingest with the admin token (server→ingest hop only — D8), then hands it to the client
 * <LiveMonitor/> which subscribes to SSE for live updates. If ingest is down the page still
 * renders an empty snapshot (the proxy/SSE reconnect path takes over once it is back).
 */
export default async function MonitorPage() {
  let initial: LiveMonitorSnapshot;
  try {
    const res = await fetch(`${ingestUrl()}/v1/monitor`, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    initial = res.ok ? ((await res.json()) as LiveMonitorSnapshot) : emptySnapshot();
  } catch {
    initial = emptySnapshot();
  }
  return <LiveMonitor initial={initial} />;
}
