import { defineConfig } from "vitest/config";

// Server logic runs under Node; client component tests opt into jsdom with a
// `// @vitest-environment jsdom` docblock. `esbuild.jsx: automatic` transforms
// the React TSX (the app uses the automatic runtime, no `React` import).
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // vite 5's built-in-module list predates `node:sqlite` (the engine's store), so it tries
  // to bundle it as a file. Route the import through a shim that pulls the real builtin at
  // runtime (test-only; the app itself runs uninstrumented under plain Node).
  resolve: { alias: { "node:sqlite": new URL("./test/shims/node-sqlite.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
