"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PricingCatalogRow } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
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

/** Status → badge tint (mirrors STATUS_BADGE in monitor-view.tsx). */
const STATUS_BADGE: Record<PricingCatalogRow["status"], string> = {
  pending: "border-transparent bg-amber-500/15 text-amber-400",
  active: "border-transparent bg-emerald-500/15 text-emerald-400",
  superseded: "border-transparent bg-muted text-muted-foreground",
  rejected: "border-transparent bg-destructive/15 text-destructive",
};

/**
 * Pricing-catalog approval gate (M12 12.2b, PRD §10.4). Client component: a versioned table
 * where each `pending` row gets Approve + Reject buttons. Mirrors the `alerts-panel.tsx`
 * mutation discipline: POST the same-origin proxy (token server-side, D8), CHECK `res.ok`,
 * disable in-flight, `router.refresh()` so the server re-fetches (approve atomically supersedes
 * the current active → BOTH rows change). Upload is offline ed25519-signed only — there is
 * deliberately no upload form here (the dashboard manages the gate, not signing).
 */
export function CatalogView({ catalogs }: { catalogs: PricingCatalogRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject"): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/catalog/${id}/${action}`, { method: "POST" });
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

  return (
    <PageShell
      title="Pricing catalog"
      subtitle="Signed pricing-catalog versions. Upload is offline-signed (CLI); approve/reject here."
    >
      <Card>
        <CardContent className="pt-6">
          {error ? <p className="text-destructive mb-3 text-sm">{error}</p> : null}
          {catalogs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No pricing catalogs uploaded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.version}</TableCell>
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
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
