/**
 * M5 discovery wire contract (PRD §19 steps 7–8). The collector enumerates the
 * project roots where AI work happened, enriches them with git metadata + the
 * Gemini reverse-map, and POSTs them to the Ingest API, which upserts workspaces
 * and auto-creates one project per workspace (unifying by git remote).
 *
 * Pure types (+ one tiny pure helper), no behavior, no deps — `@420ai/shared`
 * stays dependency-free.
 */

/**
 * What a connector reports about ONE distinct project root in its on-disk store.
 *
 * `projectKey` MUST equal what the connector emits as `event.project_path`
 * byte-for-byte (Claude/Codex: the raw `cwd`; Gemini: the `projectHash` = tmp dir
 * name). It is matched verbatim against `events.project_path` at attribution time,
 * so it is NEVER normalized. `rootPath` is the resolved real path (== projectKey
 * for Claude/Codex; the `.project_root` value for Gemini) and MAY be normalized
 * for display.
 */
export interface RootHint {
  projectKey: string;
  rootPath?: string;
  gitBranch?: string;
  sessionCount?: number;
}

/** A discovered workspace ready to POST: a resolved root + its git metadata. */
export interface DiscoveredWorkspace {
  sourceConnector: string;
  projectKey: string;
  rootPath: string;
  gitRemote?: string;
  gitBranch?: string;
  sessionCount?: number;
}

/** POST /v1/workspaces/discover request body. */
export interface DiscoverRequest {
  workspaces: DiscoveredWorkspace[];
}

/** POST /v1/workspaces/discover response: what was upserted + the new mappings. */
export interface DiscoverResponse {
  workspacesUpserted: number;
  projectsCreated: number;
  mappings: {
    projectKey: string;
    workspaceId: string;
    projectId: string;
    projectName: string;
  }[];
}

/**
 * Derive a human project name from a resolved root path: the last path segment
 * (handles both `/` and `\` separators, trailing slashes). Used as the fallback
 * project name when there is no git remote to name the project after.
 */
export function basenameFromRoot(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Derive a project name from a git remote URL (e.g.
 * `https://github.com/me/420AI.git` → `420AI`). Falls back to the whole string
 * if it has no recognizable repo segment.
 */
export function repoNameFromRemote(remote: string): string {
  const noSuffix = remote.replace(/\.git$/i, "").replace(/[\\/]+$/, "");
  const parts = noSuffix.split(/[\\/:]/);
  return parts[parts.length - 1] || remote;
}
