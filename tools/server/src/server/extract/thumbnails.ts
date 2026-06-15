/**
 * extract/thumbnails.ts — the thumbnail capability built on the extractor registry: decode any
 * supported source to RGBA (./registry.ts), fit it within a [w, h] box, and encode a small JPEG.
 *
 * Pure bytes→bytes (no fs / Store) so it unit-tests in isolation; the server (engine-api.ts) owns
 * the sidecar file + the `yamlover-thumbnails` overlay. jimp is the resize/encode core and loads
 * lazily, like the decoders.
 */

import { extractorFor } from "./registry.js";

export interface Thumbnail {
  buf: Buffer;
  format: string; // the thumbnail's own media type
  ext: string; // file extension (no dot) for the sidecar name
}

/** Render a thumbnail of `bytes` (a `format` image) fitted within `w`×`h`, or null when no
 *  extractor can decode that format (the caller falls back to the type glyph). Aspect ratio is
 *  preserved (the longest side meets the box); the result is flattened onto white and JPEG-encoded
 *  so photos stay small and transparent PNGs don't go black. */
export async function renderThumbnail(bytes: Buffer, format: string | null, w: number, h: number): Promise<Thumbnail | null> {
  const ex = extractorFor(format);
  if (!ex) return null;
  const px = await ex.decode({ bytes, format });
  const { Jimp } = await import("jimp");
  const img = Jimp.fromBitmap({ data: Buffer.from(px.data), width: px.width, height: px.height });
  img.scaleToFit({ w, h });
  // Flatten onto an opaque white canvas — JPEG has no alpha, and an unflattened transparent
  // region would encode as black.
  const flat = Jimp.fromBitmap({ data: Buffer.alloc(img.bitmap.width * img.bitmap.height * 4, 0xff), width: img.bitmap.width, height: img.bitmap.height });
  flat.composite(img, 0, 0);
  const buf = await flat.getBuffer("image/jpeg", { quality: 78 });
  return { buf: Buffer.from(buf), format: "image/jpeg", ext: "jpg" };
}
