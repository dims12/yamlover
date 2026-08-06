import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // tools/dagflow

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: 5200 },
});
