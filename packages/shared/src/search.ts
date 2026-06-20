/**
 * M12 §21 admin full-text search result types. Search runs over a REDACTED
 * plaintext projection (`search_documents`) — never the encrypted originals
 * (PRD §18.1). Every `title`/`snippet` returned here came from a row whose text
 * was `redact()`-ed before it was stored, so a hit can be rendered in the browser
 * without leaking a secret.
 *
 * `@420ai/shared` invariants: TYPES ONLY here — no I/O, no deps. The redaction +
 * decrypt + query logic lives in `@420ai/db` (which already depends on shared).
 * Mirrors the result-types-in-shared convention (`projections.ts`, `reports.ts`).
 */

/** What kind of archive entity a search hit points at. */
export type SearchEntityType = "session" | "report" | "project";

/** One ranked search hit. `snippet` is a redacted `ts_headline` fragment — safe to render. */
export interface SearchHit {
  entityType: SearchEntityType;
  /** sessionId (connector text) | report uuid | project uuid. */
  entityId: string;
  /** Owning project uuid when resolvable, else null. */
  projectId: string | null;
  title: string | null;
  /** Redacted highlighted fragment from the matched body. */
  snippet: string;
  /** `ts_rank` relevance score (higher = better). */
  rank: number;
}

/** The `GET /v1/search` response: the echoed query + ranked hits (best first). */
export interface SearchResults {
  query: string;
  hits: SearchHit[];
}

/** Per-entity row counts returned by `POST /v1/search/reindex`. */
export interface ReindexCounts {
  reports: number;
  projects: number;
  sessions: number;
  total: number;
}
