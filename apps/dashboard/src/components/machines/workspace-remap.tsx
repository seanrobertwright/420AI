"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

/** The {id,name} pairs a workspace may be remapped to (passed from the server page). */
export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Workspace→project remap (M12 12.2b) — a compact client island in each row of the (server)
 * workspaces table. A `<select>` of real project uuids (so the chosen `projectId` is always
 * well-formed) + PATCH the same-origin proxy (token server-side, D8). Mirrors `alerts-panel.tsx`:
 * `res.ok` check, disable in-flight, `router.refresh()` on success so the new mapping shows.
 */
export function WorkspaceRemap({
  workspaceId,
  currentProjectId,
  projects,
}: {
  workspaceId: string;
  currentProjectId: string | null;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(currentProjectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = projectId !== "" && projectId !== currentProjectId;

  async function remap(): Promise<void> {
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        setError(
          res.status === 404
            ? "not found"
            : res.status === 400
              ? "bad id"
              : `failed (${res.status})`,
        );
        return;
      }
      router.refresh();
    } catch {
      setError("unreachable");
    } finally {
      setBusy(false);
    }
  }

  if (projects.length === 0) {
    return <span className="text-muted-foreground text-xs">no projects</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className="border-border bg-background rounded-md border px-2 py-1 text-xs"
        aria-label="Remap to project"
      >
        <option value="">— select —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={cn(
          "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
          "border-border hover:bg-muted disabled:opacity-50",
        )}
        disabled={!dirty || busy}
        onClick={() => void remap()}
      >
        {busy ? "…" : "Remap"}
      </button>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </div>
  );
}
