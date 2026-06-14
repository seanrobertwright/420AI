import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure git-metadata reader (M5). Reads a repo's remote + branch straight from its
 * `.git` files — NO `git` subprocess (deterministic, testable, no PATH/cwd
 * dependency). [VERIFIED] formats on this repo:
 *   - `.git/HEAD`   = `ref: refs/heads/<branch>`  (detached HEAD = bare sha)
 *   - `.git/config` = `[remote "origin"]\n\turl = <url>`
 *
 * Library file: synchronous + side-effect-free, returns `{}` for a non-repo.
 */
export interface GitMeta {
  remote?: string;
  branch?: string;
}

export function readGitMeta(repoRoot: string): GitMeta {
  const gitDir = join(repoRoot, ".git");
  if (!existsSync(gitDir)) return {};

  let branch: string | undefined;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    branch = m ? m[1] : undefined; // detached HEAD (bare sha) → undefined
  } catch {
    /* no HEAD */
  }

  let remote: string | undefined;
  try {
    const cfg = readFileSync(join(gitDir, "config"), "utf8");
    // Lazily skip within the [remote "origin"] section (newlines allowed — `.`
    // would need /s, but `[^[]` already spans lines) up to `url =`, then capture
    // ONLY to end-of-line (a real config has a `fetch = …` line right after url,
    // so a greedy dotall `.+` would swallow it — hence `[^\r\n]+`).
    const m = /\[remote "origin"\][^[]*?url\s*=\s*([^\r\n]+)/.exec(cfg);
    remote = m ? m[1]!.trim() : undefined;
  } catch {
    /* no config */
  }

  return { remote, branch };
}
