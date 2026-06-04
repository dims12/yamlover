import { kml as kmlDomToGeoJSON } from "@tmcw/togeojson";
import { unzipSync, strFromU8 } from "fflate";

/**
 * The pure (Leaflet-free) half of the map renderer: turn the bytes of a `.kml` or
 * `.kmz` file into GeoJSON. Kept apart from `map.tsx` so it can be unit-tested
 * without importing Leaflet (a browser-only library with CSS side effects).
 *
 *   - **KML** is XML — decoded as text, parsed to a DOM, then converted with
 *     `@tmcw/togeojson`.
 *   - **KMZ** is a ZIP — unzipped (with the already-bundled `fflate`); its first
 *     `.kml` entry is the document, then the same KML path.
 */

/** A GeoJSON FeatureCollection (the shape togeojson returns). Loosely typed — the
 *  map renderer only hands it to Leaflet's `L.geoJSON`. */
export interface GeoJSON {
  type: "FeatureCollection";
  features: unknown[];
}

/** Whether `bytes` begin with the ZIP local-file signature `PK\x03\x04` — i.e. a
 *  KMZ rather than a bare KML. Robust regardless of the file's extension. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Parse a KML XML string into GeoJSON via a DOM (available in the browser and in
 *  jsdom tests). */
export function kmlStringToGeoJSON(xml: string): GeoJSON {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("malformed KML XML");
  return kmlDomToGeoJSON(dom) as unknown as GeoJSON;
}

/** Parse `.kml`/`.kmz` bytes into GeoJSON. KMZ is detected by its ZIP signature
 *  (not just the extension); the first `.kml` entry inside is the document. */
export function bytesToGeoJSON(bytes: Uint8Array): GeoJSON {
  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!name) throw new Error("no .kml document inside the KMZ archive");
    return kmlStringToGeoJSON(strFromU8(files[name]));
  }
  return kmlStringToGeoJSON(new TextDecoder().decode(bytes));
}
