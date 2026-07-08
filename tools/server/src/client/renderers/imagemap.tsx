import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";
import { Annotation } from "../api";
import { fragmentAnchorId } from "../paths";
import { DEFAULT_COLOR, colorOf, editable, useAnnotationMenu, useMaterialAnnotations } from "./annotate";
import { TagLink, resolveTagColor, isColorTagPath } from "./tag";
import { wireGestures } from "./panzoom";
import { OpenChunk } from "./openable";

/** A rectangular annotation region in the image's own pixel space (origin top-left). `ann` is the
 *  source annotation when it is a real saved one (→ clickable to edit); absent for the live preview.
 *  `id` is the fragment's `#`-anchor (set for a saved fragment) — the key a hash reveal pans to.
 *  `tags` are the frame's applied tags, drawn as badges below it (all tags of a grouped region). */
export interface ImageRegion { x: number; y: number; w: number; h: number; title?: string; color?: string; ann?: Annotation; id?: string; tags?: TagLink[] }

const num = (v: unknown): number => Number(v) || 0;

const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The tag-badge markup drawn below a frame — mirrors {@link TagBadges}: a pure color tag is a
 *  circular swatch, a named tag a colored `.tagtag` badge (reusing their global styles). Built as an
 *  HTML string because it lives inside a Leaflet `divIcon`, not the React tree. Display-only. */
function tagBadgesHtml(tags: TagLink[]): string {
  return tags
    .map((t) => {
      const color = resolveTagColor({ name: t.label, color: t.color });
      if (isColorTagPath(t.path)) {
        return `<span class="tagswatch" style="background:${color}" title="${escHtml(t.label)}"></span>`;
      }
      return `<span class="tagtag" style="background:${color}">${escHtml(t.label)}</span>`;
    })
    .join("");
}

/** A PNG data-URL crop of the natural-pixel region (x,y,w,h) of `img`, for an image-like
 *  fragment's embedded preview; undefined if the region is empty or the canvas reads back tainted
 *  (cross-origin — image blobs are same-origin, so this is just a guard). */
function cropPng(img: HTMLImageElement | null, x: number, y: number, w: number, h: number): string | undefined {
  if (!img || w <= 0 || h <= 0) return undefined;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  try { return cv.toDataURL("image/png"); } catch { return undefined; }
}

/** The `rect`-type annotations, as pixel regions to overlay on the image. `materialPath` lets a
 *  saved fragment carry its `#/yamlover-fragments/<slug>` anchor id so a hash reveal can pan to it.
 *  Annotations are GROUPED by selector (a region's tag applications share one selector — the same
 *  join key as `sameSelector`/`annKey` in annotate.tsx): each frame becomes ONE region carrying all
 *  its tags, so multi-tag frames draw a single rectangle instead of N overlapping ones. */
function imageRegions(anns: Annotation[], materialPath: string): ImageRegion[] {
  const byRegion = new Map<string, ImageRegion>();
  for (const a of anns) {
    if (a.selector?.type !== "rect") continue;
    const key = JSON.stringify(a.selector);
    let r = byRegion.get(key);
    if (!r) {
      r = { x: num(a.selector.x), y: num(a.selector.y), w: num(a.selector.w), h: num(a.selector.h), title: a.description, color: colorOf(a), ann: editable(a) ? a : undefined, id: a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : undefined, tags: [] };
      byRegion.set(key, r);
    }
    if (a.tag) r.tags!.push({ path: a.tag.path, label: a.tag.name, color: a.tag.color });
  }
  return [...byRegion.values()];
}

/**
 * Pan/zoom image viewer — the same widget the KML map uses, over a flat picture. The image is an
 * `imageOverlay` on a `CRS.Simple` map sized to its natural pixels; the view fits it initially.
 * Gestures follow the unified model (see {@link wireGestures} / the UI guide): plain drag selects a
 * region (when `onSelectRegion` is set), ctrl/alt-drag pans, plain wheel pans vertically, ctrl/alt-
 * wheel zooms. The map is built once (per `src`); regions redraw in place without resetting the view.
 */
