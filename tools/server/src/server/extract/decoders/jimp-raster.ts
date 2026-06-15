/**
 * decoders/jimp-raster.ts — the core raster decoder: PNG / JPEG / GIF / BMP / TIFF via jimp
 * (pure-JS, no native binaries — preserves the lean npx + 3-OS Electron build). jimp is imported
 * dynamically so the codec only loads when a thumbnail of one of these types is first requested.
 */

import type { Extractor } from "../types.js";
import { byFormat } from "../types.js";

export const rasterExtractor: Extractor = {
  name: "jimp-raster",
  accepts: byFormat("image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff"),
  async decode({ bytes }) {
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(bytes);
    return { data: Buffer.from(img.bitmap.data), width: img.bitmap.width, height: img.bitmap.height };
  },
};
