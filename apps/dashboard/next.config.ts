import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // npm workspaces hoist node_modules to the repo root, so Turbopack's root must sit
  // at/above it or Next can't resolve `next` from app subdirs. Also silences the
  // "inferred workspace root / multiple lockfiles" warning.
  turbopack: {
    root: path.join(import.meta.dirname, "..", ".."),
  },
  // Compile @420ai/shared from the workspace source directly so the dashboard build
  // never depends on `tsc -b` having produced packages/shared/dist first.
  transpilePackages: ["@420ai/shared"],
  reactStrictMode: true,
};

export default nextConfig;
