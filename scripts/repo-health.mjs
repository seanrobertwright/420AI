#!/usr/bin/env node
/**
 * repo-health — the enforced pre-commit gate (system review M1-3, root cause #1:
 * "validation was a checklist, not a gate"). Run from repo root.
 *
 *   node scripts/repo-health.mjs              # full: typecheck + tests + hygiene scans
 *   node scripts/repo-health.mjs --fast       # skip the test suite (used by the git hook)
 *   node scripts/repo-health.mjs --require-db # milestone sign-off: FAIL if the integration
 *                                             # layer self-skipped (system review M4-6, root
 *                                             # cause: a green gate with int tests skipped is
 *                                             # NOT green — that hid the M5 lastActivity bug).
 *
 * Exits non-zero if ANY check fails, so it can block a commit / CI step. Each
 * check prints a clear PASS/FAIL line; failures explain what to fix.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fast = process.argv.includes("--fast");
const requireDb = process.argv.includes("--require-db");
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

// Is the integration DB configured the same way the test run resolves it? vitest
// loads DATABASE_URL_TEST from .env, so checking process.env alone gives a false
// negative when the var lives only in the (gitignored) .env file.
function hasTestDbConfigured() {
  if (process.env.DATABASE_URL_TEST) return true;
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return false;
  return /^\s*DATABASE_URL_TEST\s*=\s*\S/m.test(readFileSync(envPath, "utf8"));
}

// --- Check 1: NUL-byte scan over tracked text sources ---------------------
// A source written with embedded NULs passes typecheck + tests (the compiler
// tolerates NULs in comments) yet is corrupt and stored as a binary blob.
console.log("\n[1/5] NUL-byte scan (tracked text sources)");
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
console.log("\n[2/5] Stray build-artifact scan (src/ dirs)");
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
console.log("\n[3/5] Typecheck (root tsc -b)");
try {
  run("npm run typecheck");
  ok("tsc -b: 0 errors");
} catch {
  fail("typecheck failed", "run `npm run typecheck` and fix the reported errors");
}

// --- Check 4: dashboard typecheck lane (D9) ------------------------------
// The Next.js dashboard is DELIBERATELY out of the root tsc -b graph (it needs
// moduleResolution:bundler + jsx), so the root typecheck above will NEVER catch a
// dashboard type error. This lane is the ONLY enforcement — a convention is not
// enough (system review M4-6, "conditional-gate / silent-skip" trap, extended here).
console.log("\n[4/5] Dashboard typecheck lane (tsc --noEmit -w @420ai/dashboard)");
try {
  run("npm run typecheck:dashboard");
  ok("dashboard tsc --noEmit: 0 errors");
} catch {
  fail(
    "dashboard typecheck failed",
    "run `npm run typecheck:dashboard` and fix the reported errors (the root tsc -b cannot see these)",
  );
}

// --- Check 5: test suite (vitest) ----------------------------------------
if (fast) {
  console.log("\n[5/5] Test suite — SKIPPED (--fast)");
} else if (requireDb && !hasTestDbConfigured()) {
  // The integration layer self-skips without DATABASE_URL_TEST, and a skipped
  // layer still reports green — so at milestone sign-off, refuse to run blind.
  console.log("\n[5/5] Test suite (--require-db)");
  fail(
    "DATABASE_URL_TEST unset (--require-db)",
    "every *.int.test.ts would self-skip → the DB-backed layer is never exercised.\n" +
      "Start the test DB and re-run, e.g.:\n" +
      "  npm run db:up && npm run db:migrate\n" +
      "  DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm run repo-health -- --require-db",
  );
} else if (requireDb) {
  // Run with a JSON reporter alongside the console one so we can assert the
  // integration tests actually RAN (ran > 0, skipped === 0), not merely that
  // the suite was green with the int files quietly skipped (skipped ≠ passed).
  console.log("\n[5/5] Test suite (vitest run, --require-db)");
  const out = join(tmpdir(), `repo-health-vitest-${process.pid}.json`);
  let suitePassed = true;
  try {
    run(`npx vitest run --reporter=default --reporter=json --outputFile=${JSON.stringify(out)}`);
  } catch {
    suitePassed = false;
    fail("tests failed", "run `npx vitest run` and fix the failures");
  }
  if (suitePassed) {
    try {
      const report = JSON.parse(readFileSync(out, "utf8"));
      let ran = 0;
      let skipped = 0;
      for (const f of report.testResults ?? []) {
        if (!/\.int\.test\.[tj]sx?$/.test(f.name ?? "")) continue;
        for (const a of f.assertionResults ?? []) {
          if (a.status === "skipped" || a.status === "pending" || a.status === "todo") skipped++;
          else ran++;
        }
      }
      if (ran === 0) {
        fail(
          "no integration tests ran (--require-db)",
          "every *.int.test.ts self-skipped — the DB layer was not exercised. Confirm the test DB is up and migrated.",
        );
      } else if (skipped > 0) {
        fail(
          `${skipped} integration test(s) skipped (--require-db)`,
          "some *.int.test.ts self-skipped; the DB-backed layer is only partially exercised.",
        );
      } else {
        ok(`vitest: all tests passed (${ran} integration tests ran, 0 skipped)`);
      }
    } catch (err) {
      fail("could not verify integration coverage (--require-db)", String(err.message ?? err));
    } finally {
      rmSync(out, { force: true });
    }
  } else {
    rmSync(out, { force: true });
  }
} else {
  console.log("\n[5/5] Test suite (vitest run)");
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
