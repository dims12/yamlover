/**
 * decoders/psd.ts — Photoshop (PSD/PSB) via ag-psd in `useImageData` mode, so the composite is
 * read as raw RGBA pixels WITHOUT a native `<canvas>` (ag-psd otherwise wants one). Pure-JS, lazy.
 * Reuses the ag-psd dependency the client renderer already relies on.
 */

import type { Extractor } from "../types.js";
import { byFormat } from "../types.js";

export const psdExtractor: Extractor = {
  name: "ag-psd",
  accepts: byFormat("image/vnd.adobe.photoshop"),
  async decode({ bytes }) {
    const { readPsd } = await import("ag-psd");
    // Read only the flattened composite as ImageData; skip per-layer pixels and the embedded
    // thumbnail — we just need the full-resolution RGBA to downscale.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const psd = readPsd(ab, {
      useImageData: true,
      skipLayerImageData: true,
      skipThumbnail: true,
    });
    const img = psd.imageData;
    if (!img) throw new Error("PSD has no composite image data");
    return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
  },
};
