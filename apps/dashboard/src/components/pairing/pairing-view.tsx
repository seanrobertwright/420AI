"use client";

import { useState } from "react";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

interface PairingCode {
  code: string;
  expiresAt: string;
}

/**
 * Pairing-code generation (M12 12.2b, PRD §19). Client component: "Generate" POSTs the
 * same-origin proxy (token server-side, D8), CHECKs `res.ok`, disables in-flight, and shows the
 * `code` + `expiresAt` with copy-to-clipboard. The code is SHORT-LIVED → expiry is shown
 * prominently. Generate-only (no list endpoint); an optional email overrides the default owner.
 */
export function PairingView() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const trimmed = email.trim();
      const res = await fetch("/api/pairing-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { email: trimmed } : {}),
      });
      if (!res.ok) {
        setError(`Generation failed (${res.status}).`);
        return;
      }
      setResult((await res.json()) as PairingCode);
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
    } catch {
      /* clipboard blocked — the code is visible to copy manually */
    }
  }

  const btn = cn(
    "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
    "border-border hover:bg-muted disabled:opacity-50",
  );

  return (
    <PageShell title="Pairing" subtitle="Mint a short-lived code to pair a new collector machine.">
      <Card>
        <CardHeader>
          <CardTitle>Generate pairing code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Owner email (optional)"
              className="border-border bg-background min-w-64 rounded-md border px-3 py-2 text-sm"
              aria-label="Owner email"
            />
            <button type="button" className={btn} disabled={busy} onClick={() => void generate()}>
              {busy ? "Generating…" : "Generate pairing code"}
            </button>
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          {result ? (
            <div className="border-border bg-muted/40 space-y-2 rounded-md border p-4">
              <div className="flex items-center gap-3">
                <code className="text-lg font-bold tracking-widest">{result.code}</code>
                <button type="button" className={btn} onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-muted-foreground text-sm">
                Expires {formatDate(result.expiresAt)} — use it before then.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}
