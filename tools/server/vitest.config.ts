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
    // vitest's 5s default measures WALL CLOCK, which includes every millisecond a worker sat
    // descheduled. This suite runs 104 files across N workers and several tests are CPU-bound
    // (thumbnails.test.ts encodes real images in pure JS via jimp; the /api/edit files each
    // stand up a server + SQLite store), so on a loaded runner a test that takes ~1.2s alone
    // can measure past 5s. That is what failed publish.yml's gate at 0.3.47 —
    // "generates a fitted JPEG …" timed out in CI while passing locally in 1243ms.
    // Raised suite-wide rather than pinned on the one test that lost the race first: the
    // starvation is a property of the run, not of that test. A real hang still fails, later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
