import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";
import { bytesToGeoJSON, GeoJSON } from "./kml";

/**
 * Renderer for geographic overlays — `.kml` and `.kmz` (zipped KML). The file is
 * served as bytes; we convert it to GeoJSON (see `kml.ts`) and draw it on a
 * Leaflet slippy map over OpenStreetMap tiles, fitting the view to the data.
 * Points become circle markers, lines/polygons keep their KML colours, and a
 * feature's name/description show in a popup.
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
 *  Shared by the full page and the inline chunk (which only differ in height/CSS). */
function MapBody({ path, className }: { path: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;
    setError(null);
    setLoading(true);
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled || !ref.current) return;
        map = drawMap(ref.current, bytesToGeoJSON(new Uint8Array(buf)));
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
      map?.remove();
    };
  }, [path]);

  return (
    <>
      {error && <div className="error">map: {error}</div>}
      <div ref={ref} className={className} />
      {loading && !error && <div className="loading">loading map…</div>}
    </>
  );
}

export function MapView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <MapBody path={node.path} className="filemap" />
    </div>
  );
}

export function MapChunk({ chunk }: { chunk: Chunk }) {
  return <MapBody path={chunk.path} className="filemap chunk-map" />;
}
