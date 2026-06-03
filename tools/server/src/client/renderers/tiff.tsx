import UTIF from "utif";
import { NodeJson } from "../api";
import { DecodedImageView, rgbaToPng } from "./decoded";

/**
 * Renders a TIFF image (`image/tiff`, `.tif`/`.tiff`). Browsers don't display
 * TIFF, so we decode it with UTIF.js: each top-level IFD is one page (multi-page
 * TIFFs — common for scans — render every page), decoded to RGBA and painted to a
 * canvas/PNG. IFDs without dimensions (e.g. stray metadata directories) are skipped.
 */
export function TiffView({ node }: { node: NodeJson }) {
  return (
    <DecodedImageView
      node={node}
      label="tiff"
      decode={async (buf) => {
        const view = new Uint8Array(buf);
        const ifds = UTIF.decode(view);
        const pages: Blob[] = [];
        for (const ifd of ifds) {
          UTIF.decodeImage(view, ifd);
          const w = ifd.width as number;
          const h = ifd.height as number;
          if (!w || !h) continue;
          const rgba = UTIF.toRGBA8(ifd);
          pages.push(await rgbaToPng(rgba, w, h));
        }
        if (!pages.length) throw new Error("no decodable image in this TIFF");
        return pages;
      }}
    />
  );
}
