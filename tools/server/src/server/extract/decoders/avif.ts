/**
 * decoders/avif.ts — AVIF via @jsquash/avif (libavif compiled to wasm), decoded headless with a
 * locally-compiled wasm module (./wasm.ts), same pattern as ./webp.ts. Lazy.
 */

import type { Extractor } from "../types.js";
import { byFormat } from "../types.js";
import { loadWasm } from "../wasm.js";

let inited: Promise<void> | undefined;
async function ensureInit(): Promise<void> {
  inited ??= (async () => {
    const dec = await import("@jsquash/avif/decode");
    await dec.init(await loadWasm("@jsquash/avif/codec/dec/avif_dec.wasm", "avif_dec.wasm"));
  })();
  return inited;
}

export const avifExtractor: Extractor = {
  name: "jsquash-avif",
  accepts: byFormat("image/avif"),
  async decode({ bytes }) {
    await ensureInit();
    const { default: decode } = await import("@jsquash/avif/decode");
    const img = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (!img) throw new Error("AVIF decode failed");
    return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
  },
};
