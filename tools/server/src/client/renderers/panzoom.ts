import L from "leaflet";

/**
 * The unified pan/zoom/select gesture model for a Leaflet map (shared by the image viewer and the
 * KML map, see the UI guide). It overrides Leaflet's defaults so SELECTING is the primary gesture:
 *
 *   - plain DRAG    → rubber-band a selection rectangle (→ `onSelect`, to annotate the region)
 *   - ctrl/alt DRAG → pan (grab-and-drag the canvas)
 *   - plain WHEEL   → pan vertically (scroll the canvas, like scrolling text)
 *   - ctrl/alt WHEEL→ zoom around the cursor
 *
 * When `onSelect` is omitted (e.g. an inline chapter chunk, which has no annotation target), plain
 * drag PANS instead (Leaflet's default) and the plain wheel is left alone so the page keeps
 * scrolling — only ctrl/alt-wheel zoom is added. Returns a disposer to unwire everything.
 */
export interface GestureOptions {
  /** A plain-drag rectangle finished. `bounds` is in the map's coordinate space (CRS.Simple pixels
   *  for an image, lat/lng for a map); `screen` is the viewport point to anchor the menu at. */
  onSelect?: (bounds: L.LatLngBounds, screen: { x: number; y: number }) => void;
  /** The live rubber-band color (the current highlight color). */
  color?: () => string;
}

const hasMod = (e: MouseEvent | WheelEvent): boolean => e.ctrlKey || e.altKey || e.metaKey;

export function wireGestures(map: L.Map, opts: GestureOptions): () => void {
  const container = map.getContainer();
  const selectable = !!opts.onSelect;

  // Selecting needs drag free for the rubber-band; without it, keep Leaflet's drag-to-pan.
  if (selectable) map.dragging.disable();
  map.scrollWheelZoom.disable(); // we drive the wheel ourselves (pan vs. zoom by modifier)
  map.doubleClickZoom.disable();
  map.boxZoom.disable();

  let band: L.Rectangle | null = null;
  let start: L.LatLng | null = null;
  let startPt: L.Point | null = null;
  let panning = false;
  let panPrev: L.Point | null = null;

  const onDown = (e: L.LeafletMouseEvent) => {
    if (hasMod(e.originalEvent)) {
      if (!selectable) return; // dragging still enabled → Leaflet pans natively
      panning = true; // modifier-drag → manual pan
      panPrev = e.containerPoint;
      L.DomUtil.disableTextSelection();
    } else if (selectable) {
      start = e.latlng; // plain drag → rubber-band a selection
      startPt = e.containerPoint;
      const c = opts.color?.() ?? "#f9e2af";
      band = L.rectangle(L.latLngBounds(e.latlng, e.latlng), { className: "yo-band", color: c, weight: 1, fillColor: c, fillOpacity: 0.18, interactive: false }).addTo(map);
      L.DomUtil.disableTextSelection();
    }
  };
  const onMove = (e: L.LeafletMouseEvent) => {
    if (panning && panPrev) {
      map.panBy(panPrev.subtract(e.containerPoint), { animate: false });
      panPrev = e.containerPoint;
    } else if (band && start) {
      band.setBounds(L.latLngBounds(start, e.latlng));
    }
  };
  const onUp = (e: L.LeafletMouseEvent) => {
    L.DomUtil.enableTextSelection();
    if (panning) { panning = false; panPrev = null; return; }
    if (band && start && startPt) {
      const bounds = L.latLngBounds(start, e.latlng);
      const moved = startPt.distanceTo(e.containerPoint) >= 4; // ignore a click (zero-size drag)
      band.remove();
      band = null; start = null; startPt = null;
      const oe = e.originalEvent;
      if (moved) opts.onSelect!(bounds, { x: oe.clientX, y: oe.clientY });
    }
  };
  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);

  const onWheel = (ev: WheelEvent) => {
    if (hasMod(ev)) {
      ev.preventDefault();
      map.setZoomAround(map.mouseEventToLatLng(ev), map.getZoom() + (ev.deltaY < 0 ? 1 : -1));
    } else if (selectable) {
      ev.preventDefault(); // a full image/map view pans vertically on a plain wheel
      map.panBy([0, ev.deltaY], { animate: false });
    }
    // else (chunk, plain wheel): let the event bubble so the page scrolls
  };
  container.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    container.removeEventListener("wheel", onWheel);
    band?.remove();
  };
}
