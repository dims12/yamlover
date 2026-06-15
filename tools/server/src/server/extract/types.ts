/**
 * extract/types.ts — the extractor contract + the `byFormat` matcher, in a dependency-free base
 * module so decoders and the registry can both import it without a cycle.
 */

/** RGBA pixels — 4 bytes/pixel, row-major, the common currency every decoder emits. */
export interface Pixels {
  data: Buffer; // width*height*4 RGBA bytes
  width: number;
  height: number;
}

export interface DecodeInput {
  bytes: Buffer;
  format: string | null; // the node's media type (e.g. "image/png"); a decoder may key on it
}

/** A per-type decoder: claims a media type, turns its bytes into RGBA pixels. */
export interface Extractor {
  name: string;
  accepts: (format: string | null) => boolean;
  decode: (input: DecodeInput) => Promise<Pixels>;
}

/** The common matcher: claims a node whose media type is one of `fmts` (mirrors the client's
 *  `byFormat` in renderers/registry.tsx). */
export const byFormat =
  (...fmts: string[]) =>
  (format: string | null): boolean =>
    format !== null && fmts.includes(format);
