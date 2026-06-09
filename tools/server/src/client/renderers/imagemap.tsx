import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";
import { DEFAULT_COLOR, useAnnotations, useRegionAnnotator } from "./annotate";
import { wireGestures } from "./panzoom";

/** A rectangular annotation region in the image's own pixel space (origin top-left). */
export interface ImageRegion { x: number; y: number; w: number; h: number; title?: string; color?: string }

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The `rect`-type annotations of `path`, as pixel regions to overlay on the image. */
function useImageRegions(path: string, bump: number): ImageRegion[] {
  return useAnnotations(path, bump)
    .filter((a) => a.selector?.type === "rect")
    .map((a) => ({ x: num(a.selector!.x), y: num(a.selector!.y), w: num(a.selector!.w), h: num(a.selector!.h), title: a.body, color: str(a.selector!.color) }));
}

/**
 * Pan/zoom image viewer — the same widget the KML map uses, over a flat picture. The image is an
 * `imageOverlay` on a `CRS.Simple` map sized to its natural pixels; the view fits it initially.
 * Gestures follow the unified model (see {@link wireGestures} / the UI guide): plain drag selects a
 * region (when `onSelectRegion` is set), ctrl/alt-drag pans, plain wheel pans vertically, ctrl/alt-
 * wheel zooms. The map is built once (per `src`); regions redraw in place without resetting the view.
 */
export function PanZoomImage({
  src, className, regions, onSelectRegion, selectColor,
}: {
  src: string;
  className: string;
  regions?: ImageRegion[];
  onSelectRegion?: (selector: Record<string, unknown>, screen: { x: number; y: number }) => void;
  selectColor?: () => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const sizeRef = useRef({ w: 1, h: 1 });
  const onSelectRef = useRef(onSelectRegion);
  const colorRef = useRef(selectColor);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(0); // bumps once the map (and its overlay layer) exist
  const regionsKey = JSON.stringify(regions ?? []);
  const selectable = !!onSelectRegion; // fixed per instance: full view annotates, chunk doesn't

  useEffect(() => { onSelectRef.current = onSelectRegion; colorRef.current = selectColor; });

  // Build the map once per src; gestures + the overlay layer live with it.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setError(null);
    const img = new Image();
    img.onload = () => {
      if (cancelled || !ref.current) return;
      const w = img.naturalWidth || 1;
      const h = img.naturalHeight || 1;
      sizeRef.current = { w, h };
      // CRS.Simple: coordinates are raw pixels (y, x); negative minZoom allows zooming far out.
      const map = L.map(ref.current, { crs: L.CRS.Simple, minZoom: -8, attributionControl: false, zoomSnap: 0 });
      const bounds: L.LatLngBoundsExpression = [[0, 0], [h, w]];
      L.imageOverlay(src, bounds).addTo(map);
      map.fitBounds(bounds); // initial view frames the whole image
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      dispose = wireGestures(map, {
        color: () => colorRef.current?.() ?? DEFAULT_COLOR,
        onSelect: selectable
          ? (b, screen) => {
              // image pixels have y from the top; CRS.Simple lat is from the bottom → flip.
              const { h: ih } = sizeRef.current;
              const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
              onSelectRef.current?.(
                { type: "rect", x: Math.round(west), y: Math.round(ih - north), w: Math.round(east - west), h: Math.round(north - south) },
                screen,
              );
            }
          : undefined,
      });
      setReady((r) => r + 1);
    };
    img.onerror = () => { if (!cancelled) setError("could not load image"); };
    img.src = src;
    return () => {
      cancelled = true;
      dispose?.();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Draw the region rectangles into the overlay layer — in place, so creating one keeps the view.
  useEffect(() => {
    const lg = layerRef.current;
    if (!lg) return;
    lg.clearLayers();
    const { h } = sizeRef.current;
    for (const r of regions ?? []) {
      const c = r.color || DEFAULT_COLOR;
      // image y is from the top; CRS.Simple lat from the bottom, so flip y
      const rect = L.rectangle([[h - r.y, r.x], [h - (r.y + r.h), r.x + r.w]], {
        className: "yo-region", color: c, weight: 2, fillColor: c, fillOpacity: 0.15,
      });
      if (r.title) rect.bindTooltip(r.title);
      rect.addTo(lg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsKey, ready]);

  return (
    <>
      {error && <div className="error">image: {error}</div>}
      <div ref={ref} className={className + (selectable ? " yo-selectable" : "")} />
    </>
  );
}

export function ImageView({ node }: { node: NodeJson }) {
  const [bump, setBump] = useState(0);
  const regions = useImageRegions(node.path, bump);
  const { open, palette, color } = useRegionAnnotator(node.path, () => setBump((b) => b + 1));
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <PanZoomImage
        src={blobUrl(node.path)}
        regions={regions}
        onSelectRegion={open}
        selectColor={() => color}
        className="filemap fileimagemap"
      />
      {palette}
    </div>
  );
}

/** An image embedded inline in a chapter — pan/zoom only (no annotation target → plain drag pans). */
export function ImageChunk({ chunk }: { chunk: Chunk }) {
  return <PanZoomImage src={blobUrl(chunk.path)} className="filemap chunk-map fileimagemap" />;
}
