import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Vite config for the Tauri webview SPA (M11). The webview is a STATIC bundle Tauri
 * serves from `dist/` (decision: Vite + React, not Next — the webview is not server-
 * oriented). Port 1420 / strictPort matches `tauri.conf.json` `build.devUrl`; Tauri's
 * `beforeDevCommand` starts this server and points the native window at it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri controls the window/console; don't let Vite wipe the terminal.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
