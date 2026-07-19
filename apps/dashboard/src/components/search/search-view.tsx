"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import type { ReindexCounts, SearchEntityType, SearchHit, SearchResults } from "@420ai/shared";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { splitSnippet } from "@/lib/snippet";

/** Page size for search results — matches the server default; offset paging appends. */
const SEARCH_PAGE = 20;

const ENTITY_BADGE: Record<SearchEntityType, string> = {
  session: "border-transparent bg-sky-500/15 text-sky-400",
  report: "border-transparent bg-violet-500/15 text-violet-400",
  project: "border-transparent bg-emerald-500/15 text-emerald-400",
  event: "border-transparent bg-amber-500/15 text-amber-400",
};

/**
 * Where a hit links within the 12.2a surfaces: project → its detail; session/event → the owning
 * project's detail (its row appears in that project's sessions table); report → the reports
 * list (no per-report deep route this slice). Returns null when there is no resolvable target.
 */
function hitHref(hit: SearchHit): string | null {
  if (hit.entityType === "project") return `/projects/${hit.entityId}`;
  if (hit.entityType === "session" || hit.entityType === "event") {
    return hit.projectId ? `/projects/${hit.projectId}` : null;
  }
  return "/reports";
}

/** One rank-ordered render item: a standalone report/project hit, or a session group. */
type RenderItem =
  | { kind: "single"; hit: SearchHit }
  | { kind: "group"; sessionId: string; sessionHit: SearchHit | null; eventHits: SearchHit[] };

/**
 * Group `session`/`event` hits under their `sessionId` (14.4); `report`/`project` hits
 * stay standalone. A pure client-side reshape of the already-ranked `hits` — a group's
 * position is set by its FIRST member's index, so the overall rank order (best hit per
 * group first) is preserved. Does not re-sort, so offset-paginated appends stay correct.
 */
function groupHitsBySession(hits: SearchHit[]): RenderItem[] {
  const items: RenderItem[] = [];
  const groupIndex = new Map<string, number>();

  for (const hit of hits) {
    if (hit.entityType !== "session" && hit.entityType !== "event") {
      items.push({ kind: "single", hit });
      continue;
    }
    const key = hit.entityType === "session" ? hit.entityId : (hit.sessionId ?? hit.entityId);
    const existingIdx = groupIndex.get(key);
    if (existingIdx === undefined) {
      groupIndex.set(key, items.length);
      items.push({
        kind: "group",
        sessionId: key,
        sessionHit: hit.entityType === "session" ? hit : null,
        eventHits: hit.entityType === "event" ? [hit] : [],
      });
      continue;
    }
    const group = items[existingIdx];
    if (group?.kind !== "group") continue;
    if (hit.entityType === "session") group.sessionHit = hit;
    else group.eventHits.push(hit);
  }
  return items;
}

/**
 * Render a `ts_headline` snippet with its `<b>` highlights as real `<strong>`
 * elements (M13 13.4). `splitSnippet` treats ONLY complete `<b>…</b>` pairs as
 * markup; everything else is a React text node (escaped on render) — no
 * `dangerouslySetInnerHTML` anywhere on this path.
 */
