import { useLayoutEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { NodeJson, blobUrl } from "../api";

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

  // Track the pane width so pages re-flow on resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="filepdf" ref={ref}>
      <Document file={blobUrl(node.path)} onLoadSuccess={({ numPages }) => setPages(numPages)} loading="…">
        {width > 0 &&
          Array.from({ length: pages }, (_, i) => (
            <Page key={i} pageNumber={i + 1} width={Math.min(width, 1000)} />
          ))}
      </Document>
    </div>
  );
}
