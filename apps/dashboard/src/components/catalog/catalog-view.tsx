"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ConnectorCatalogRow, PricingCatalogRow } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { CatalogUpload } from "@/components/catalog/catalog-upload";

/** Status → badge tint (mirrors STATUS_BADGE in monitor-view.tsx). */
const STATUS_BADGE: Record<PricingCatalogRow["status"], string> = {
  pending: "border-transparent bg-amber-500/15 text-amber-400",
  active: "border-transparent bg-emerald-500/15 text-emerald-400",
  superseded: "border-transparent bg-muted text-muted-foreground",
  rejected: "border-transparent bg-destructive/15 text-destructive",
};

/** The lifecycle columns both catalog row types share (+ an optional per-row detail cell). */
interface CatalogTableRow {
  id: string;
  version: string;
  status: PricingCatalogRow["status"];
  uploadedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  detail?: string;
}

/**
 * One approval-gate table (M12 12.2b pricing; generalized for M14 14.2 so the connector
 * catalog reuses it). Each `pending` row gets Approve + Reject buttons POSTing
 * `{actionBase}/{id}/{approve|reject}` — the same-origin proxy adds the token server-side (D8).
 * Mirrors the `alerts-panel.tsx` mutation discipline: CHECK `res.ok`, disable in-flight,
 * `router.refresh()` so the server re-fetches (approve atomically supersedes the current
 * active → BOTH rows change).
 */
function CatalogTable({
  rows,
  actionBase,
  emptyText,
  detailHead,
}: {
  rows: CatalogTableRow[];
  actionBase: string;
  emptyText: string;
  detailHead?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject"): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`${actionBase}/${id}/${action}`, { method: "POST" });
      if (!res.ok) {
        setError(res.status === 404 ? "No longer pending." : `Action failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(null);
    }
  }

  const btn = cn(
    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
    "border-border hover:bg-muted disabled:opacity-50",
  );

  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{emptyText}</p>;

  return (
    <>
      {error ? <p className="text-destructive mb-3 text-sm">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            {detailHead ? <TableHead>{detailHead}</TableHead> : null}
            <TableHead>Status</TableHead>
            <TableHead>Uploaded</TableHead>
            <TableHead>Approved</TableHead>
            <TableHead>By</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono text-xs">{c.version}</TableCell>
              {detailHead ? (
                <TableCell className="text-muted-foreground text-xs">{c.detail ?? "—"}</TableCell>
              ) : null}
              <TableCell>
                <Badge className={cn(STATUS_BADGE[c.status])}>{c.status}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(c.uploadedAt)}</TableCell>
              <TableCell className="text-muted-foreground">{formatDate(c.approvedAt)}</TableCell>
              <TableCell className="text-muted-foreground text-xs">{c.approvedBy ?? "—"}</TableCell>
              <TableCell>
                {c.status === "pending" ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={btn}
                      disabled={busy !== null}
                      onClick={() => void act(c.id, "approve")}
                    >
                      {busy === c.id ? "…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy !== null}
                      onClick={() => void act(c.id, "reject")}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/**
 * Catalog admin surface (M12 12.2b pricing gate; M14 14.2 adds pricing UPLOAD + the connector
 * catalog's approve/reject — PRD §10.4). Two independent signed-catalog lifecycles, one page:
 * pricing (upload form + gate) and connector (gate only — connector bundles stay CLI-signed
 * AND CLI-uploaded; an approved connector catalog is pulled by collectors on their next sync).
 */
export function CatalogView({
  pricing,
  connectors,
}: {
  pricing: PricingCatalogRow[];
  connectors: ConnectorCatalogRow[];
}) {
  return (
    <PageShell
      title="Catalogs"
      subtitle="Signed pricing + connector catalog versions. Signing is offline (CLI); upload and approve/reject here."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Pricing catalog</CardTitle>
          </CardHeader>
          <CardContent>
            <CatalogUpload />
            <CatalogTable
              rows={pricing}
              actionBase="/api/catalog"
              emptyText="No pricing catalogs uploaded yet."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Connector catalog</CardTitle>
          </CardHeader>
          <CardContent>
            <CatalogTable
              rows={connectors.map((c) => ({
                ...c,
                // Permissive server schema: guard rather than trust `payload.connectors` exists.
                detail: String(
                  Array.isArray(c.payload.connectors) ? c.payload.connectors.length : 0,
                ),
              }))}
              actionBase="/api/connector-catalog"
              emptyText="No connector catalogs uploaded yet (collectors use the bundled baseline)."
              detailHead="Entries"
            />
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
