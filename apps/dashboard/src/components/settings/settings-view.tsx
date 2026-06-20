import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

interface Health {
  status: string;
  time: string;
}

/**
 * Settings (M12 12.2b) — READ-ONLY system status. Pure-render Server Component: ingest health,
 * the monitor version stamp, the active pricing-catalog version, and whether the server env is
 * configured. CRITICAL (D8): it shows "configured" / "not set" booleans, NEVER the ADMIN_TOKEN or
 * INGEST_URL VALUES — the token must never reach the browser. Editable settings arrive in a
 * later M12 slice.
 */
export function SettingsView({
  health,
  monitorVersion,
  activeCatalogVersion,
  ingestConfigured,
  adminTokenConfigured,
}: {
  health: Health | null;
  monitorVersion: string | null;
  activeCatalogVersion: string | null;
  ingestConfigured: boolean;
  adminTokenConfigured: boolean;
}) {
  const reachable = health !== null;

  return (
    <PageShell title="Settings" subtitle="System status and versions (read-only).">
      <div className="space-y-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Ingest</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Badge
                className={cn(
                  reachable
                    ? "border-transparent bg-emerald-500/15 text-emerald-400"
                    : "border-transparent bg-destructive/15 text-destructive",
                )}
              >
                {reachable ? `ok` : "unreachable"}
              </Badge>
              <p className="text-muted-foreground text-xs">
                {reachable ? `as of ${formatDate(health.time)}` : "no response"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Monitor version</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{monitorVersion ?? "—"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Active pricing catalog</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{activeCatalogVersion ?? "—"}</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Server configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* D8: show booleans only — NEVER the value of the token or URL. */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">INGEST_URL</span>
              <span>{ingestConfigured ? "configured" : "default (localhost:8420)"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">ADMIN_TOKEN</span>
              <span>{adminTokenConfigured ? "configured" : "not set"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            Editable settings (auth, scheduled reports, provider config) arrive in a later M12 slice.
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
