#!/usr/bin/env node
/**
 * repo-health — the enforced pre-commit gate (system review M1-3, root cause #1:
 * "validation was a checklist, not a gate"). Run from repo root.
 *
 *   node scripts/repo-health.mjs           # full: typecheck + tests + hygiene scans
 *   node scripts/repo-health.mjs --fast    # skip the test suite (used by the git hook)
 *
 * Exits non-zero if ANY check fails, so it can block a commit / CI step. Each
 * check prints a clear PASS/FAIL line; failures explain what to fix.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const fast = process.argv.includes("--fast");
const failures = [];
const root = process.cwd();

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(check, detail) {
  failures.push(check);
  console.log(`  ✗ ${check}\n      ${detail.split("\n").join("\n      ")}`);
}
function run(cmd) {
  execSync(cmd, { stdio: "inherit", shell: true });
}

// --- Check 1: NUL-byte scan over tracked text sources ---------------------
// A source written with embedded NULs passes typecheck + tests (the compiler
// tolerates NULs in comments) yet is corrupt and stored as a binary blob.
console.log("\n[1/4] NUL-byte scan (tracked text sources)");
try {
  const exts = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|sql|sh)$/;
  const tracked = execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && exts.test(s));
  const corrupt = [];
  for (const rel of tracked) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (readFileSync(abs).includes(0x00)) corrupt.push(rel);
  }
  if (corrupt.length) {
    fail("NUL bytes found in text source(s)", corrupt.join("\n"));
  } else {
    ok(`${tracked.length} tracked text files clean`);
  }
} catch (err) {
  fail("NUL-byte scan errored", String(err.message ?? err));
}

// --- Check 2: stray build artifacts under any src/ ------------------------
// src dirs are TypeScript-only; emitted .js/.d.ts/.map there are stray builds
// (this is how M3's failed cross-project build leaked .js into apps/ingest/src).
console.log("\n[2/4] Stray build-artifact scan (src/ dirs)");
try {
  const srcDirs = [];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, "src");
      if (existsSync(src) && statSync(src).isDirectory()) srcDirs.push(src);
    }
  }
  const emitted = /\.(js|cjs|mjs|map)$|\.d\.ts$/;
  const stray = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (emitted.test(entry.name)) stray.push(p.slice(root.length + 1));
    }
  };
  srcDirs.forEach(walk);
  if (stray.length) {
    fail(
      "emitted artifacts found under src/",
      stray.join("\n") + "\n(remove with: git clean -fx <paths>)",
    );
  } else {
    ok(`no emitted artifacts in ${srcDirs.length} src/ dirs`);
  }
} catch (err) {
  fail("artifact scan errored", String(err.message ?? err));
}

// --- Check 3: typecheck (root tsc -b) ------------------------------------
console.log("\n[3/4] Typecheck (root tsc -b)");
try {
  run("npm run typecheck");
  ok("tsc -b: 0 errors");
} catch {
  fail("typecheck failed", "run `npm run typecheck` and fix the reported errors");
}

// --- Check 4: test suite (vitest) ----------------------------------------
if (fast) {
  console.log("\n[4/4] Test suite — SKIPPED (--fast)");
} else {
  console.log("\n[4/4] Test suite (vitest run)");
  try {
    run("npx vitest run");
    ok("vitest: all tests passed");
  } catch {
    fail("tests failed", "run `npx vitest run` and fix the failures");
  }
}

// --- Summary -------------------------------------------------------------
console.log("\n" + "=".repeat(48));
if (failures.length) {
  console.log(`repo-health: FAIL (${failures.length}) -> ${failures.join("; ")}`);
  process.exit(1);
}
console.log("repo-health: PASS");
