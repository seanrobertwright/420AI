import { and, desc, eq } from "drizzle-orm";
import type { GitCaptureRequest, GitCommitRow, GitFileChange } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { encryptField } from "../crypto.js";
import { gitCommitFiles, gitCommits, machines, workspaceKeys, workspaces } from "../schema.js";
import { getMachineOrgId } from "./machines.js";

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
  db: DbClient,
  machineId: string,
  req: GitCaptureRequest,
): Promise<{ commitsInserted: number }> {
  return db.transaction(async (tx) => {
    // M15 15.1: derived once from `machines.org_id`; the file rows below reuse it —
    // a file row's org IS its parent commit's org by construction.
    const orgId = await getMachineOrgId(tx, machineId);
    if (!orgId) throw new Error(`unknown machine ${machineId}`);

    let commitsInserted = 0;
    for (const c of req.commits) {
      // Empty body is normal (a commit with no `%b`) → store NULL, not an encrypted "".
      const enc = c.message ? encryptField(c.message) : null;
      const inserted = await tx
        .insert(gitCommits)
        .values({
          orgId,
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
            orgId,
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
  orgId: string,
  projectId: string,
): Promise<GitCommitRow[]> {
  const rows = await db
    .select(gitCommitRowColumns)
    .from(gitCommits)
    .innerJoin(workspaceKeys, eq(gitCommits.repoRootPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    // M15 15.2: `repo_root_path` is a machine-supplied PATH string joined to
    // `project_key` — the same globally-scoped-key defect as the M6 rollups, so the
    // org predicate is required, not defensive.
    .where(
      and(
        eq(workspaces.projectId, projectId),
        eq(workspaceKeys.orgId, orgId),
        eq(gitCommits.orgId, orgId),
      ),
    )
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
 * Resolve a commit by SHA, scoped to the org AND the user (a commit has no userId of its own —
 * it reaches one through `machines`). Returns the commit id (so a route can create a link)
 * + its files, or `undefined` for an unknown SHA → the route turns that into a
 * clean 404 (never an FK-violation 500 on the link insert).
 *
 * M15 15.4 — `orgId` SECOND, on BOTH the fact table (`gitCommits.orgId`, isolation) and the join
 * (`machines.orgId`, ownership). That was the real defect: a commit SHA is git's globally-unique
 * content hash, so two TENANTS working the same repo genuinely share the key, and before the org
 * predicate RLS was the only thing between them.
 *
 * The `machines.userId` predicate deliberately STAYS, unlike the visibility reads that dropped
 * theirs (D-15.4-2). This is not a UI read — its only caller is
 * `POST /v1/sessions/:sessionId/git-links`, and the whole git-link neighbourhood is per-user by
 * INDEX design: `session_git_links` is unique on `(user_id, session_id, commit_id)`, and
 * `listSessionLinks` / `computeSessionGitSuggestions` / the candidate-commit query in
 * `attribution.ts` all filter `machines.user_id`. Widening only this one read produced a real
 * regression, caught in review: a member could pass the 404 existence check on a COLLEAGUE's
 * commit, then `resolveWorkspaceId` (which keeps its own `user_id` predicate) would resolve
 * nothing, and `addManualLink` would store `project_id = NULL` — a clean 404 turned into a
 * silently unattributed link. Org-wide manual git-linking is a feature decision for a later
 * slice, and it needs `session_git_links`' unique index changed to match.
 *
 * The file read is keyed on the already-verified `commitId`, and `git_commit_files` carries its
 * own strict policy.
 */
export async function gitCommitDetail(
  db: DbClient,
  orgId: string,
  userId: string,
  commitSha: string,
): Promise<GitCommitDetail | undefined> {
  const [row] = await db
    .select({ id: gitCommits.id, ...gitCommitRowColumns })
    .from(gitCommits)
    .innerJoin(machines, eq(machines.id, gitCommits.machineId))
    .where(
      and(
        eq(gitCommits.orgId, orgId),
        eq(machines.orgId, orgId),
        eq(machines.userId, userId),
        eq(gitCommits.commitSha, commitSha),
      ),
    )
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
    .where(and(eq(gitCommitFiles.orgId, orgId), eq(gitCommitFiles.commitId, id)));
  return { id, commit, files: files as GitFileChange[] };
}
