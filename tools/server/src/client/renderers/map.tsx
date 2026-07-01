import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NodeJson, blobUrl } from "../api";
import { fragmentAnchorId } from "../paths";
import { Chunk } from "./registry";
import { bytesToGeoJSON, GeoJSON } from "./kml";
import { Annotation } from "../api";
import { DEFAULT_COLOR, colorOf, editable, useAnnotationMenu, useMaterialAnnotations } from "./annotate";
import { wireGestures } from "./panzoom";

/**
 * Renderer for geographic overlays — `.kml` and `.kmz` (zipped KML). The file is
 * served as bytes; we convert it to GeoJSON (see `kml.ts`) and draw it on a
 * Leaflet slippy map over OpenStreetMap tiles, fitting the view to the data.
 * Points become circle markers, lines/polygons keep their KML colours, and a
 * feature's name/description show in a popup.
 *
 * Gestures follow the unified model (see {@link wireGestures} / the UI guide): plain drag selects a
 * geographic region to annotate, ctrl/alt-drag pans, plain wheel pans vertically, ctrl/alt-wheel
 * zooms.
 *
 * **Network note:** the vector overlay and KML/KMZ parsing are fully local, but the
 * *map tiles* are fetched from a tile server — by default OpenStreetMap. Point
 * `VITE_MAP_TILE_URL` (and optionally `VITE_MAP_TILE_ATTRIBUTION`) at a self-hosted
 * tile server to keep map traffic off the public one. Leaflet is heavy and
 * browser-only, so the registry loads this module lazily.
 */
const TILE_URL =
  ((import.meta as any).env?.VITE_MAP_TILE_URL as string | undefined) ??
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  ((import.meta as any).env?.VITE_MAP_TILE_ATTRIBUTION as string | undefined) ??
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** A rectangular annotation region on the map, in geographic edges (degrees). `ann` is the source
 *  annotation when it is a real saved one (→ clickable to edit); absent for the live preview.
 *  `id` is the fragment's `#`-anchor (set for a saved fragment) — the key a hash reveal pans to. */
interface MapRegion { n: number; s: number; e: number; w: number; title?: string; color?: string; ann?: Annotation; id?: string }
const num = (v: unknown): number => Number(v) || 0;

/** The `map`-type annotations, as geographic rectangles to overlay. `materialPath` lets a saved
 *  fragment carry its `#/yamlover-fragments/<slug>` anchor id so a hash reveal can pan to it. */
