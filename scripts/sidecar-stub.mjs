#!/usr/bin/env node
/**
 * sidecar-stub — write a 0-byte stand-in for the collector sidecar so the Tauri
 * crate can be `cargo check`ed on machines that have no real sidecar (M17 17.0).
 *
 * `tauri_build::build()` validates that every `externalBin` entry EXISTS at
 * `binaries/collector-<host-triple><.exe on windows>` inside the BUILD SCRIPT,
 * so even a pure type-check of the crate fails without the file. The check is
 * existence-only (measured, 17.0 spike S3b): an empty file passes. Building the
 * real SEA sidecar per platform is slice 17.3's job; CI's Rust lanes only need
 * the crate to compile, so they run this first.
 *
 *   node scripts/sidecar-stub.mjs
 *
 * Refuses to overwrite a NON-EMPTY existing file — on a dev machine the real
 * locally-built sidecar lives at exactly this path (build-sea.mjs), and a tool
 * that silently truncated it would be a footgun. Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Must match tauri.conf.json `externalBin: ["binaries/collector"]` and
// build-sea.mjs's `collector-${TARGET_TRIPLE}` naming.
const SIDECAR_BASENAME = "collector";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binariesDir = join(repoRoot, "apps", "desktop", "src-tauri", "binaries");

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function die(msg, err) {
  console.error(`  ✗ ${msg}${err ? `\n      ${String(err.message ?? err)}` : ""}`);
  process.exit(1);
}

/**
 * The exact filename Tauri's externalBin bundling expects for a host triple:
 * `<basename>-<triple>` plus `.exe` on Windows only.
 *
 * Pure — exported for the unit test.
 *
 * @param {string} hostTriple e.g. "x86_64-pc-windows-msvc"
 * @param {string} platform a `process.platform` value, e.g. "win32" | "linux" | "darwin"
 * @returns {string}
 */
export function sidecarFileName(hostTriple, platform) {
  const exeSuffix = platform === "win32" ? ".exe" : "";
  return `${SIDECAR_BASENAME}-${hostTriple}${exeSuffix}`;
}

function hostTriple() {
  // `rustc -vV` prints a `host: <triple>` line. Parse it in JS — no `sed`, this
  // must run on plain Windows runners where POSIX tools may be absent.
  let out;
  try {
    out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  } catch (err) {
    die("rustc not found — a Rust toolchain is required to derive the host triple", err);
  }
  const match = /^host:\s*(\S+)$/m.exec(out);
  if (!match) die(`could not parse a "host:" line out of \`rustc -vV\` output:\n${out}`);
  return match[1];
}

function main() {
  const triple = hostTriple();
  ok(`host triple: ${triple}`);

  const target = join(binariesDir, sidecarFileName(triple, process.platform));

  if (existsSync(target)) {
    const { size } = statSync(target);
    if (size > 0) {
      // A real sidecar (build-sea.mjs output, ~88 MB) — never clobber it.
      ok(`real sidecar already present (${size} bytes) — leaving it alone: ${target}`);
      return;
    }
    ok(`stub already present: ${target}`);
    return;
  }

  try {
    mkdirSync(binariesDir, { recursive: true });
    writeFileSync(target, "");
  } catch (err) {
    die(`failed to write stub sidecar at ${target}`, err);
  }
  ok(`wrote 0-byte stub sidecar: ${target}`);
}

// Only run when executed directly — the unit test imports `sidecarFileName`
// from this module and must not trigger a rustc invocation or a file write.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
