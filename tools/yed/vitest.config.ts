import { defineConfig } from "vitest/config";

// jsdom is opt-in per file via `// @vitest-environment jsdom` docblocks (the DOM suites).
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"] },
});
