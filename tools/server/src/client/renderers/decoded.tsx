import { useEffect, useState } from "react";
import { NodeJson, blobUrl } from "../api";

/**
 * Shared scaffold for the file formats the browser cannot display natively but
 * that we can decode client-side to ordinary raster images (PSD, TIFF, HEIC).
 * It fetches the node's bytes from `/api/blob`, hands them to a format-specific
 * `decode` that returns one PNG `Blob` per page, and shows each as an `<img>` —
 * reusing the same `.filemedia`/`.fileimage` styling as the native image view.
 * Object-URLs are revoked on unmount / path change so decoded pages don't leak.
 */
export function DecodedImageView({
  node,
  label,
  decode,
}: {
  node: NodeJson;
  label: string;
  decode: (buf: ArrayBuffer) => Promise<Blob[]>;
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
    <div className="filemedia">
      {urls.map((url, i) => (
        <img key={i} className="fileimage" src={url} alt={node.title ?? node.path} />
      ))}
    </div>
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
