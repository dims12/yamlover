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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

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
  // Some bundled CJS deps (jimp's image codecs) call `require("fs")` at runtime. In an ESM
  // bundle `require` is undefined, so esbuild's `__require` shim throws ("Dynamic require of
  // \"fs\" is not supported") — which broke jimp's init. Inject a real `require` (createRequire);
  // esbuild's shim delegates to it, so those builtin requires resolve.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
  // The handler is loaded via dynamic import by bin/yamlover.js, so a named export
  // is all we need — esbuild preserves `export { createHandlers }`.
});

console.log("yamlover  bundled src/server/engine-api.ts → dist/server.js");

// 3. Codec wasm → dist/wasm/. esbuild bundles each decoder's JS glue but not its `.wasm`; the
// extractors hand the glue a pre-compiled module (src/server/extract/wasm.ts), resolving the
// binary from node_modules in dev and from here in the bundle. Keep this list in sync with the
// lazily-imported decoders under src/server/extract/decoders/.
const WASM = [
  "@jsquash/webp/codec/dec/webp_dec.wasm",
  "@jsquash/avif/codec/dec/avif_dec.wasm",
];
const wasmDir = join(pkgRoot, "dist/wasm");
mkdirSync(wasmDir, { recursive: true });
for (const spec of WASM) copyFileSync(require.resolve(spec), join(wasmDir, basename(spec)));
console.log(`yamlover  copied ${WASM.length} codec wasm → dist/wasm`);