function mapRegions(anns: Annotation[], materialPath: string): MapRegion[] {
  return anns
    .filter((a) => a.selector?.type === "map")
    .map((a) => ({ n: num(a.selector!.n), s: num(a.selector!.s), e: num(a.selector!.e), w: num(a.selector!.w), title: a.description, color: colorOf(a), ann: editable(a) ? a : undefined, id: a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : undefined }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A feature's description as popup HTML. togeojson returns a plain-text KML
 *  description as a string (escaped here) and an HTML/CDATA one as
 *  `{ "@type": "html", value }` — authored markup, kept as-is (this is a local
 *  viewer of the user's own files). */
function descriptionHtml(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return escapeHtml(description);
  if (typeof description === "object" && (description as any)["@type"] === "html") {
    return String((description as any).value ?? "");
  }
  return "";
}

/** Draw `geo` onto a fresh Leaflet map in `el`, fit to the data, and return the map
 *  (so the caller can dispose it). */
function drawMap(el: HTMLElement, geo: GeoJSON): L.Map {
  const map = L.map(el);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  const layer = L.geoJSON(geo as any, {
    // honour KML styling that togeojson surfaces as simplestyle properties
    style: (f) => {
      const p = (f?.properties ?? {}) as Record<string, unknown>;
      return {
        color: (p["stroke"] as string) || "#3388ff",
        weight: (p["stroke-width"] as number) || 2,
        opacity: (p["stroke-opacity"] as number) ?? 1,
        fillColor: (p["fill"] as string) || "#3388ff",
        fillOpacity: (p["fill-opacity"] as number) ?? 0.2,
      };
    },
    pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 5, color: "#e23", weight: 2, fillOpacity: 0.8 }),
    onEachFeature: (f, lyr) => {
      const p = (f.properties ?? {}) as { name?: string; description?: unknown };
      const name = p.name ? `<strong>${escapeHtml(p.name)}</strong>` : "";
      const body = descriptionHtml(p.description);
      const desc = body ? `<div class="map-popup-desc">${body}</div>` : "";
      if (name || desc) lyr.bindPopup(`${name}${desc}`);
    },
  }).addTo(map);

  const bounds = layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
  else map.setView([0, 0], 2); // nothing geocoded — show the whole world
  return map;
}

/** Fetch the file, convert to GeoJSON, and render a Leaflet map into `className`.
 *  Shared by the full page and the inline chunk (which only differ in height/CSS + annotation). */
function MapBody({
  path, className, regions, onSelectRegion, onRegionClick, selectColor,
}: {
  path: string;
  className: string;
  regions?: MapRegion[];
  onSelectRegion?: (selector: Record<string, unknown>, screen: { x: number; y: number }) => void;
  onRegionClick?: (ann: Annotation, screen: { x: number; y: number }) => void;
  selectColor?: () => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelectRegion);
  const onRegionClickRef = useRef(onRegionClick);
  const colorRef = useRef(selectColor);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(0);
  const regionsKey = JSON.stringify(regions ?? []);
  const selectable = !!onSelectRegion;

  useEffect(() => { onSelectRef.current = onSelectRegion; onRegionClickRef.current = onRegionClick; colorRef.current = selectColor; });

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setError(null);
    setLoading(true);
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled || !ref.current) return;
        const map = drawMap(ref.current, bytesToGeoJSON(new Uint8Array(buf)));
        layerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        dispose = wireGestures(map, {
          color: () => colorRef.current?.() ?? DEFAULT_COLOR,
          onSelect: selectable
            ? (b, screen) => onSelectRef.current?.({ type: "map", n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() }, screen)
            : undefined,
        });
        setReady((x) => x + 1);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String((e as Error).message || e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      dispose?.();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Each saved fragment's rectangle keyed by its `#`-anchor id, so a hash reveal can pan to + flash
  // it (a Leaflet rect is SVG outside the page scroll flow — scrollIntoView can't reach it).
  const shapesRef = useRef(new Map<string, { rect: L.Rectangle; bounds: L.LatLngBoundsExpression }>());

  // Draw region rectangles into the overlay layer — in place, so creating one keeps the view.
  useEffect(() => {
    const lg = layerRef.current;
    if (!lg) return;
    lg.clearLayers();
    shapesRef.current.clear();
    for (const r of regions ?? []) {
      const c = r.color || DEFAULT_COLOR;
      const bounds: L.LatLngBoundsExpression = [[r.s, r.w], [r.n, r.e]];
      const rect = L.rectangle(bounds, { className: "yo-region", color: c, weight: 3, fillColor: c, fillOpacity: 0.25 });
      if (r.title) rect.bindTooltip(r.title);
      if (r.ann) {
        const ann = r.ann;
        rect.on("click", (ev) => { L.DomEvent.stop(ev); onRegionClickRef.current?.(ann, { x: ev.originalEvent.clientX, y: ev.originalEvent.clientY }); });
      }
      rect.addTo(lg);
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
      {error && <div className="error">map: {error}</div>}
      <div ref={ref} className={className + (selectable ? " yo-selectable" : "")} />
      {loading && !error && <div className="loading">loading map…</div>}
    </>
  );
}

export function MapView({ node }: { node: NodeJson }) {
  const material = useMaterialAnnotations(node.path);
  const { openCreate, openEdit, palette, preview, color } = useAnnotationMenu(material, node.path);
  const shown = preview
    ? [...material.annotations, { path: "(preview)", selector: preview.selector, tag: preview.tag } as Annotation]
    : material.annotations;
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <MapBody path={node.path} regions={mapRegions(shown, node.path)} onSelectRegion={openCreate} onRegionClick={openEdit} selectColor={() => color} className="filemap" />
      {palette}
    </div>
  );
}

export function MapChunk({ chunk }: { chunk: Chunk }) {
  return <MapBody path={chunk.path} className="filemap chunk-map" />;
}
