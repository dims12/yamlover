#!/usr/bin/env node
/**
 * build.mjs — produce the self-contained PRODUCTION artifacts for publishing.
 *
 * The published package (and the `--prod` launcher path) ships nothing from
 * `src/`: the client is a prebuilt static SPA and the server handler is a single
 * bundled file. This script produces both, into `dist/`:
 *
 *   1. dist/client/  — `vite build` of the React SPA (index.html → src/client),
 *      including the pdf.js worker and the vendored DjVu bundle as hashed assets.
 *      bin/yamlover.js serves this as plain static files in production mode (no
 *      Vite at runtime). See vite.config.mjs.
 *
 *   2. dist/server.js — the server-side handler bundled with esbuild. The dev
 *      server (bin/yamlover.js, live mode) normally loads `src/server/engine-api.ts`
 *      through Vite's `ssrLoadModule`, transpiling TS on the fly — but that path
 *      reaches OUTSIDE this package (`../../../engine/ts/src`, `../../../parser/ts/src`),
 *      which cannot be packed into the npm tarball. So we bundle that import graph
 *      (engine-api → engine → parser, plus `ignore` / `js-yaml` / `xxhash-wasm`,
 *      whose wasm is inlined) into one self-contained file. node:sqlite and other
 *      node builtins stay external (platform: 'node').
 *
 * bin/yamlover.js uses these in production mode (the published package, or `--prod`)
 * and falls back to live Vite + `ssrLoadModule` only in the repo checkout.
 */
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Client SPA → dist/client (static assets, no Vite at runtime).
await viteBuild({ configFile: join(pkgRoot, "vite.config.mjs") });
console.log("yamlover  built client SPA → dist/client");

// 2. Server handler → dist/server.js.
await esbuild({
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
