"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Inline project rename (M12 12.2b) — a client island in the (server) project detail view.
 * Mirrors the `alerts-panel.tsx` mutation discipline: PATCH the same-origin proxy (token stays
 * server-side, D8), CHECK `res.ok`, disable in-flight, `router.refresh()` on success so the
 * server re-fetches the new name. An unchanged/empty name is a no-op (Save disabled).
 */
export function ProjectRename({
  projectId,
  currentName,
}: {
  projectId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== currentName;

  async function save(): Promise<void> {
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(res.status === 404 ? "Project not found." : `Rename failed (${res.status}).`);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("Ingest unreachable.");
    } finally {
      setBusy(false);
    }
  }

  const btn = cn(
    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
    "border-border hover:bg-muted disabled:opacity-50",
  );

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-6">
        {editing ? (
          <>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border-border bg-background min-w-64 rounded-md border px-3 py-2 text-sm"
              aria-label="Project name"
            />
            <button
              type="button"
              className={btn}
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setName(currentName);
                setError(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground text-sm">Name: </span>
            <span className="text-sm font-medium">{currentName}</span>
            <button type="button" className={btn} onClick={() => setEditing(true)}>
              Rename
            </button>
          </>
        )}
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </CardContent>
    </Card>
  );
}
