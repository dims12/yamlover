// yed2 — `npm run debug-editor`: a standalone Vite root for the debug page. The corpus globs
// reach the repository root, hence the fs.allow.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // tools/yed/debug-editor

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { fs: { allow: [resolve(here, "../../..")] }, port: 5199 },
});
