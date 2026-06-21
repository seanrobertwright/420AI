import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitFileChange } from "@420ai/shared";

/**
 * Git-history reader (M10, PRD §11.3). Reads a repo's commits via a `git log`
 * SUBPROCESS (D1 — full §11.3 commit/numstat/changed-file capture is infeasible by
 * reading `.git` objects directly; this deviates from `git-meta.ts`'s no-subprocess
 * pattern, which is a LOCAL pattern for trivial HEAD/config scalars, not a repo
 * invariant). Uses `execFile` with an arg-array (NO shell) so a repo path can never
 * inject. Library file: no logging; graceful-degrades to `[]` when git is absent or
 * the path is not a repo.
 *
 * The `--format` + parse strategy is VERIFIED against this repo (Phase-0 spike):
 *   `\x1fCOMMIT\x1f` delimits records (two US control bytes around COMMIT — cannot
 *   occur inside a commit message), `\x1f` delimits the 8 header fields, and the
 *   last field is `<body>\x1e<numstat block>`.
 */

const execFileAsync = promisify(execFile);

/** Pinned `git log` format (Phase-0). %x1f = unit-sep field delimiter, %x1e = record-sep ending the header. */
const GIT_LOG_FORMAT = "%x1fCOMMIT%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%P%x1f%s%x1f%b%x1e";
const RECORD_SEP = "\x1fCOMMIT\x1f";
const FIELD_SEP = "\x1f";
const BODY_SEP = "\x1e";
const DEFAULT_CAP = 500;
const MAX_BUFFER = 64 * 1024 * 1024;

/** One parsed commit (≈ GitCommitPayload minus repoRootPath/gitBranch, which the caller adds). */
export interface GitCommit {
  commitSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string; // ISO (offset OR Z form — verbatim)
  committedAt: string;
  message: string;
  parents: string[];
  isRevert: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: GitFileChange[];
}

/** readGitLog result — `capped` is true when more history exists than `cap` read (no silent truncation). */
export interface GitLogResult {
  commits: GitCommit[];
  capped: boolean;
}

/**
 * Resolve a numstat path field to the effective (new) path, normalizing git's two
 * rename forms: `old => new` (simple) and `dir/{old => new}/file` (brace). Returns
 * the new path; brace groups are collapsed and any doubled slash removed.
 */
function newPathOf(raw: string): string {
  if (!raw.includes("=>")) return raw;
  if (raw.includes("{")) {
    return raw
      .replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1")
      .replace(/\/{2,}/g, "/")
      .trim();
  }
  const idx = raw.indexOf("=>");
  return raw.slice(idx + 2).trim();
}

/** Parse one `--numstat` block into changed files + summed insertions/deletions. Binary rows (`-`/`-`) → 0/0. */
function parseNumstat(text: string): {
  files: GitFileChange[];
  insertions: number;
  deletions: number;
} {
  const files: GitFileChange[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // merges (and the leading newline) have an empty numstat block
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [insRaw, delRaw, rawPath] = parts as [string, string, string];
    // Binary files report `-` for both counts → 0/0 (never NaN).
    const ins = insRaw === "-" ? 0 : Number.parseInt(insRaw, 10) || 0;
    const del = delRaw === "-" ? 0 : Number.parseInt(delRaw, 10) || 0;
    const isRename = rawPath.includes("=>");
    files.push({
      path: newPathOf(rawPath),
      status: isRename ? "renamed" : "modified",
      insertions: ins,
      deletions: del,
    });
    insertions += ins;
    deletions += del;
  }
  return { files, insertions, deletions };
}

/**
 * Pure parser over a captured `git log` stdout (NO live git — unit-testable). Splits
 * on the `\x1fCOMMIT\x1f` record delimiter, then per block splits the 8 header fields
 * on `\x1f` and the last field on `\x1e` into `[body, numstat]`. Tolerates an empty
 * numstat block (merge commits) and an empty body.
 */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const block of stdout.split(RECORD_SEP)) {
    if (block.trim() === "") continue; // the empty leading element before the first record
    const fields = block.split(FIELD_SEP);
    if (fields.length < 8) continue; // malformed — skip defensively
    const [sha, authorName, authorEmail, authoredAt, committedAt, parentsRaw, subject, last] =
      fields as [string, string, string, string, string, string, string, string];
    const sepIdx = last.indexOf(BODY_SEP);
    const body = (sepIdx >= 0 ? last.slice(0, sepIdx) : last).trimEnd();
    const numstatText = sepIdx >= 0 ? last.slice(sepIdx + 1) : "";

    const parents = parentsRaw.trim() === "" ? [] : parentsRaw.trim().split(/\s+/);
    const message = body ? `${subject}\n\n${body}` : subject;
    const isRevert = subject.startsWith("Revert ") || body.includes("This reverts commit");
    const { files, insertions, deletions } = parseNumstat(numstatText);

    commits.push({
      commitSha: sha,
      authorName,
      authorEmail,
      authoredAt,
      committedAt,
      message,
      parents,
      isRevert,
      filesChanged: files.length,
      insertions,
      deletions,
      files,
    });
  }
  return commits;
}

/** Count the repo's total commits on HEAD (to detect that `cap` truncated history). 0 on error. */
async function totalCommits(repoRoot: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-list", "--count", "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Read up to `cap` commits (newest first) from a repo via `git log --numstat`. Returns
 * `[]` (never throws) when git is missing (ENOENT) or the path is not a repo — a
 * non-repo root is normal in a sweep. Sets `capped` when more history exists than read.
 */
export async function readGitLog(repoRoot: string, opts?: { cap?: number }): Promise<GitLogResult> {
  const cap = opts?.cap ?? DEFAULT_CAP;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "log",
        "-n",
        String(cap),
        "--numstat",
        "--date=iso-strict",
        `--format=${GIT_LOG_FORMAT}`,
      ],
      { maxBuffer: MAX_BUFFER },
    );
    const commits = parseGitLog(stdout);
    // No-silent-cap (CLAUDE.md): only pay for the count query when we actually hit the cap.
    const capped = commits.length >= cap ? (await totalCommits(repoRoot)) > cap : false;
    return { commits, capped };
  } catch {
    return { commits: [], capped: false }; // git absent / not a repo → graceful degrade
  }
}
