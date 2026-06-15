#!/usr/bin/env node
/**
 * build-sea — package the collector `serve` entry as a standalone `node:sea` `.exe`
 * for the M11 Tauri sidecar (PRD §25 item 11). The recipe is the one the
 * control-protocol spike validated end-to-end (docs/research/m11-control-protocol-spike.md):
 *
 *   esbuild src/serve.ts → CJS  (bundle FROM SOURCE — the composite `dist` failed
 *                                a sibling resolution in the spike)
 *   node --experimental-sea-config → sea-prep.blob
 *   copy process.execPath → binaries/collector-x86_64-pc-windows-msvc.exe
 *   postject the blob into the copy   (--sentinel-fuse <fuse>)
 *
 * Output: apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe
 * (the `-$TARGET_TRIPLE` suffix is REQUIRED by Tauri's externalBin bundling).
 *
 *   node apps/collector/scripts/build-sea.mjs           # full SEA build (Windows local sign-off)
 *   node apps/collector/scripts/build-sea.mjs --check   # cheap: just bundle + run {"cmd":"status"} under node
 *
 * Spike assertions encoded here: `node:sqlite` needs NO runtime flag in Node 24;
 * the artifact is ~88 MB; the postject "signature seems corrupted" warning on
 * Windows is EXPECTED (we patch the signed node.exe). Exits non-zero on any failure.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const NODE_SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const here = dirname(fileURLToPath(import.meta.url));
const collectorRoot = resolve(here, "..");
const repoRoot = resolve(collectorRoot, "..", "..");
const serveEntry = join(collectorRoot, "src", "serve.ts");
const outDir = join(repoRoot, "apps", "desktop", "src-tauri", "binaries");
const outExe = join(outDir, `collector-${TARGET_TRIPLE}.exe`);

const check = process.argv.includes("--check");

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function die(msg, err) {
  console.error(`  ✗ ${msg}${err ? `\n      ${String(err.message ?? err)}` : ""}`);
  process.exit(1);
}

async function bundle(outfile) {
  // Bundle the TS SOURCE to a single CJS file. platform:node auto-externalizes
  // builtins (node:sqlite / node:sea stay external, resolved by the embedded runtime).
  await build({
    entryPoints: [serveEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node:*"],
    outfile,
    logLevel: "warning",
  });
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "collector-sea-"));
  try {
    const cjs = join(tmp, "collector.cjs");
    console.log("[1] esbuild bundle (src/serve.ts → CJS)");
    await bundle(cjs).catch((err) => die("esbuild bundle failed", err));
    ok(`bundled ${(statSync(cjs).size / 1024).toFixed(0)} KB → ${cjs}`);

    if (check) {
      // Cheap cross-platform smoke: run the bundle under `node` and assert it
      // answers a status command with a JSON status line (no SEA/postject needed).
      console.log("[2] --check: run {\"cmd\":\"status\"} under node");
      let out;
      try {
        out = execFileSync(process.execPath, [cjs, "serve"], {
          input: '{"cmd":"status"}\n',
          encoding: "utf8",
          timeout: 15_000,
        });
      } catch (err) {
        // The bundle exits 0 on stdin EOF, but capture stdout even if signaled.
        out = String(err.stdout ?? "");
      }
      const sawStatus = out
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          try {
            return JSON.parse(line).type === "status";
          } catch {
            return false;
          }
        });
      if (!sawStatus) die(`--check: no status JSON line in output:\n${out}`);
      ok("bundle emits a status JSON line under node");
      console.log("\nbuild-sea --check: PASS");
      return;
    }

    console.log("[2] node --experimental-sea-config → blob");
    const blob = join(tmp, "sea-prep.blob");
    const seaConfig = join(tmp, "sea-config.json");
    writeFileSync(
      seaConfig,
      JSON.stringify({ main: cjs, output: blob, disableExperimentalSEAWarning: true }, null, 2),
    );
    try {
      execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], {
        stdio: "inherit",
      });
    } catch (err) {
      die("sea-config generation failed", err);
    }
    ok(`blob written → ${blob}`);

    console.log("[3] copy node runtime → sidecar binary");
    mkdirSync(outDir, { recursive: true });
    copyFileSync(process.execPath, outExe);
    ok(`copied ${process.execPath} → ${outExe}`);

    console.log("[4] postject inject NODE_SEA_BLOB (the 'signature corrupted' warning is expected)");
    // Resolve postject's CLI by package, not a hardcoded hoist path (portable across
    // npm/pnpm layouts and a future workspace-local install).
    const postjectCli = createRequire(import.meta.url).resolve("postject/dist/cli.js");
    try {
      execFileSync(
        process.execPath,
        [
          postjectCli,
          outExe,
          "NODE_SEA_BLOB",
          blob,
          "--sentinel-fuse",
          NODE_SEA_FUSE,
        ],
        { stdio: "inherit" },
      );
    } catch (err) {
      die("postject injection failed", err);
    }

    const mb = (statSync(outExe).size / 1024 / 1024).toFixed(0);
    ok(`SEA artifact ready: ${outExe} (${mb} MB)`);
    console.log(
      `\nbuild-sea: PASS — verify with:\n  echo '{"cmd":"status"}' | "${outExe}" serve`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => die("build-sea crashed", err));
