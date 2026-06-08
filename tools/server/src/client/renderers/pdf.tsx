import { useLayoutEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { NodeJson, blobUrl } from "../api";
import { useAnnotations } from "./annotate";

/** A rectangular annotation region on a PDF page, in points (origin top-left). */
interface PdfRegion { page: number; x: number; y: number; w: number; h: number; title?: string }
const num = (v: unknown): number => Number(v) || 0;

// pdf.js renders in a Web Worker; point it at the bundled worker (the version
// react-pdf depends on) resolved through Vite. Done once at module load.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/**
 * Renders a `application/pdf` file with pdf.js (via react-pdf): every page laid
 * out top-to-bottom, fit to the pane's width. The document is loaded straight
 * from `/api/blob` so pdf.js streams the bytes itself.
 */
export function PdfView({ node }: { node: NodeJson }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState<Record<number, number>>({}); // rendered px per point, by page

  const regions: PdfRegion[] = useAnnotations(node.path)
    .filter((a) => a.selector?.type === "pdf")
    .map((a) => ({ page: num(a.selector!.page) || 1, x: num(a.selector!.x), y: num(a.selector!.y), w: num(a.selector!.w), h: num(a.selector!.h), title: a.body }));

  // Track the pane width so pages re-flow on resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.min(width, 1000);

  return (
    <div className="filepdf" ref={ref}>
      <Document
        file={blobUrl(node.path)}
        onLoadSuccess={({ numPages }) => setPages(numPages)}
        loading={<div className="loading">loading PDF…</div>}
        error={<div className="error">could not load PDF</div>}
      >
        {width > 0 &&
          Array.from({ length: pages }, (_, i) => {
            const pn = i + 1;
            const sc = scale[pn];
            return (
              <div key={i} className="pdf-page">
                <Page
                  pageNumber={pn}
                  width={pageWidth}
                  onLoadSuccess={(p) => setScale((s) => (s[pn] ? s : { ...s, [pn]: pageWidth / (p.originalWidth || pageWidth) }))}
                  loading={<div className="loading">page {pn}…</div>}
                />
                {sc &&
                  regions.filter((r) => r.page === pn).map((r, j) => (
                    <div
                      key={j}
                      className="pdf-region"
                      title={r.title}
                      style={{ left: r.x * sc, top: r.y * sc, width: r.w * sc, height: r.h * sc }}
                    />
                  ))}
              </div>
            );
          })}
      </Document>
    </div>
  );
}
