import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Annotation, NodeJson, blobUrl } from "../api";
import { DEFAULT_COLOR, useAnnotationMenu, useMaterialAnnotations } from "./annotate";

/** A rectangular annotation region on a PDF page, in points (origin top-left). `ann` is the source
 *  annotation when real/saved (→ clickable to edit); absent for the live preview. */
interface PdfRegion { page: number; x: number; y: number; w: number; h: number; title?: string; color?: string; ann?: Annotation }
const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const editable = (a: Annotation): boolean => !!a.path && a.path !== "(pending)" && a.path !== "(preview)";

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
  const [orig, setOrig] = useState<Record<number, number>>({}); // each page's natural width in points

  const material = useMaterialAnnotations(node.path);
  const { openCreate, openEdit, palette, preview } = useAnnotationMenu(material);
  // include the live PREVIEW so the rectangle stays drawn while the menu is open
  const shown = preview
    ? [...material.annotations, { path: "(preview)", selector: { ...preview.selector, color: preview.color } } as Annotation]
    : material.annotations;
  const regions: PdfRegion[] = shown
    .filter((a) => a.selector?.type === "pdf")
    .map((a) => ({ page: num(a.selector!.page) || 1, x: num(a.selector!.x), y: num(a.selector!.y), w: num(a.selector!.w), h: num(a.selector!.h), title: a.body, color: str(a.selector!.color), ann: editable(a) ? a : undefined }));

  // Track the pane width so pages re-flow on resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ctrl/alt-wheel zooms; a plain wheel is left alone so the pane keeps scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
      e.preventDefault();
      setZoom((z) => Math.min(5, Math.max(0.4, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const pageWidth = Math.min(width, 1000) * zoom;

  // A finished text selection on a page → a `pdf` region (its bounding box, converted to points).
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    const host = sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement;
    const pageEl = host?.closest(".pdf-page") as HTMLElement | null;
    if (!pageEl || !ref.current?.contains(pageEl)) return;
    const pn = Number(pageEl.dataset.page);
    const sc = orig[pn] ? pageWidth / orig[pn] : 0; // rendered px per point
    if (!sc) return;
    const pr = pageEl.getBoundingClientRect();
    const sr = sel.getRangeAt(0).getBoundingClientRect();
    if (sr.width < 2 || sr.height < 2) return;
    openCreate(
      { type: "pdf", page: pn, x: Math.round((sr.left - pr.left) / sc), y: Math.round((sr.top - pr.top) / sc), w: Math.round(sr.width / sc), h: Math.round(sr.height / sc) },
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
          {width > 0 &&
            Array.from({ length: pages }, (_, i) => {
              const pn = i + 1;
              const sc = orig[pn] ? pageWidth / orig[pn] : 0; // rendered px per point — tracks zoom
              return (
                <div key={i} className="pdf-page" data-page={pn}>
                  <Page
                    pageNumber={pn}
                    width={pageWidth}
                    onLoadSuccess={(p) => setOrig((o) => (o[pn] ? o : { ...o, [pn]: p.originalWidth || pageWidth }))}
                    loading={<div className="loading">page {pn}…</div>}
                  />
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
                </div>
              );
            })}
        </Document>
      </div>
      {palette}
    </>
  );
}
