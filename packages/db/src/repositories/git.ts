import { and, desc, eq } from "drizzle-orm";
import type { GitCaptureRequest, GitCommitRow, GitFileChange } from "@420ai/shared";
import type { Db, DbClient } from "../client.js";
import { encryptField } from "../crypto.js";
import { gitCommitFiles, gitCommits, machines, workspaceKeys, workspaces } from "../schema.js";

/**
 * Git-outcome repository (M10, PRD §11.3 / §18.1 / §23). Mirrors `ingest.ts`:
 * encrypt the sensitive field at the WRITE boundary (the commit message, §18.1)
 * and dedup on a natural key (the commit SHA — git's own content hash, D3) so a
 * re-scan is a no-op. Author/email/paths/numstat counts stay PLAINTEXT so reports
 * + attribution query them without decrypting.
 *
 * Silent library (CLAUDE.md): throws typed errors, never logs. Reads scope through
 * the D5 attribution join (`repo_root_path = workspace_keys.project_key`) — a
 * commit has no userId; it attributes via its repo root (== events.project_path).
 */

/**
 * Persist a batch of commits idempotently in ONE transaction. Per commit: encrypt
 * the message, INSERT ... ON CONFLICT (machine_id, commit_sha) DO NOTHING; only on
 * a genuine insert (a `.returning()` row) bulk-insert its changed files — so a
 * re-capture inserts neither a duplicate commit nor duplicate file rows.
 * `commitsInserted` counts only NEW commits (dedup-aware, like `ingestBatch`).
 */
export async function recordGitCommits(
  db: Db,
  machineId: string,
  req: GitCaptureRequest,
): Promise<{ commitsInserted: number }> {
  return db.transaction(async (tx) => {
    let commitsInserted = 0;
    for (const c of req.commits) {
      // Empty body is normal (a commit with no `%b`) → store NULL, not an encrypted "".
      const enc = c.message ? encryptField(c.message) : null;
      const inserted = await tx
        .insert(gitCommits)
        .values({
          machineId,
          commitSha: c.commitSha,
          repoRootPath: c.repoRootPath,
          gitBranch: c.gitBranch ?? null,
          authorName: c.authorName ?? null,
          authorEmail: c.authorEmail ?? null,
          authoredAt: c.authoredAt,
          committedAt: c.committedAt ?? null,
          parents: c.parents.join(" "),
          isRevert: c.isRevert,
          filesChanged: c.filesChanged,
          insertions: c.insertions,
          deletions: c.deletions,
          messageCiphertext: enc?.ciphertext ?? null,
          messageIv: enc?.iv ?? null,
          messageTag: enc?.tag ?? null,
        })
        .onConflictDoNothing({ target: [gitCommits.machineId, gitCommits.commitSha] })
        .returning({ id: gitCommits.id });
      if (inserted.length === 0) continue; // dedup — commit already captured, skip files too
      commitsInserted += 1;
      const commitId = inserted[0]!.id;
      if (c.files.length > 0) {
        await tx.insert(gitCommitFiles).values(
          c.files.map((f) => ({
            commitId,
            filePath: f.path,
            status: f.status,
            insertions: f.insertions,
            deletions: f.deletions,
          })),
        );
      }
    }
    return { commitsInserted };
  });
}

/** The plaintext projection columns the read API returns (NO message — it is encrypted). */
const gitCommitRowColumns = {
  commitSha: gitCommits.commitSha,
  repoRootPath: gitCommits.repoRootPath,
  gitBranch: gitCommits.gitBranch,
  authorName: gitCommits.authorName,
  authorEmail: gitCommits.authorEmail,
  authoredAt: gitCommits.authoredAt, // mode:"string" ISO — return verbatim, do NOT new Date() it
  committedAt: gitCommits.committedAt,
  isRevert: gitCommits.isRevert,
  filesChanged: gitCommits.filesChanged,
  insertions: gitCommits.insertions,
  deletions: gitCommits.deletions,
};

/**
 * Commits for a project, via the SAME D5 join the M6 projections use
 * (`repo_root_path = workspace_keys.project_key → workspaces.project_id`). Newest
 * first by `authored_at` (ISO `mode:"string"` — ordered + returned verbatim). A
 * commit whose repo root maps to no workspace is captured but NOT returned here
 * (unattributed — counted, not joined). Plaintext only (no commit message).
 */
export async function gitCommitsByProject(
  db: DbClient,
  projectId: string,
): Promise<GitCommitRow[]> {
  const rows = await db
    .select(gitCommitRowColumns)
    .from(gitCommits)
    .innerJoin(workspaceKeys, eq(gitCommits.repoRootPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(workspaces.projectId, projectId))
    .orderBy(desc(gitCommits.authoredAt));
  return rows;
}

/** A single commit (id + plaintext projection + its changed files), for the manual-link path. */
export interface GitCommitDetail {
  id: string;
  commit: GitCommitRow;
  files: GitFileChange[];
}

/**
 * Resolve a commit by SHA, scoped to the user (via `machines.user_id` — a commit
 * has no userId of its own). Returns the commit id (so a route can create a link)
 * + its files, or `undefined` for an unknown SHA → the route turns that into a
 * clean 404 (never an FK-violation 500 on the link insert). Scoped by userId per
 * CLAUDE.md; the admin route supplies the userId (the manual-link path has no
 * machine token, and a SHA is git's globally-unique content hash).
 */
export async function gitCommitDetail(
  db: DbClient,
  userId: string,
  commitSha: string,
): Promise<GitCommitDetail | undefined> {
  const [row] = await db
    .select({ id: gitCommits.id, ...gitCommitRowColumns })
    .from(gitCommits)
    .innerJoin(machines, eq(machines.id, gitCommits.machineId))
    .where(and(eq(machines.userId, userId), eq(gitCommits.commitSha, commitSha)))
    .limit(1);
  if (!row) return undefined;
  const { id, ...commit } = row;
  const files = await db
    .select({
      path: gitCommitFiles.filePath,
      status: gitCommitFiles.status,
      insertions: gitCommitFiles.insertions,
      deletions: gitCommitFiles.deletions,
    })
    .from(gitCommitFiles)
    .where(eq(gitCommitFiles.commitId, id));
  return { id, commit, files: files as GitFileChange[] };
}
