import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Pan/zoom image viewer — the same widget the KML map uses, over a flat picture. The image is an
 * `imageOverlay` on a `CRS.Simple` map sized to its natural pixels; the view fits it initially,
 * then panning (anywhere, including off-page — no pan bounds) and scroll-zoom are free. Leaflet is
 * heavy + browser-only, so callers load this lazily. `src` is any image URL — a `/api/blob` URL for
 * a native image, or a decoded object-URL for HEIC/TIFF/PSD (see decoded.tsx).
 */
export function PanZoomImage({ src, className }: { src: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;
    setError(null);
    const img = new Image();
    img.onload = () => {
      if (cancelled || !ref.current) return;
      const w = img.naturalWidth || 1;
      const h = img.naturalHeight || 1;
      // CRS.Simple: coordinates are raw pixels (y, x); negative minZoom allows zooming far out.
      map = L.map(ref.current, { crs: L.CRS.Simple, minZoom: -8, attributionControl: false, zoomSnap: 0 });
      const bounds: L.LatLngBoundsExpression = [[0, 0], [h, w]];
      L.imageOverlay(src, bounds).addTo(map);
      map.fitBounds(bounds); // initial view frames the whole image; pan/zoom is then free
    };
    img.onerror = () => { if (!cancelled) setError("could not load image"); };
    img.src = src;
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [src]);

  return (
    <>
      {error && <div className="error">image: {error}</div>}
      <div ref={ref} className={className} />
    </>
  );
}

export function ImageView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <PanZoomImage src={blobUrl(node.path)} className="filemap fileimagemap" />
    </div>
  );
}

/** An image embedded inline in a chapter — the same pan/zoom widget at chunk height. */
export function ImageChunk({ chunk }: { chunk: Chunk }) {
  return <PanZoomImage src={blobUrl(chunk.path)} className="filemap chunk-map fileimagemap" />;
}
