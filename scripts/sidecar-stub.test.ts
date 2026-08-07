import { describe, expect, it } from "vitest";

import { sidecarFileName } from "./sidecar-stub.mjs";

// One case per CI lane in .github/workflows/cross-platform.yml. The names must
// match what tauri_build::build() derives from `externalBin: ["binaries/collector"]`:
// `collector-<host triple>` plus `.exe` on Windows ONLY (17.0 spike S3).
const LANES: Array<{ triple: string; platform: string; expected: string }> = [
  {
    triple: "x86_64-pc-windows-msvc",
    platform: "win32",
    expected: "collector-x86_64-pc-windows-msvc.exe",
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    platform: "linux",
    expected: "collector-x86_64-unknown-linux-gnu",
  },
  {
    triple: "aarch64-unknown-linux-gnu",
    platform: "linux",
    expected: "collector-aarch64-unknown-linux-gnu",
  },
  {
    triple: "x86_64-apple-darwin",
    platform: "darwin",
    expected: "collector-x86_64-apple-darwin",
  },
  {
    triple: "aarch64-apple-darwin",
    platform: "darwin",
    expected: "collector-aarch64-apple-darwin",
  },
];

describe("sidecarFileName", () => {
  for (const { triple, platform, expected } of LANES) {
    it(`${triple} on ${platform} → ${expected}`, () => {
      expect(sidecarFileName(triple, platform)).toBe(expected);
    });
  }

  it("only the win32 lane gets an extension suffix", () => {
    const withSuffix = LANES.filter(
      ({ triple, platform }) => sidecarFileName(triple, platform) !== `collector-${triple}`,
    );
    expect(withSuffix).toHaveLength(1);
    expect(withSuffix[0]?.platform).toBe("win32");
  });
});