export function PanZoomImage({
  src, className, regions, onSelectRegion, onRegionClick, selectColor,
}: {
  src: string;
  className: string;
  regions?: ImageRegion[];
  onSelectRegion?: (selector: Record<string, unknown>, screen: { x: number; y: number }, imageBase64?: string) => void;
  onRegionClick?: (ann: Annotation, screen: { x: number; y: number }) => void;
  selectColor?: () => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const sizeRef = useRef({ w: 1, h: 1 });
  const onSelectRef = useRef(onSelectRegion);
  const onRegionClickRef = useRef(onRegionClick);
  const colorRef = useRef(selectColor);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(0); // bumps once the map (and its overlay layer) exist
  const regionsKey = JSON.stringify(regions ?? []);
  const selectable = !!onSelectRegion; // fixed per instance: full view annotates, chunk doesn't

  useEffect(() => { onSelectRef.current = onSelectRegion; onRegionClickRef.current = onRegionClick; colorRef.current = selectColor; });

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
      imgElRef.current = img; // kept for cropping a selected region (same-origin → un-tainted canvas)
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
              const x = Math.round(west), y = Math.round(ih - north), w = Math.round(east - west), hh = Math.round(north - south);
              onSelectRef.current?.({ type: "rect", x, y, w, h: hh }, screen, cropPng(imgElRef.current, x, y, w, hh));
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

  // Each saved fragment's rectangle keyed by its `#`-anchor id, so a hash reveal can pan to + flash
  // it (a Leaflet rect is SVG outside the page scroll flow — scrollIntoView can't reach it).
  const shapesRef = useRef(new Map<string, { rect: L.Rectangle; bounds: L.LatLngBoundsExpression }>());

  // Draw the region rectangles into the overlay layer — in place, so creating one keeps the view.
  useEffect(() => {
    const lg = layerRef.current;
    if (!lg) return;
    lg.clearLayers();
    shapesRef.current.clear();
    const { h } = sizeRef.current;
    for (const r of regions ?? []) {
      const c = r.color || DEFAULT_COLOR;
      // image y is from the top; CRS.Simple lat from the bottom, so flip y
      const bounds: L.LatLngBoundsExpression = [[h - r.y, r.x], [h - (r.y + r.h), r.x + r.w]];
      const rect = L.rectangle(bounds, {
        className: "yo-region", color: c, weight: 3, fillColor: c, fillOpacity: 0.25,
      });
      if (r.title) rect.bindTooltip(r.title);
      if (r.ann) {
        const ann = r.ann;
        // Left-click OR right-click a saved region opens its tag/context window (right-click also
        // suppresses the browser's native menu via DomEvent.stop).
        const open = (ev: L.LeafletMouseEvent) => { L.DomEvent.stop(ev); onRegionClickRef.current?.(ann, { x: ev.originalEvent.clientX, y: ev.originalEvent.clientY }); };
        rect.on("click", open);
        rect.on("contextmenu", open);
      }
      rect.addTo(lg);
      // Draw the frame's tags as badges just below its bottom-left corner (image y is from the top,
      // CRS.Simple lat from the bottom → flip). A content-sized divIcon anchored at its top-left
      // (no iconSize) sits directly under the frame, left edge aligned; non-interactive so clicks
      // fall through to the rect. Added to the same layer group → cleared/redrawn with the rects.
      if (r.tags && r.tags.length) {
        const corner = L.latLng(h - (r.y + r.h), r.x);
        const icon = L.divIcon({ className: "yo-region-tags", html: tagBadgesHtml(r.tags), iconAnchor: [0, 0] });
        L.marker(corner, { icon, interactive: false, keyboard: false }).addTo(lg);
      }
      if (r.id) shapesRef.current.set(r.id, { rect, bounds });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsKey, ready]);

  // Reveal a fragment named by the URL hash: pan/zoom to its rectangle and pulse it. Runs once the
  // overlay is drawn and on every later `hashchange` (an RHS-panel click just sets the hash).
  useEffect(() => {
    const reveal = () => {
      const map = mapRef.current;
      const id = decodeURIComponent(window.location.hash.slice(1));
      const shape = id ? shapesRef.current.get(id) : undefined;
      if (!map || !shape) return;
      map.fitBounds(shape.bounds, { maxZoom: map.getZoom(), padding: [40, 40] });
      shape.rect.setStyle({ weight: 6, fillOpacity: 0.45 });
      window.setTimeout(() => shape.rect.setStyle({ weight: 3, fillOpacity: 0.25 }), 1000);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [regionsKey, ready]);

  return (
    <>
      {error && <div className="error">image: {error}</div>}
      <div ref={ref} className={className + (selectable ? " yo-selectable" : "")} />
    </>
  );
}

export function ImageView({ node }: { node: NodeJson }) {
  const material = useMaterialAnnotations(node.path);
  const { openCreate, openEdit, palette, preview, color } = useAnnotationMenu(material, node.path);
  // include the live PREVIEW selector so the rectangle stays drawn while the menu is open
  const shown = preview
    ? [...material.annotations, { path: "(preview)", selector: preview.selector, tag: preview.tag } as Annotation]
    : material.annotations;
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <PanZoomImage
        src={blobUrl(node.path)}
        regions={imageRegions(shown, node.path)}
        onSelectRegion={(sel, screen, crop) => openCreate(sel, screen, undefined, crop)}
        onRegionClick={openEdit}
        selectColor={() => color}
        className="filemap fileimagemap"
      />
      {palette}
    </div>
  );
}

/** A plain, left-aligned STATIC image for a chapter's flow — the ONE inline form every image
 *  renderer shares, native (`ImageChunk`, `src` = the blob endpoint) or decoded (PSD/TIFF/HEIC,
 *  `src` = a decoded-page object-URL; see decoded.tsx). No pan/zoom controls — those live in the
 *  standalone viewer. Clicking opens `path` (the resource's own node) where that viewer is. */
export function StaticImageChunk({ src, path, onNavigate }: { src: string; path: string; onNavigate?: (path: string) => void }) {
  return (
    <OpenChunk path={path} onNavigate={onNavigate} title="Open image on its own page">
      <img className="chunk-image" src={src} alt="" loading="lazy" />
    </OpenChunk>
  );
}

/** A native image embedded inline in a chapter — its bytes straight from the blob endpoint. */
export function ImageChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate?: (path: string) => void }) {
  return <StaticImageChunk src={blobUrl(chunk.path)} path={chunk.path} onNavigate={onNavigate} />;
}
