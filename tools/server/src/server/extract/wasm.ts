/**
 * extract/wasm.ts — load a codec's `.wasm` so it works in BOTH server paths: the dev server
 * (vite ssrLoadModule of this source, with node_modules present) and the bundled prod server
 * (dist/server.js, no node_modules — the build copies the needed wasm into dist/wasm/). esbuild
 * bundles the codec's JS glue but not its `.wasm`, so we hand the glue a pre-compiled module via
 * its `init()` and never let it `fetch()` (which fails headless).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Compile a codec's wasm: resolved from node_modules when running from source, else from the
 *  build-copied `dist/wasm/<prodFile>` beside the bundle. */
export async function loadWasm(npmSpecifier: string, prodFile: string): Promise<WebAssembly.Module> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(require.resolve(npmSpecifier)); // dev / source: node_modules
  } catch {
    bytes = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "wasm", prodFile)); // prod bundle
  }
  return WebAssembly.compile(new Uint8Array(bytes));
}
