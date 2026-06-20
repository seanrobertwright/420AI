"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import type { ReindexCounts, SearchEntityType, SearchHit, SearchResults } from "@420ai/shared";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ENTITY_BADGE: Record<SearchEntityType, string> = {
  session: "border-transparent bg-sky-500/15 text-sky-400",
  report: "border-transparent bg-violet-500/15 text-violet-400",
  project: "border-transparent bg-emerald-500/15 text-emerald-400",
};

/**
 * Where a hit links within the 12.2a surfaces: project → its detail; session → the owning
 * project's detail (its row appears in that project's sessions table); report → the reports
 * list (no per-report deep route this slice). Returns null when there is no resolvable target.
 */
function hitHref(hit: SearchHit): string | null {
  if (hit.entityType === "project") return `/projects/${hit.entityId}`;
  if (hit.entityType === "session") return hit.projectId ? `/projects/${hit.projectId}` : null;
  return "/reports";
}

/** Strip the `ts_headline` <b> highlight markup → clean PLAIN text (XSS-safe; bold deferred). */
function plainSnippet(snippet: string): string {
  return snippet.replace(/<\/?b>/g, "");
}

/**
 * Redacted full-text search (M12 12.2a / 12.1). Client component: a query box + entity-type
 * filter + optional project id; on submit it GETs the same-origin `/api/search` proxy (the
 * admin token stays server-side, D8). Hits are already redacted server-side, so the snippet is
 * content-safe to render. Submit is disabled while the query is empty (ingest requires q ≥ 1).
 */
export function SearchView() {
  const [q, setQ] = useState("");
  const [type, setType] = useState<"" | SearchEntityType>("");
  const [projectId, setProjectId] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);

  // Full index rebuild (M12 12.2b). POST the same-origin proxy (token server-side, D8); CHECK
  // res.ok; disable in-flight (a full rebuild can be slow on a big archive); show the counts.
  async function reindex(): Promise<void> {
    setReindexing(true);
    setReindexMsg(null);
    try {
      const res = await fetch("/api/search/reindex", { method: "POST" });
      if (!res.ok) {
        setReindexMsg(`Reindex failed (${res.status}).`);
        return;
      }
      const c = (await res.json()) as ReindexCounts;
      setReindexMsg(`Reindexed ${c.total} (${c.projects} projects, ${c.sessions} sessions, ${c.reports} reports).`);
    } catch {
      setReindexMsg("Ingest unreachable.");
    } finally {
      setReindexing(false);
    }
  }

  async function runSearch(e: FormEvent): Promise<void> {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (type) params.set("type", type);
      if (projectId.trim()) params.set("projectId", projectId.trim());
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) {
        // 400 (bad q) / 404 (unknown projectId) / 502 (ingest down) — show no results, not a crash.
        setResults({ query, hits: [] });
        setError(res.status === 404 ? "Unknown project filter." : "Search failed.");
        return;
      }
      setResults((await res.json()) as SearchResults);
    } catch {
      setResults({ query, hits: [] });
      setError("Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageShell title="Search" subtitle="Full-text search over the redacted archive index.">
      <div className="space-y-6">
        <form onSubmit={runSearch} className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sessions, reports, projects…"
            className="border-border bg-background min-w-64 flex-1 rounded-md border px-3 py-2 text-sm"
            aria-label="Search query"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "" | SearchEntityType)}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Entity type filter"
          >
            <option value="">All types</option>
            <option value="session">Sessions</option>
            <option value="report">Reports</option>
            <option value="project">Projects</option>
          </select>
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="Project id (optional)"
            className="border-border bg-background w-56 rounded-md border px-3 py-2 font-mono text-xs"
            aria-label="Project id filter"
          />
          <button
            type="submit"
            disabled={!q.trim() || loading}
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {loading ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            onClick={() => void reindex()}
            disabled={reindexing}
            title="Rebuild the full-text index from the archive"
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {reindexing ? "Reindexing…" : "Reindex"}
          </button>
          {reindexMsg ? <span className="text-muted-foreground text-xs">{reindexMsg}</span> : null}
        </form>

        <Card>
          <CardContent className="pt-6">
            {results === null ? (
              <p className="text-muted-foreground text-sm">Enter a query to search.</p>
            ) : results.hits.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {error ?? `No results for “${results.query}”.`}
              </p>
            ) : (
              <ul className="space-y-4">
                {results.hits.map((hit) => {
                  const href = hitHref(hit);
                  const title = hit.title ?? hit.entityId;
                  return (
                    <li key={`${hit.entityType}:${hit.entityId}`} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge className={cn(ENTITY_BADGE[hit.entityType])}>{hit.entityType}</Badge>
                        {href ? (
                          <Link href={href} className="text-primary text-sm font-medium hover:underline">
                            {title}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium">{title}</span>
                        )}
                        <span className="text-muted-foreground ml-auto text-xs">
                          rank {hit.rank.toFixed(3)}
                        </span>
                      </div>
                      <p className="text-muted-foreground text-sm">{plainSnippet(hit.snippet)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
