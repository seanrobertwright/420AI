"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseSignedCatalogText } from "@/lib/signed-catalog";
import { cn } from "@/lib/utils";

/**
 * Pricing-catalog upload form (M14 14.2). Submits an offline ed25519-SIGNED bundle
 * (`{version, payload, signature}` from `scripts/sign-catalog.ts`) — paste it or pick the file.
 * Signing stays offline: this form never sees a private key; it forwards the already-signed
 * document to the same-origin proxy (`POST /api/catalog`), and ingest re-verifies the signature
 * (bad → forwarded 400 shown inline). Success lands the catalog as `pending` in the table below
 * (mutation discipline per catalog-view.tsx: check `res.ok`, disable in-flight, refresh).
 */
export function CatalogUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setText(await file.text());
  }

  async function submit(): Promise<void> {
    setError(null);
    setNotice(null);
    const parsed = parseSignedCatalogText(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.doc),
      });
      if (!res.ok) {
        // The proxy forwards ingest's status + JSON body (400 → "signature verification failed").
        let message = `Upload failed (${res.status}).`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = `${body.error} (${res.status}).`;
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        setError(message);
        return;
      }
      // Idempotent re-upload of an existing version returns the EXISTING row — show its
      // real status rather than assuming "pending".
      const row = (await res.json()) as { version: string; status: string };
      setNotice(`Uploaded ${row.version} — status: ${row.status}.`);
      setText("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 space-y-2">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          setNotice(null);
        }}
        placeholder='Paste a signed catalog document: {"version": …, "payload": …, "signature": …}'
        rows={4}
        className={cn(
          "border-border bg-background w-full rounded-md border p-2 font-mono text-xs",
          "placeholder:text-muted-foreground focus:outline-none",
        )}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            "border-border hover:bg-muted disabled:opacity-50",
          )}
        >
          {busy ? "Uploading…" : "Upload signed catalog"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          onChange={(e) => void onFile(e)}
          className="text-muted-foreground text-xs"
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-400">{notice}</p> : null}
    </div>
  );
}
