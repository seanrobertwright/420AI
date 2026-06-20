/**
 * M10 git-outcome wire contract (PRD §11.3 Git Outcome Tracking + §11.4 Outcome
 * Attribution). The collector reads a repo's `git log` (commits + numstat +
 * changed files), POSTs them to the Ingest API, which stores them in the dedicated
 * `git_commits`/`git_commit_files` tables (NOT the `events` stream — D2). A
 * server-side heuristic then attributes AI sessions to those commits with an
 * explicit confidence, persisted in `session_git_links` (D5 — attribution is a
 * side-table, never a column).
 *
 * Pure types (+ one tiny pure helper), no behavior, no deps — `@420ai/shared`
 * stays dependency-free. Timestamps are ISO strings end-to-end (no `Date`).
 */

/** One changed file in a commit (numstat row). `insertions`/`deletions` are 0 for binary files. */
export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
}

/**
 * One captured commit, as the collector POSTs it. `repoRootPath` MUST equal the
 * connector's `projectKey`/`cwd` byte-for-byte (== `events.project_path`) so the
 * attribution join resolves (the discovery.ts:21 invariant). `authoredAt`/
 * `committedAt` are ISO 8601 strings (offset OR `Z` form — both valid; stored
 * verbatim). The commit SHA is the idempotency key (D3).
 */
export interface GitCommitPayload {
  commitSha: string;
  repoRootPath: string;
  gitBranch?: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string; // ISO 8601
  committedAt: string; // ISO 8601
  message: string;
  parents: string[];
  isRevert: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: GitFileChange[];
}

/** POST /v1/git request body. */
export interface GitCaptureRequest {
  commits: GitCommitPayload[];
}

/** POST /v1/git response: how many NEW commits were inserted (dedup-aware). */
export interface GitCaptureResponse {
  commitsInserted: number;
}

/**
 * A commit as the read API returns it (the plaintext projection). The commit
 * MESSAGE is encrypted at rest (§18.1) and intentionally absent here — author/
 * email/paths/counts are git metadata (same class as the plaintext
 * `project_path`) and ARE returned for reporting.
 */
export interface GitCommitRow {
  commitSha: string;
  repoRootPath: string;
  gitBranch: string | null;
  authorName: string | null;
  authorEmail: string | null;
  authoredAt: string; // ISO — mode:"string", returned verbatim
  committedAt: string | null;
  isRevert: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Attribution confidence levels (PRD §11.4). `low`/`medium` are heuristic; `manual` is human-set. */
export type AttributionConfidence = "high" | "medium" | "low" | "manual";

/**
 * A persisted session→commit attribution link (D5 side-table row). Always carries
 * a `confidence` + `status` — a suggestion is NEVER presented as fact (§11.4).
 */
export interface SessionGitLink {
  id: string;
  sessionId: string;
  commitSha: string;
  projectId: string | null;
  confidence: AttributionConfidence;
  status: "suggested" | "confirmed" | "rejected";
  minutesDelta: number | null;
  fileOverlap: number;
}

/** The §11.4 time window: a commit within ±this many minutes of the session end is a candidate. */
export const ATTRIBUTION_WINDOW_MINUTES = 30;

/**
 * The §11.4 heuristic core (DB-free, pure, unit-testable). Given how far a commit
 * sits from the session end (signed minutes) and how many of the session's
 * modified files the commit touched, return a suggested confidence — or `null`
 * when the commit is outside the window (no suggestion at all).
 *
 * Q4 scope: heuristic suggestions are `low`/`medium` ONLY. `high`/`manual` are set
 * elsewhere (a human confirm). `fileOverlap >= 1` → medium (the commit touched a
 * file the session edited); otherwise `low` (same repo + in window, no overlap).
 */
export function suggestConfidence(p: {
  minutesDelta: number;
  fileOverlap: number;
}): AttributionConfidence | null {
  if (Math.abs(p.minutesDelta) > ATTRIBUTION_WINDOW_MINUTES) return null; // out of window → no suggestion
  return p.fileOverlap >= 1 ? "medium" : "low";
}
