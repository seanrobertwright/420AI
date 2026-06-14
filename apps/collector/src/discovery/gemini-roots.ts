import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure Gemini reverse-map reader (M5, D3 — [VERIFIED]). Gemini stamps an opaque
 * `projectHash` on each event's `project_path`; the real path is recoverable ONLY
 * from a `.project_root` sidecar Gemini writes per tmp dir (NOT by hash-cracking —
 * the algorithm is unconfirmed and slug/hash dirs are disjoint generations).
 *
 * Maps each `~/.gemini/tmp/<dirName>` that HAS a `.project_root` to its real path.
 * `dirName` == the in-file `projectHash` == `events[].project_path` for Gemini,
 * so this map bridges the hash to a real root. Dirs without a sidecar are absent
 * (legacy hash-only sessions stay unattributed — a recorded gap, not an error).
 *
 * Library file: synchronous + side-effect-free; takes `home` so tests inject a
 * tmp dir. Returns an empty map when there is no `~/.gemini/tmp`.
 */
export function scanGeminiProjectRoots(home: string): Map<string, string> {
  const tmp = join(home, ".gemini", "tmp");
  const out = new Map<string, string>();
  if (!existsSync(tmp)) return out;
  for (const dirName of readdirSync(tmp)) {
    const pr = join(tmp, dirName, ".project_root");
    if (existsSync(pr)) out.set(dirName, readFileSync(pr, "utf8").trim());
  }
  return out;
}
