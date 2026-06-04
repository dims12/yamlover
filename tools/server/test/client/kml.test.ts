// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { bytesToGeoJSON, isZip, kmlStringToGeoJSON } from "../../src/client/renderers/kml";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Gate</name><Point><coordinates>13.3777,52.5163,0</coordinates></Point></Placemark>
  <Placemark><name>Walk</name><LineString><coordinates>13.37,52.51,0 13.38,52.52,0</coordinates></LineString></Placemark>
</Document></kml>`;

const bin = (format: string): NodeJson => ({
  path: "/f",
  type: "binary",
  format,
  concrete: null,
  title: null,
  description: null,
  value: "",
});

describe("kml → GeoJSON", () => {
  it("converts KML placemarks to GeoJSON features (point + line)", () => {
    const geo = kmlStringToGeoJSON(KML);
    expect(geo.type).toBe("FeatureCollection");
    const types = geo.features.map((f: any) => f.geometry.type);
    expect(types).toContain("Point");
    expect(types).toContain("LineString");
    const point = geo.features.find((f: any) => f.geometry.type === "Point") as any;
    expect(point.properties.name).toBe("Gate");
    expect(point.geometry.coordinates.slice(0, 2)).toEqual([13.3777, 52.5163]);
  });

  it("detects a KMZ by its ZIP signature and reads its inner .kml", () => {
    const kmz = zipSync({ "doc.kml": strToU8(KML) });
    expect(isZip(kmz)).toBe(true);
    expect(isZip(new TextEncoder().encode(KML))).toBe(false);
    const geo = bytesToGeoJSON(kmz);
    expect(geo.features.length).toBe(2); // same two placemarks, via the zip path
  });

  it("bytesToGeoJSON also handles a bare (unzipped) KML", () => {
    const geo = bytesToGeoJSON(new TextEncoder().encode(KML));
    expect(geo.features.length).toBe(2);
  });

  it("throws a clear error for a KMZ with no .kml inside", () => {
    const kmz = zipSync({ "readme.txt": strToU8("nope") });
    expect(() => bytesToGeoJSON(kmz)).toThrow(/no .kml/i);
  });
});

describe("map renderer registry", () => {
  it("selects the map renderer for KML and KMZ, with a chunk form", () => {
    const r = getRenderer(bin("application/vnd.google-earth.kml+xml"));
    expect(r?.name).toBe("map");
    expect(getRenderer(bin("application/vnd.google-earth.kmz"))?.name).toBe("map");
    expect(r?.renderChunk).toBeTypeOf("function"); // usable as a chapter chunk
  });
});
