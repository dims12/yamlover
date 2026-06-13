#!/usr/bin/env node
/**
 * build.mjs — bundle the server-side handler for publishing.
 *
 * The dev server (bin/yamlover.js) normally loads `src/server/engine-api.ts`
 * through Vite's `ssrLoadModule`, transpiling TS on the fly. That path reaches
 * OUTSIDE this package — `../../../engine/ts/src`, `../../../parser/ts/src` —
 * which is fine in the monorepo but cannot be packed into the npm tarball.
 *
 * So at `prepack` we bundle that import graph (engine-api → engine → parser,
 * plus `ignore` / `js-yaml` / `xxhash-wasm`, whose wasm is inlined) into one
 * self-contained `dist/server.js`. `bin/yamlover.js` prefers that bundle when it
 * exists (the published package) and falls back to `ssrLoadModule` otherwise
 * (the repo checkout, for live editing). The client SPA is untouched — Vite
 * still serves `src/client` from source at runtime.
 *
 * node:sqlite and other node builtins stay external (platform: 'node').
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(pkgRoot, "src/server/engine-api.ts")],
  outfile: join(pkgRoot, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node:sqlite (and every other `node:`/builtin) resolves at runtime, not bundle
  // time; platform:'node' externalizes them automatically.
  logLevel: "info",
  // The handler is loaded via dynamic import by bin/yamlover.js, so a named export
  // is all we need — esbuild preserves `export { createHandlers }`.
});

console.log("yamlover  bundled src/server/engine-api.ts → dist/server.js");
