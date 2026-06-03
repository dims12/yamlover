import heic2any from "heic2any";
import { NodeJson } from "../api";
import { DecodedImageView } from "./decoded";

/**
 * Renders an HEIC/HEIF image (`image/heic`, `.heic`/`.heif`) — the format iPhones
 * shoot. It's HEVC-encoded and patent-encumbered, with no browser support, so we
 * decode it with `heic2any` (libheif compiled to wasm), which converts the bytes
 * to a PNG blob. An HEIC may hold an image *sequence* (burst/Live Photo); when it
 * does, `heic2any` returns several blobs and we show each.
 */
export function HeicView({ node }: { node: NodeJson }) {
  return (
    <DecodedImageView
      node={node}
      label="heic"
      decode={async (buf) => {
        const out = await heic2any({ blob: new Blob([buf]), toType: "image/png" });
        return Array.isArray(out) ? out : [out];
      }}
    />
  );
}
