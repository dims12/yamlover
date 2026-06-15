/**
 * decoders/webp.ts — WebP via @jsquash/webp (libwebp compiled to wasm), decoded headless: we
 * compile the wasm ourselves (./wasm.ts) and hand it to the codec's `init()` so it never tries to
 * `fetch()` the binary. Lazy: the codec + wasm load only on the first WebP thumbnail.
 */

import type { Extractor } from "../types.js";
import { byFormat } from "../types.js";
import { loadWasm } from "../wasm.js";

let inited: Promise<void> | undefined;
async function ensureInit(): Promise<void> {
  inited ??= (async () => {
    const dec = await import("@jsquash/webp/decode");
    await dec.init(await loadWasm("@jsquash/webp/codec/dec/webp_dec.wasm", "webp_dec.wasm"));
  })();
  return inited;
}

export const webpExtractor: Extractor = {
  name: "jsquash-webp",
  accepts: byFormat("image/webp"),
  async decode({ bytes }) {
    await ensureInit();
    const { default: decode } = await import("@jsquash/webp/decode");
    const img = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
  },
};
