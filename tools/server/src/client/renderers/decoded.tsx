import { useEffect, useState } from "react";
import { NodeJson, blobUrl } from "../api";
import { PanZoomImage, StaticImageChunk } from "./imagemap";

/** Inline-chunk mode for a decoded image: render its pages STATIC (no pan/zoom) with a click that
 *  opens the resource on its own page — the same treatment a native image chunk gets. Absent → the
 *  standalone page, where each page is a pan/zoom viewer. */
export interface ChunkMode {
  onNavigate?: (path: string) => void;
}

/**
 * Shared scaffold for the file formats the browser cannot display natively but
 * that we can decode client-side to ordinary raster images (PSD, TIFF, HEIC).
 * It fetches the node's bytes from `/api/blob`, hands them to a format-specific
 * `decode` that returns one PNG `Blob` per page, and shows each — as a pan/zoom
 * viewer on the standalone page, or (when `chunk` is set) as a plain static image
 * in a chapter's flow, the SAME interactive-vs-static split native images use
 * (imagemap.tsx). Each decoded page is its own object-URL, revoked on unmount /
 * path change so decoded pages don't leak.
 */
export function DecodedImageView({
  node,
  label,
  decode,
  chunk,
}: {
  node: NodeJson;
  label: string;
  decode: (buf: ArrayBuffer) => Promise<Blob[]>;
  chunk?: ChunkMode;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setUrls([]);
    setError(null);
    (async () => {
      const buf = await fetch(blobUrl(node.path)).then((r) => r.arrayBuffer());
      const blobs = await decode(buf);
      if (cancelled) return;
      for (const b of blobs) created.push(URL.createObjectURL(b));
      if (!cancelled) setUrls(created);
    })().catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
      created.forEach(URL.revokeObjectURL);
    };
  }, [node.path]);

  if (error) return <div className="error">{label}: {error}</div>;
  if (!urls.length) return <div className="loading">decoding {label}…</div>;
  return (
    <>
      {urls.map((url, i) =>
        chunk ? (
          <StaticImageChunk key={i} src={url} path={node.path} onNavigate={chunk.onNavigate} />
        ) : (
          <PanZoomImage key={i} src={url} className="filemap fileimagemap" />
        ),
      )}
    </>
  );
}

/** Paint RGBA pixels onto a canvas and export it as a PNG blob. */
export async function rgbaToPng(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvasToPng(canvas);
}

/** Export a canvas as a PNG blob (Promise wrapper over the callback API). */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas export failed"))), "image/png"),
  );
}
