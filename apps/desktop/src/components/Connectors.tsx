import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ControlEvent, ConnectorInfo } from "@420ai/shared";
import { listConnectors, setConnector, onControlEvent } from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Connector management (M11 Slice 2). Lists every capture connector with its fidelity
 * (status/liveness/tokens/cost + known gaps) and the watch globs it reads (the
 * "permission scope" review), plus a per-connector enable/disable toggle.
 *
 * Enablement is PERSISTED by the sidecar (`~/.420ai/connectors.json`) and applied by
 * FILTERING the engine's `connectors[]` on the next capture (re)start — the M3/M4
 * capture core is untouched. The panel notes the "applies on next start" semantics.
 */
export function Connectors() {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Toggle routes through a .catch so a reject (sidecar mid-restart) is panel state.
  const toggle = (c: ConnectorInfo): void => {
    setError(null);
    setConnector(c.id, !c.enabled).catch((err) => setError(String(err)));
  };

  // Request the list (the `connectors` event arrives on the shared stream). Exposed so
  // a Retry button can re-trigger it if the first request rejected during a sidecar
  // restart window — otherwise the panel would be stuck with no way to re-ask.
  const requestList = (): void => {
    setError(null);
    listConnectors().catch((err) => setError(String(err)));
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const apply = (ev: ControlEvent): void => {
      if (ev.type === "connectors") setConnectors(ev.connectors);
    };

    onControlEvent(apply).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    requestList();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connectors</CardTitle>
        <CardDescription>
          Enable or disable individual capture sources — changes apply when capture (re)starts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <p className="text-destructive mb-3 text-xs">{error}</p> : null}
        {connectors === null ? (
          error ? (
            <div className="flex items-center gap-3">
              <p className="text-muted-foreground text-sm">Couldn't reach the collector.</p>
              <button
                type="button"
                onClick={requestList}
                className="border-input bg-background hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Loading connectors…</p>
          )
        ) : connectors.length === 0 ? (
          <p className="text-muted-foreground text-sm">No connectors registered.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Connector</TableHead>
                <TableHead>Fidelity</TableHead>
                <TableHead>Reads (permission scope)</TableHead>
                <TableHead className="text-right">Capture</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="align-top font-medium">
                    {c.id}
                    <div className="text-muted-foreground mt-1 text-xs font-normal">{c.status}</div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{c.liveness}</Badge>
                      <Badge variant="outline">tokens: {c.tokens}</Badge>
                      <Badge variant="outline">cost: {c.cost}</Badge>
                    </div>
                    {c.knownGaps.length > 0 ? (
                      <div className="text-muted-foreground mt-1">
                        gaps: {c.knownGaps.join("; ")}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top font-mono text-xs">
                    {/* Do not truncate — the user is reviewing the real read scope. */}
                    <div className="space-y-0.5 break-all whitespace-normal">
                      {c.watchGlobs.length > 0 ? (
                        c.watchGlobs.map((g, i) => <div key={`${g}:${i}`}>{g}</div>)
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <button
                      type="button"
                      onClick={() => toggle(c)}
                      className={cn(
                        "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors",
                        c.enabled
                          ? "border-input bg-background hover:bg-accent"
                          : "border-transparent bg-primary text-primary-foreground hover:opacity-90",
                      )}
                    >
                      {c.enabled ? "Disable" : "Enable"}
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
