import { readPsd } from "ag-psd";
import { NodeJson } from "../api";
import { DecodedImageView, canvasToPng } from "./decoded";

/**
 * Renders an Adobe Photoshop document (`image/vnd.adobe.photoshop`, `.psd`/`.psb`).
 * The browser has no native PSD support, so we decode it with `ag-psd`: read the
 * file's *flattened composite* — the merged RGB preview Photoshop embeds on save —
 * which `ag-psd` paints onto a `<canvas>` for us, and export that as a PNG. We skip
 * the per-layer/thumbnail image data: we only show the one composite, and decoding
 * every layer of a big PSD would allocate far more than we display.
 */
export function PsdView({ node }: { node: NodeJson }) {
  return (
    <DecodedImageView
      node={node}
      label="psd"
      decode={async (buf) => {
        const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true });
        if (!psd.canvas) throw new Error("no composite image in this PSD");
        return [await canvasToPng(psd.canvas)];
      }}
    />
  );
}
