/**
 * extract/registry.ts — the server-side per-type EXTRACTOR registry.
 *
 * The mirror of the client renderer registry (src/client/renderers/registry.tsx): a small set of
 * hand-coded `accepts(format)` predicates pick the decoder for a file's media type. An extractor's
 * one job is to DECODE source bytes into normalized RGBA pixels; the thumbnail core
 * (./thumbnails.ts) then resizes + encodes. Heavier work (EXIF, OCR, PDF TOC) can grow as more
 * capabilities on the same registry later.
 *
 * The contract + `byFormat` live in ./types.ts (a dependency-free base) so the per-format decoder
 * modules import from there, not from here — otherwise the decoders this module pulls in would
 * reference `byFormat` before it initialized (a circular-import TDZ). Each decoder dynamically
 * imports its codec, so a cold server (and any non-thumbnail request) never pays for jimp/ag-psd.
 */

import type { Extractor } from "./types.js";
import { rasterExtractor } from "./decoders/jimp-raster.js";
import { psdExtractor } from "./decoders/psd.js";

export type { Pixels, DecodeInput, Extractor } from "./types.js";
export { byFormat } from "./types.js";

/** Registration order is precedence order: the first extractor that accepts the format wins. */
const REGISTRY: Extractor[] = [rasterExtractor, psdExtractor];

/** The extractor that claims `format`, or null when none does (the caller then has no thumbnail —
 *  e.g. a format with no headless decoder yet, like application/pdf). */
export function extractorFor(format: string | null): Extractor | null {
  return REGISTRY.find((e) => e.accepts(format)) ?? null;
}

/** Whether any extractor can produce pixels for `format` — the cheap pre-check the HTTP layer uses
 *  to decide between generating a thumbnail and falling back to the type glyph. */
export function isThumbnailable(format: string | null): boolean {
  return extractorFor(format) !== null;
}
