// Per-format extractor decoders: each turns its source bytes into RGBA pixels that the thumbnail
// core (renderThumbnail) resizes + JPEG-encodes. jimp-raster + psd are covered implicitly by
// thumbnails.test.ts; here we cover the wasm codecs (webp, avif) end-to-end through renderThumbnail
// by encoding a fixture with the same codec (headless, manual wasm init) and decoding it back.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import { renderThumbnail } from "../src/server/extract/thumbnails.ts";

const require = createRequire(import.meta.url);

/** A w×h solid-color RGBA buffer. */
function rgba(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 170;
    data[i + 1] = 90;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  return data;
}

/** Encode a fixture with a @jsquash codec, initializing its encoder from the local wasm (the
 *  codecs `fetch()` their wasm by default, which fails headless). */
async function jsquashEncode(pkg: "webp" | "avif", w: number, h: number): Promise<Buffer> {
  const enc = await import(`@jsquash/${pkg}/encode`);
  const wasm = require.resolve(`@jsquash/${pkg}/codec/enc/${pkg}_enc.wasm`);
  await enc.init(await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasm))));
  return Buffer.from(await enc.default({ data: rgba(w, h), width: w, height: h }));
}

describe("wasm image decoders → renderThumbnail", () => {
  it("decodes WebP and produces a fitted JPEG thumbnail", async () => {
    const src = await jsquashEncode("webp", 64, 48);
    const t = await renderThumbnail(src, "image/webp", 32, 32);
    expect(t?.format).toBe("image/jpeg");
    const { Jimp } = await import("jimp");
    const out = await Jimp.read(t!.buf);
    expect(out.bitmap.width).toBe(32);
    expect(out.bitmap.height).toBe(24); // 4:3 fitted within the 32 box
  });

  it("decodes AVIF and produces a fitted JPEG thumbnail", async () => {
    const src = await jsquashEncode("avif", 64, 48);
    const t = await renderThumbnail(src, "image/avif", 32, 32);
    expect(t?.format).toBe("image/jpeg");
    const { Jimp } = await import("jimp");
    const out = await Jimp.read(t!.buf);
    expect(out.bitmap.width).toBe(32);
    expect(out.bitmap.height).toBe(24);
  }, 20000); // avif encode/decode is wasm-heavy
});