function HighlightedSnippet({ snippet }: { snippet: string }) {
  return (
    <p className="text-muted-foreground text-sm">
      {splitSnippet(snippet).map((seg, i) =>
        seg.bold ? (
          <strong key={i} className="text-foreground font-semibold">
            {seg.text}
          </strong>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

/** One hit's badge + title/link + rank + snippet. `indent` nests an event under its session header. */
function HitRow({ hit, indent = false }: { hit: SearchHit; indent?: boolean }) {
  const href = hitHref(hit);
  const title = hit.title ?? hit.entityId;
  return (
    <div className={cn("space-y-1", indent && "border-border/60 ml-4 border-l pl-3")}>
      <div className="flex items-center gap-2">
        <Badge className={cn(ENTITY_BADGE[hit.entityType])}>{hit.entityType}</Badge>
        {href ? (
          <Link href={href} className="text-primary text-sm font-medium hover:underline">
            {title}
          </Link>
        ) : (
          <span className="text-sm font-medium">{title}</span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">rank {hit.rank.toFixed(3)}</span>
      </div>
      <HighlightedSnippet snippet={hit.snippet} />
    </div>
  );
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
  // 13.4 pagination: the SUBMITTED filters (the form fields may change after submit),
  // whether the last page came back full (→ more may exist), and the load-more spinner.
  const [submitted, setSubmitted] = useState<{ q: string; type: string; projectId: string } | null>(
    null,
  );
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

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
      setReindexMsg(
        `Reindexed ${c.total} (${c.projects} projects, ${c.sessions} sessions, ${c.reports} reports).`,
      );
    } catch {
      setReindexMsg("Ingest unreachable.");
    } finally {
      setReindexing(false);
    }
  }

  function searchParams(f: { q: string; type: string; projectId: string }, offset: number): string {
    const params = new URLSearchParams({ q: f.q, limit: String(SEARCH_PAGE) });
    if (f.type) params.set("type", f.type);
    if (f.projectId) params.set("projectId", f.projectId);
    if (offset > 0) params.set("offset", String(offset));
    return params.toString();
  }

  async function runSearch(e: FormEvent): Promise<void> {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    const filters = { q: query, type, projectId: projectId.trim() };
    setLoading(true);
    setError(null);
    setCanLoadMore(false);
    try {
      const res = await fetch(`/api/search?${searchParams(filters, 0)}`);
      if (!res.ok) {
        // 400 (bad q) / 404 (unknown projectId) / 502 (ingest down) — show no results, not a crash.
        setResults({ query, hits: [] });
        setError(res.status === 404 ? "Unknown project filter." : "Search failed.");
        return;
      }
      const data = (await res.json()) as SearchResults;
      setResults(data);
      setSubmitted(filters);
      setCanLoadMore(data.hits.length === SEARCH_PAGE);
    } catch {
      setResults({ query, hits: [] });
      setError("Search failed.");
    } finally {
      setLoading(false);
    }
  }

  // Fetch the next page for the SUBMITTED filters and append (deduped on the
  // entity key so an index refresh between pages never yields duplicate rows).
  async function loadMore(): Promise<void> {
    if (!results || !submitted) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/search?${searchParams(submitted, results.hits.length)}`);
      if (!res.ok) {
        setCanLoadMore(false);
        return;
      }
      const data = (await res.json()) as SearchResults;
      const seen = new Set(results.hits.map((h) => `${h.entityType}:${h.entityId}`));
      const fresh = data.hits.filter((h) => !seen.has(`${h.entityType}:${h.entityId}`));
      setResults({ query: results.query, hits: [...results.hits, ...fresh] });
      setCanLoadMore(data.hits.length === SEARCH_PAGE);
    } catch {
      setCanLoadMore(false);
    } finally {
      setLoadingMore(false);
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
            <option value="event">Events</option>
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
              <>
                <ul className="space-y-4">
                  {groupHitsBySession(results.hits).map((item) => {
                    if (item.kind === "single") {
                      return (
                        <li key={`${item.hit.entityType}:${item.hit.entityId}`}>
                          <HitRow hit={item.hit} />
                        </li>
                      );
                    }
                    return (
                      <li key={`session-group:${item.sessionId}`} className="space-y-2">
                        {item.sessionHit ? (
                          <HitRow hit={item.sessionHit} />
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge className={cn(ENTITY_BADGE.session)}>session</Badge>
                            <span className="text-sm font-medium">{item.sessionId}</span>
                          </div>
                        )}
                        {item.eventHits.length > 0 ? (
                          <div className="space-y-3">
                            {item.eventHits.map((eventHit) => (
                              <HitRow
                                key={`${eventHit.entityType}:${eventHit.entityId}`}
                                hit={eventHit}
                                indent
                              />
                            ))}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {canLoadMore ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                      className={cn(
                        "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
                        "border-border hover:bg-muted disabled:opacity-50",
                      )}
                    >
                      {loadingMore ? "Loading…" : "Load more"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
