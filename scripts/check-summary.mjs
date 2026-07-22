#!/usr/bin/env node
/**
 * check-summary — doc-consistency gate for SUMMARY.md (RCA 2026-07-22).
 *
 * ROOT CAUSE it prevents: SUMMARY.md is a hand-maintained PROJECTION of the repo's real
 * ground truth (the per-slice `.agents/execution-reports/*.md` files, which the gated
 * `/lril:execution-report` step reliably produces when a slice ships). Nothing rebuilt or
 * checked that projection, so it silently drifted — M14 slices 14.2/14.3/14.4 shipped
 * (execution reports written, PRs merged) yet SUMMARY still showed them un-done and the
 * milestone "IN PROGRESS". This is the same "projection without a rebuild path drifts"
 * failure the codebase already guards for events; here we give the doc a CHECK path.
 *
 * THE RULE (one-directional, the direction that catches drift):
 *   For every shipped slice — i.e. every `.agents/execution-reports/m<M>-slice<S>-*.md` —
 *   SUMMARY.md must mark that slice `<M>.<S>` done with a ✅ adjacent to its bold token
 *   (`**14.2** ✅` or `✅ **14.2**`), UNLESS milestone M is declared fully done in SUMMARY
 *   (`**M12 (...)** is **DONE**`), in which case milestone-level done subsumes per-slice
 *   marks and no per-slice ✅ is required.
 *
 * Consequence: enforcement is automatic and self-relaxing — an IN-PROGRESS milestone (M14
 * today) is held to per-slice accuracy; once it is marked `is **DONE**`, the per-slice
 * requirement lifts. Only milestones with per-slice execution reports (M12/M13/M14) are
 * ever considered; aggregate reports (e.g. `m7-m9-*.md`) and non-slice files are ignored.
 *
 * Pure + dependency-free (like `repo-health.mjs`); safe in `--fast` (no infra). Run
 * standalone (`node scripts/check-summary.mjs`) or via `repo-health`, which imports
 * `checkSummaryConsistency`.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Expand an execution-report basename's slice segment into the slice ids it covers.
 * `m14-slice2-...`   → ["14.2"]
 * `m12-slice7a-...`  → ["12.7a"]
 * `m14-slice0-1-...` → ["14.0", "14.1"]  (a combined report, e.g. spike + truth)
 * Non-slice reports (aggregates like `m7-m9-execution`) → [] (ignored).
 */
export function sliceIdsFromReportName(name) {
  const m = /^m(\d+)-slice([0-9]+(?:-[0-9]+)*[a-z]?)/.exec(name);
  if (!m) return [];
  const milestone = m[1];
  const seg = m[2]; // e.g. "2", "7a", "0-1"
  const suffix = /[a-z]$/.exec(seg)?.[0] ?? "";
  const nums = seg.replace(/[a-z]$/, "").split("-");
  // A trailing letter belongs to a single-number slice (7a); a numeric range (0-1) has none.
  return nums.map((n, i) => `${milestone}.${n}${i === nums.length - 1 ? suffix : ""}`);
}

/** Milestones SUMMARY declares fully done (`**M12 (...)** is **DONE**`). */
function doneMilestones(summary) {
  const done = new Set();
  const re = /\*\*M(\d+)\b[^*\n]*\*\*\s+is\s+\*\*DONE\*\*/g;
  let m;
  while ((m = re.exec(summary)) !== null) done.add(m[1]);
  return done;
}

/** True if SUMMARY marks `<id>` done — a ✅ adjacent to the bold token, either ordering. */
function sliceMarkedDone(summary, id) {
  const token = `**${id}**`;
  for (let idx = summary.indexOf(token); idx !== -1; idx = summary.indexOf(token, idx + 1)) {
    const window = summary.slice(Math.max(0, idx - 4), idx + token.length + 4);
    if (window.includes("✅")) return true;
  }
  return false;
}

/**
 * @param {string} root repo root
 * @returns {{ problems: string[], enforced: string[], relaxed: string[] }}
 *   problems — human-readable messages for shipped slices missing a ✅ in SUMMARY.
 *   enforced — slice ids that were required to be ✅ (in-progress milestones).
 *   relaxed  — slice ids skipped because their milestone is fully DONE.
 */
export function checkSummaryConsistency(root) {
  const summaryPath = join(root, "SUMMARY.md");
  const reportsDir = join(root, ".agents", "execution-reports");
  if (!existsSync(summaryPath)) {
    return { problems: ["SUMMARY.md not found at repo root"], enforced: [], relaxed: [] };
  }
  const summary = readFileSync(summaryPath, "utf8");
  const done = doneMilestones(summary);

  const reports = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((f) => f.endsWith(".md"))
    : [];

  const problems = [];
  const enforced = [];
  const relaxed = [];
  const seen = new Set();

  for (const file of reports) {
    for (const id of sliceIdsFromReportName(file)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const milestone = id.split(".")[0];
      if (done.has(milestone)) {
        relaxed.push(id);
        continue;
      }
      enforced.push(id);
      if (!sliceMarkedDone(summary, id)) {
        problems.push(
          `slice ${id} shipped (execution report ${file}) but SUMMARY.md does not mark it done ` +
            `(expected a ✅ next to \`**${id}**\`, or declare milestone M${milestone} \`is **DONE**\`)`,
        );
      }
    }
  }
  return { problems, enforced, relaxed };
}

// --- standalone entrypoint ------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.cwd();
  const { problems, enforced, relaxed } = checkSummaryConsistency(root);
  if (problems.length) {
    console.log(`check-summary: FAIL (${problems.length})`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  const detail =
    enforced.length > 0
      ? `${enforced.length} in-progress slice(s) marked done, ${relaxed.length} under a DONE milestone`
      : `${relaxed.length} slice(s) under DONE milestones; nothing to enforce`;
  console.log(`check-summary: PASS — ${detail}`);
}
