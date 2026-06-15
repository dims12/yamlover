// vite.config.mjs — PRODUCTION client build only.
//
// The dev server (bin/yamlover.js, "live" mode) configures Vite inline in
// middleware mode and never reads this file. This config is used solely by
// `vite build` (scripts/build.mjs) to compile the React SPA — index.html →
// src/client/main.tsx, including the pdf.js worker (`new URL(..., import.meta.url)`)
// and the vendored DjVu bundle (`?url`) — into a self-contained `dist/client/`.
//
// The launcher's production mode then serves that directory as plain static
// files (no Vite at runtime), while live data updates keep flowing over the
// /api/events SSE stream exactly as before.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // tools/server

export default defineConfig({
  root,
  plugins: [react()],
  // Collapse react/react-dom to this package's single copy, mirroring the dev
  // server — guards against a stale React hoisted into a parent node_modules.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "esnext", // top-level await / import.meta in the renderer deps
  },
});
