"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * New-project form (M12 12.2b) — a client island above the (server) projects table. Mirrors the
 * `alerts-panel.tsx` mutation discipline: POST the same-origin proxy (token server-side, D8),
 * CHECK `res.ok`, disable in-flight, then `router.refresh()` so the server re-fetches and the
 * new row appears (create returns only `{id}`). Name is required; gitRemote is optional.
 */
export function ProjectCreate() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [gitRemote, setGitRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const remote = gitRemote.trim();
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remote ? { name: trimmed, gitRemote: remote } : { name: trimmed }),
      });
      if (!res.ok) {
        setError(`Create failed (${res.status}).`);
        return;
      }
      setName("");
      setGitRemote("");
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            className="border-border bg-background min-w-56 flex-1 rounded-md border px-3 py-2 text-sm"
            aria-label="New project name"
          />
          <input
            type="text"
            value={gitRemote}
            onChange={(e) => setGitRemote(e.target.value)}
            placeholder="Git remote (optional)"
            className="border-border bg-background w-72 rounded-md border px-3 py-2 font-mono text-xs"
            aria-label="Git remote"
          />
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {busy ? "Creating…" : "New project"}
          </button>
          {error ? <span className="text-destructive text-xs">{error}</span> : null}
        </form>
      </CardContent>
    </Card>
  );
}
