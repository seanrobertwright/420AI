import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  ATTRIBUTION_WINDOW_MINUTES,
  suggestConfidence,
  type AttributionConfidence,
  type SessionGitLink,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import {
  events,
  gitCommitFiles,
  gitCommits,
  machines,
  sessionGitLinks,
  workspaceKeys,
  workspaces,
} from "../schema.js";
import { resolveWorkspaceId } from "./workspaces.js";

/**
 * Outcome-attribution repository (M10, PRD §11.4, D5/D6). Computes session→commit
 * suggestions from the §11.4 heuristic (same repo + commit within ±window of the
 * session end + ≥1 modified-file overlap → low/medium) and persists them in the
 * `session_git_links` side-table. A link ALWAYS carries a confidence + status — a
 * suggestion is never presented as fact.
 *
 * Decrypt-for-render (D5): the session's modified-file PATHS live in ENCRYPTED
 * `events.payload_*` (the file.modified/file.read events). This is the SECOND
 * decrypt-on-read repository after `transcript.ts` (M8) — it decrypts those
 * payloads server-side, intersects with the plaintext `git_commit_files.file_path`,
 * and persists only the overlap COUNT. Paths never leave the archive.
 *
 * Silent library (CLAUDE.md): throws (decryptField fails loudly on a key/tag
 * error), never logs. Scope every query by userId.
 */

const FILE_EVENT_TYPES = ["file.modified", "file.read"] as const;
const WINDOW_MS = ATTRIBUTION_WINDOW_MINUTES * 60_000;

/** Normalize a path for the overlap test: `\`→`/`, collapse `//`, drop a trailing slash. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Count how many of a commit's repo-relative files the session also touched, using
 * the Phase-0 overlap rule: an ABSOLUTE session path matches a repo-RELATIVE commit
 * path iff `normalize(abs).endsWith(normalize(join(repoRoot, rel)))` (separators
 * normalized). repoRoot == the session's project_path == the commit's repo_root_path.
 */
function fileOverlapCount(
  repoRoot: string,
  sessionPaths: string[],
  commitFiles: string[],
): number {
  const root = normPath(repoRoot);
  const normSession = sessionPaths.map(normPath);
  let count = 0;
  for (const rel of commitFiles) {
    const joined = normPath(`${root}/${rel}`);
    if (normSession.some((abs) => abs.endsWith(joined))) count += 1;
  }
  return count;
}

/**
 * Decrypt-for-render: the distinct file paths a session modified/read. Selects the
 * session's file events that HAVE a payload, decrypts `events.payload_*` (M8
 * `transcript.ts` precedent — the 2nd such read), `JSON.parse`s, and collects the
 * `.path` field (deduped). Throws on a key/tag error (silent library).
 */
export async function sessionModifiedPaths(
  db: DbClient,
  sessionId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      ciphertext: events.payloadCiphertext,
      iv: events.payloadIv,
      tag: events.payloadTag,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        inArray(events.eventType, [...FILE_EVENT_TYPES]),
        isNotNull(events.payloadCiphertext),
      ),
    );

  const paths = new Set<string>();
  for (const r of rows) {
    if (!r.ciphertext || !r.iv || !r.tag) continue;
    const json = decryptField({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag });
    let parsed: { path?: unknown };
    try {
      parsed = JSON.parse(json) as { path?: unknown };
    } catch {
      continue; // a non-JSON payload is not a file event we can read a path from
    }
    if (typeof parsed.path === "string" && parsed.path) paths.add(parsed.path);
  }
  return [...paths];
}

/** The session's last event timestamp (ISO `mode:"string"` — already ISO, no coercion), or null. */
export async function sessionEndTs(db: DbClient, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ endedAt: sql<string | null>`max(${events.ts})` })
    .from(events)
    .where(eq(events.sessionId, sessionId));
  return row?.endedAt ?? null;
}

/** The session's project_path (the repo-root join key). Sessions carry one; max() is sufficient. */
async function sessionProjectPath(db: DbClient, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectPath: sql<string | null>`max(${events.projectPath})` })
    .from(events)
    .where(eq(events.sessionId, sessionId));
  return row?.projectPath ?? null;
}

