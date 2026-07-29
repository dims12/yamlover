// the CHAPTER debug page — `npm run debug-chapter`: a standalone Vite root, no backend. The
// fixture globs and the server-client component imports reach the repository root.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // tools/yed/debug-chapter

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { fs: { allow: [resolve(here, "../../..")] }, port: 5198 },
});
