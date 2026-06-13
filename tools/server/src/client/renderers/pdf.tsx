import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Annotation, NodeJson, blobUrl } from "../api";
import { DEFAULT_COLOR, colorOf, editable, useAnnotationMenu, useMaterialAnnotations } from "./annotate";
import { usePagedScroll } from "./paged";

/** A rectangular annotation region on a PDF page, in points (origin top-left). `ann` is the source
 *  annotation when real/saved (→ clickable to edit); absent for the live preview. */
interface PdfRegion { page: number; x: number; y: number; w: number; h: number; title?: string; color?: string; ann?: Annotation }
const num = (v: unknown): number => Number(v) || 0;

// pdf.js renders in a Web Worker; point it at the bundled worker (the version
// react-pdf depends on) resolved through Vite. Done once at module load.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/**
 * Renders a `application/pdf` file with pdf.js (via react-pdf): every page laid out top-to-bottom,
 * fit to the pane's width. A plain wheel scrolls the document and text stays selectable; ctrl/alt-
 * wheel zooms (scales the page width), matching the image/map viewers (see the UI guide).
 * SELECTING text on a page raises the color palette and saves a `pdf` region annotation (the
 * selection's bounding box, in page points) — the same flow as image/map regions. The document is
 * loaded straight from `/api/blob` so pdf.js streams the bytes itself.
 */
export function PdfView({ node }: { node: NodeJson }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1); // ctrl/alt-wheel scale factor
  const [orig, setOrig] = useState<Record<number, { w: number; h: number }>>({}); // each page's natural size in points
  // Pages whose pdf.js TEXT LAYER is unusable for selection — absent (a scanned PDF has no text)
  // or pathological (some fonts make pdf.js emit glyph boxes many times a line tall, so a text
  // selection's geometry is garbage). Such pages fall back to a drag-marquee, like images.
  const [marquee, setMarquee] = useState<Set<number>>(() => new Set());
  const [drag, setDrag] = useState<{ page: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Zoom scales the page content via a CSS transform (no re-raster → no blink). The transformed
  // `.pdf-content` is out of flow, so a `.pdf-sizer` reserves the SCALED footprint to keep the
  // scrollbar/height right; `contentH` is the content's natural (unscaled) height, measured below.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(0);

  // WINDOWED RENDERING: every page keeps a wrapper (so the scroll height is right), but only
  // pages near the viewport mount a real <Page> — mounting ALL of them queues every canvas
  // through the pdf.js worker at open (and again on each zoom), which saturates the main
  // thread and janks scrolling on long documents. Far pages are fixed-height placeholders.
  const wraps = useRef(new Map<number, HTMLElement>());
  const [near, setNear] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (!pages) return;
    const obs = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const pn = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(pn);
            else next.delete(pn);
          }
          return next.size === prev.size && [...next].every((p) => prev.has(p)) ? prev : next;
        });
      },
      // root = the .filepdf scroller (the pane scrolls INSIDE it — a viewport root would
      // never see pages clipped below its fold); pre-render ~2 screens above/below
      { root: ref.current, rootMargin: "2000px 0px" },
    );
    for (const el of wraps.current.values()) obs.observe(el);
    return () => obs.disconnect();
    // wrappers exist only once BOTH the page count and the pane width are known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, width > 0]);

  const material = useMaterialAnnotations(node.path);
  const { openCreate, openEdit, palette, preview } = useAnnotationMenu(material);
  // include the live PREVIEW so the rectangle stays drawn while the menu is open
  const shown = preview
    ? [...material.annotations, { path: "(preview)", selector: preview.selector, tag: preview.tag } as Annotation]
    : material.annotations;
  const regions: PdfRegion[] = shown
    .filter((a) => a.selector?.type === "pdf")
    .map((a) => ({ page: num(a.selector!.page) || 1, x: num(a.selector!.x), y: num(a.selector!.y), w: num(a.selector!.w), h: num(a.selector!.h), title: a.description, color: colorOf(a), ann: editable(a) ? a : undefined }));

  // Page tracking + zoom-anchoring (`?page=` in the URL; same page stays put across a zoom). Every
  // page has a `.pdf-page` wrapper (windowing swaps only the CONTENT), so the list is dense 1..N.
  const getPageEls = () => {
    const out: HTMLElement[] = [];
    for (let i = 1; i <= pages; i++) { const el = wraps.current.get(i); if (el) out.push(el); }
    return out;
  };
  const paged = usePagedScroll(ref, getPageEls, width > 0 && pages > 0);
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  // After a zoom COMMIT reflows the pages, restore the captured reading position.
  useLayoutEffect(() => { paged.restoreAnchor(); }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the pane width so pages re-flow on resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure the content's natural (unscaled) height so the sizer can reserve `height*disp`.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentH(el.offsetHeight));
    ro.observe(el);
    setContentH(el.offsetHeight);
    return () => ro.disconnect();
  }, [pages, width > 0]);

  // ctrl/alt-wheel zooms; a plain wheel is left alone so the pane keeps scrolling. Zoom is applied
  // as a CSS scale on the content (below) — NOT by re-rastering the pages — so it never blinks; the
  // reading position is anchored at the start of a wheel burst and restored after each step.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let bursting = false;
    let end = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
      e.preventDefault();
      if (!bursting) { pagedRef.current.captureAnchor(); bursting = true; }
      clearTimeout(end);
      end = window.setTimeout(() => (bursting = false), 250);
      setZoom((z) => Math.min(5, Math.max(0.4, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); clearTimeout(end); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // RASTER the pages at a FIXED, zoom-independent width (supersampled by QUALITY so CSS zoom-in
  // stays crisp to ~QUALITY×), and apply the user's zoom as a CSS scale on the content wrapper.
  // Because the <Page width> never changes with zoom, pdf.js never re-rasterises (no canvas remount,
  // no white flash) and the windowed `near` set doesn't churn — zoom is a pure, blink-free reflow.
  const QUALITY = 2;
  const pageWidth = Math.min(width, 1000) * QUALITY; // the raster width fed to <Page>
  const disp = zoom / QUALITY; // CSS zoom on the content; display width = pageWidth*disp = base*zoom
  const previewColor = preview?.color ?? DEFAULT_COLOR;

  // Judge a page's text layer once it has rendered: unusable when there is no real text (< 3
  // spans) or a typical glyph box is an implausible fraction of the page height (a normal line is
  // ~1–2%; the pathological case is ~30%). Unusable pages switch to the marquee overlay below.
  const judgeTextLayer = (pn: number) => {
    const wrap = wraps.current.get(pn);
    const tl = wrap?.querySelector(".textLayer");
    const pageH = wrap?.getBoundingClientRect().height || 0;
    let unusable = true;
    if (tl && pageH) {
      const hs = [...tl.querySelectorAll("span")]
        .filter((s) => s.textContent?.trim())
        .map((s) => s.getBoundingClientRect().height)
        .sort((a, b) => a - b);
      unusable = hs.length < 3 || hs[hs.length >> 1] / pageH > 0.05;
    }
    setMarquee((m) => {
      if (unusable === m.has(pn)) return m;
      const next = new Set(m);
      if (unusable) next.add(pn);
      else next.delete(pn);
      return next;
    });
  };

  // Marquee drag on an unusable-text-layer page. The wrapper rect is in DISPLAY (CSS-zoomed) px;
  // divide by `disp` so coords are in RASTER (content-local) px — the same space the preview rect
  // and saved regions render in (they live inside the zoomed content), and `/sc` then gives points.
  const dragStart = (pn: number, e: React.MouseEvent) => {
    const wrap = wraps.current.get(pn);
    if (!wrap) return;
    const pr = wrap.getBoundingClientRect();
    const x = (e.clientX - pr.left) / disp, y = (e.clientY - pr.top) / disp;
    setDrag({ page: pn, x0: x, y0: y, x1: x, y1: y });
  };
  const dragMove = (e: React.MouseEvent) =>
    setDrag((d) => {
      const wrap = d && wraps.current.get(d.page);
      if (!wrap) return d;
      const pr = wrap.getBoundingClientRect();
      return { ...d!, x1: (e.clientX - pr.left) / disp, y1: (e.clientY - pr.top) / disp };
    });
  const dragEnd = (pn: number, e: React.MouseEvent) => {
    const d = drag;
    setDrag(null);
    if (!d || d.page !== pn) return;
    const sc = orig[pn] ? pageWidth / orig[pn].w : 0; // raster px per point
    const wrap = wraps.current.get(pn);
    if (!sc || !wrap) return;
    const pr = wrap.getBoundingClientRect();
    const x1 = (e.clientX - pr.left) / disp, y1 = (e.clientY - pr.top) / disp; // raster px
    const left = Math.min(d.x0, x1), top = Math.min(d.y0, y1), w = Math.abs(x1 - d.x0), h = Math.abs(y1 - d.y0);
    if (w * disp < 3 || h * disp < 3) return; // a click, not a drag (threshold in display px)
    openCreate(
      { type: "pdf", page: pn, x: Math.round(left / sc), y: Math.round(top / sc), w: Math.round(w / sc), h: Math.round(h / sc) },
      { x: pr.left + left * disp, y: pr.top + (top + h) * disp + 6 }, // menu position in viewport px
    );
  };

  // A finished text selection on a page → a `pdf` region (its bounding box, converted to points).
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    const host = sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement;
    const pageEl = host?.closest(".pdf-page") as HTMLElement | null;
    if (!pageEl || !ref.current?.contains(pageEl)) return;
    const pn = Number(pageEl.dataset.page);
    const sc = orig[pn] ? pageWidth / orig[pn].w : 0; // raster px per point
    if (!sc) return;
    const pr = pageEl.getBoundingClientRect(); // display (CSS-zoomed) px
    const sr = sel.getRangeAt(0).getBoundingClientRect();
    if (sr.width < 2 || sr.height < 2) return;
    // sr/pr are display px → ÷disp to raster (content-local) px, then ÷sc to points.
    const k = sc * disp; // display px per point
    openCreate(
      { type: "pdf", page: pn, x: Math.round((sr.left - pr.left) / k), y: Math.round((sr.top - pr.top) / k), w: Math.round(sr.width / k), h: Math.round(sr.height / k) },
      { x: sr.left, y: sr.bottom + 6 },
    );
  };

  return (
    <>
      <div className="filepdf yo-zoomable" ref={ref} onMouseUp={onMouseUp}>
        <Document
          file={blobUrl(node.path)}
          onLoadSuccess={({ numPages }) => setPages(numPages)}
          loading={<div className="loading">loading PDF…</div>}
          error={<div className="error">could not load PDF</div>}
        >
          {width > 0 && (
            <div className="pdf-sizer" style={{ width: pageWidth * disp, height: contentH * disp }}>
            <div className="pdf-content" ref={contentRef} style={{ width: pageWidth, transform: `scale(${disp})`, transformOrigin: "top left" }}>
            {Array.from({ length: pages }, (_, i) => {
              const pn = i + 1;
              const sc = orig[pn] ? pageWidth / orig[pn].w : 0; // RASTER px per point (regions render inside the CSS-zoomed content)
              // a far page's placeholder: its measured aspect when known, A4 portrait until then
              const estHeight = pageWidth * (orig[pn] ? orig[pn].h / orig[pn].w : Math.SQRT2);
              return (
                <div
                  key={i}
                  className="pdf-page"
                  data-page={pn}
                  ref={(el) => {
                    if (el) wraps.current.set(pn, el);
                    else wraps.current.delete(pn);
                  }}
                >
                  {near.has(pn) ? (
                    <>
                      <Page
                        pageNumber={pn}
                        width={pageWidth}
                        onLoadSuccess={(p) => setOrig((o) => (o[pn] ? o : { ...o, [pn]: { w: p.originalWidth || pageWidth, h: p.originalHeight || pageWidth * Math.SQRT2 } }))}
                        onRenderTextLayerSuccess={() => judgeTextLayer(pn)}
                        loading={<div className="loading" style={{ height: estHeight }}>page {pn}…</div>}
                      />
                      {/* unusable text layer → a crosshair marquee over the page (drag a box). It
                          sits ABOVE the text layer but BELOW the region divs (rendered next), so
                          existing editable regions stay clickable while empty areas start a drag. */}
                      {marquee.has(pn) && sc > 0 && (
                        <div className="pdf-marquee" onMouseDown={(e) => dragStart(pn, e)} onMouseMove={dragMove} onMouseUp={(e) => dragEnd(pn, e)}>
                          {drag?.page === pn && (
                            <div
                              className="pdf-region"
                              style={{
                                left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
                                width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
                                borderColor: previewColor, background: previewColor + "2e",
                              }}
                            />
                          )}
                        </div>
                      )}
                      {sc > 0 &&
                        regions.filter((r) => r.page === pn).map((r, j) => {
                          const c = r.color || DEFAULT_COLOR;
                          return (
                            <div
                              key={j}
                              className={"pdf-region" + (r.ann ? " editable" : "")}
                              title={r.ann ? r.title || "click to recolor or delete" : r.title}
                              onClick={r.ann ? (e) => { e.stopPropagation(); openEdit(r.ann!, { x: e.clientX, y: e.clientY }); } : undefined}
                              style={{ left: r.x * sc, top: r.y * sc, width: r.w * sc, height: r.h * sc, borderColor: c, background: c + "2e" }}
                            />
                          );
                        })}
                    </>
                  ) : (
                    <div className="pdf-placeholder" style={{ width: pageWidth, height: estHeight }} />
                  )}
                </div>
              );
            })}
            </div>
            </div>
          )}
        </Document>
      </div>
      {palette}
    </>
  );
}