/** Map a raw link row (text confidence/status) onto the typed SessionGitLink shape. */
function toLink(row: {
  id: string;
  sessionId: string;
  commitSha: string;
  projectId: string | null;
  confidence: string;
  status: string;
  minutesDelta: number | null;
  fileOverlap: number;
}): SessionGitLink {
  return {
    id: row.id,
    sessionId: row.sessionId,
    commitSha: row.commitSha,
    projectId: row.projectId,
    confidence: row.confidence as AttributionConfidence,
    status: row.status as SessionGitLink["status"],
    minutesDelta: row.minutesDelta,
    fileOverlap: row.fileOverlap,
  };
}

const linkColumns = {
  id: sessionGitLinks.id,
  sessionId: sessionGitLinks.sessionId,
  commitSha: gitCommits.commitSha,
  projectId: sessionGitLinks.projectId,
  confidence: sessionGitLinks.confidence,
  status: sessionGitLinks.status,
  minutesDelta: sessionGitLinks.minutesDelta,
  fileOverlap: sessionGitLinks.fileOverlap,
};

/** All persisted links for a session (joined to the commit SHA), scoped by userId. */
async function listSessionLinks(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<SessionGitLink[]> {
  const rows = await db
    .select(linkColumns)
    .from(sessionGitLinks)
    .innerJoin(gitCommits, eq(gitCommits.id, sessionGitLinks.commitId))
    .where(and(eq(sessionGitLinks.userId, userId), eq(sessionGitLinks.sessionId, sessionId)));
  return rows.map(toLink);
}

/**
 * The §11.4 heuristic: for one session, find commits in the SAME repo within
 * ±ATTRIBUTION_WINDOW_MINUTES of the session end, score each by file overlap, and
 * upsert a `suggested` link per surviving candidate. Returns the session's links.
 *
 * D6 (no-clobber): `insert ... onConflictDoNothing` then a guarded `update ... where
 * status = 'suggested'` — a re-run refreshes confidence/overlap/minutesDelta for
 * rows it owns but NEVER flips a human `confirmed`/`rejected`.
 *
 * Time math is in JS ms (not SQL `interval`) so the window stays injectable +
 * testable; the candidate query bounds `authored_at` (a real timestamptz column,
 * so the ISO-string bounds compare temporally, handling offset/Z forms).
 */
export async function computeSessionGitSuggestions(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<SessionGitLink[]> {
  const end = await sessionEndTs(db, sessionId);
  const projectPath = await sessionProjectPath(db, sessionId);
  if (!end || !projectPath) return listSessionLinks(db, userId, sessionId);

  const resolved = await resolveWorkspaceId(db, userId, projectPath);
  const projectId = resolved?.projectId ?? null;

  const endMs = new Date(end).getTime();
  const lowerIso = new Date(endMs - WINDOW_MS).toISOString();
  const upperIso = new Date(endMs + WINDOW_MS).toISOString();

  // Candidate commits: same repo root, this user's machines, within the window.
  const candidates = await db
    .select({
      id: gitCommits.id,
      authoredAt: gitCommits.authoredAt,
    })
    .from(gitCommits)
    .innerJoin(machines, eq(machines.id, gitCommits.machineId))
    .where(
      and(
        eq(machines.userId, userId),
        eq(gitCommits.repoRootPath, projectPath),
        gte(gitCommits.authoredAt, lowerIso),
        lte(gitCommits.authoredAt, upperIso),
      ),
    );

  if (candidates.length === 0) return listSessionLinks(db, userId, sessionId);

  const sessionPaths = await sessionModifiedPaths(db, sessionId);

  // Fetch all candidate commits' files in one query, grouped by commit.
  const fileRows = await db
    .select({ commitId: gitCommitFiles.commitId, filePath: gitCommitFiles.filePath })
    .from(gitCommitFiles)
    .where(inArray(gitCommitFiles.commitId, candidates.map((c) => c.id)));
  const filesByCommit = new Map<string, string[]>();
  for (const fr of fileRows) {
    const list = filesByCommit.get(fr.commitId);
    if (list) list.push(fr.filePath);
    else filesByCommit.set(fr.commitId, [fr.filePath]);
  }

  for (const c of candidates) {
    const overlap = fileOverlapCount(projectPath, sessionPaths, filesByCommit.get(c.id) ?? []);
    const deltaMin = (new Date(c.authoredAt).getTime() - endMs) / 60_000;
    const confidence = suggestConfidence({ minutesDelta: deltaMin, fileOverlap: overlap });
    if (!confidence) continue; // out of window (defensive — the SQL bound already screens)
    const minutesDelta = Math.round(deltaMin);

    // D6: create a fresh suggestion, but never clobber an existing human decision.
    await db
      .insert(sessionGitLinks)
      .values({
        userId,
        sessionId,
        commitId: c.id,
        projectId,
        confidence,
        status: "suggested",
        minutesDelta,
        fileOverlap: overlap,
      })
      .onConflictDoNothing({
        target: [sessionGitLinks.userId, sessionGitLinks.sessionId, sessionGitLinks.commitId],
      });
    // Refresh the metrics for a row that is STILL a suggestion (leaves confirmed/rejected intact).
    await db
      .update(sessionGitLinks)
      .set({ confidence, minutesDelta, fileOverlap: overlap, projectId })
      .where(
        and(
          eq(sessionGitLinks.userId, userId),
          eq(sessionGitLinks.sessionId, sessionId),
          eq(sessionGitLinks.commitId, c.id),
          eq(sessionGitLinks.status, "suggested"),
        ),
      );
  }

  return listSessionLinks(db, userId, sessionId);
}

/**
 * Create (or upgrade) a MANUAL link: confidence `manual`, status `confirmed`. A
 * human decision wins, so on conflict it overwrites the suggested confidence/status
 * (D6 — manual is the human path, not a re-suggest). The route existence-checks the
 * commit + project first so a bad id is a 404, not an FK-500.
 */
export async function addManualLink(
  db: DbClient,
  userId: string,
  sessionId: string,
  commitId: string,
  projectId: string | null,
): Promise<void> {
  await db
    .insert(sessionGitLinks)
    .values({
      userId,
      sessionId,
      commitId,
      projectId,
      confidence: "manual",
      status: "confirmed",
      minutesDelta: null,
      fileOverlap: 0,
    })
    .onConflictDoUpdate({
      target: [sessionGitLinks.userId, sessionGitLinks.sessionId, sessionGitLinks.commitId],
      set: { confidence: "manual", status: "confirmed", projectId },
    });
}

/** Confirm or reject a link (the human decision the suggest path then preserves). */
export async function setLinkStatus(
  db: DbClient,
  userId: string,
  linkId: string,
  status: "confirmed" | "rejected",
): Promise<SessionGitLink | undefined> {
  const [updated] = await db
    .update(sessionGitLinks)
    .set({ status })
    .where(and(eq(sessionGitLinks.id, linkId), eq(sessionGitLinks.userId, userId)))
    .returning({ id: sessionGitLinks.id });
  if (!updated) return undefined;
  const [row] = await db
    .select(linkColumns)
    .from(sessionGitLinks)
    .innerJoin(gitCommits, eq(gitCommits.id, sessionGitLinks.commitId))
    .where(eq(sessionGitLinks.id, linkId))
    .limit(1);
  return row ? toLink(row) : undefined;
}

/**
 * All links for a project — joined through the commit's repo root to the project
 * (the same D5 mapping `gitCommitsByProject` uses), so the listing reflects the
 * CURRENT workspace→project mapping. Scoped by userId.
 */
export async function listProjectLinks(
  db: DbClient,
  userId: string,
  projectId: string,
): Promise<SessionGitLink[]> {
  const rows = await db
    .select(linkColumns)
    .from(sessionGitLinks)
    .innerJoin(gitCommits, eq(gitCommits.id, sessionGitLinks.commitId))
    .innerJoin(workspaceKeys, eq(gitCommits.repoRootPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(and(eq(sessionGitLinks.userId, userId), eq(workspaces.projectId, projectId)));
  return rows.map(toLink);
}

/** Distinct session ids attributed to a project (the suggest route fans out over these). */
export async function projectSessionIds(db: DbClient, projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sessionId: events.sessionId })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId));
  return rows.map((r) => r.sessionId);
}
