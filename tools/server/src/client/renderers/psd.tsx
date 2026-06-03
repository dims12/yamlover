import { useEffect, useState } from "react";
import { readPsd } from "ag-psd";
import { NodeJson, blobUrl } from "../api";

/**
 * Renders an Adobe Photoshop document (`image/vnd.adobe.photoshop`, `.psd`/`.psb`).
 * The browser has no native PSD support, so we decode it client-side with `ag-psd`:
 * fetch the bytes from `/api/blob` and read the file's *flattened composite* — the
 * merged RGB preview Photoshop embeds on save — which `ag-psd` paints onto a
 * `<canvas>` for us. We skip the per-layer image data (we only show the composite),
 * then hand the canvas off as a PNG object-URL shown as an `<img>`, matching the
 * other image renderers' styling.
 */
export function PsdView({ node }: { node: NodeJson }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setUrl(null);
    setError(null);
    (async () => {
      const buf = await fetch(blobUrl(node.path)).then((r) => r.arrayBuffer());
      // Only the composite is needed for viewing — skipping layer/thumbnail image
      // data keeps a big layered PSD from decoding (and allocating) far more than
      // the one flattened picture we show.
      const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true });
      if (!psd.canvas) throw new Error("no composite image in this PSD");
      const blob: Blob = await new Promise((resolve, reject) =>
        psd.canvas!.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas export failed"))), "image/png"),
      );
      if (cancelled) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    })().catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [node.path]);

  if (error) return <div className="error">psd: {error}</div>;
  if (!url) return <div className="loading">decoding psd…</div>;
  return (
    <div className="filemedia">
      <img className="fileimage" src={url} alt={node.title ?? node.path} />
    </div>
  );
}
