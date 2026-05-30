import { defineConfig } from "vitest/config";

// Server logic runs under Node; client component tests opt into jsdom with a
// `// @vitest-environment jsdom` docblock. `esbuild.jsx: automatic` transforms
// the React TSX (the app uses the automatic runtime, no `React` import).
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
