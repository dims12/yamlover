import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation, NodeJson, blobUrl } from "../api";
import { fragmentAnchorId } from "../paths";
import { DEFAULT_COLOR, colorOf, editable, useAnnotationMenu, useMaterialAnnotations } from "./annotate";
import { usePagedScroll } from "./paged";
import { DecodedPage, decodeDjvuPage, openDjvu } from "./djvuWorker";

const num = (v: unknown): number => Number(v) || 0;
/** A rectangular annotation region on a DjVu page, in the page's NATIVE pixels (like the OCR zones),
 *  so it's zoom-independent. `ann` is the saved annotation (→ clickable to edit). */
interface DjvuRegion { page: number; x: number; y: number; w: number; h: number; title?: string; color?: string; ann?: Annotation }

/** Paints worker-decoded DjVu pixels into a <canvas> at native size (CSS-scaled to the display
 *  width by the wrapper). putImageData is cheap; no PNG encode and no main-thread decompression. */
function DjvuCanvas({ image }: { image: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")?.putImageData(image, 0, 0);
  }, [image]);
  return <canvas className="djvu-page" ref={ref} />;
}

/**
 * Renders an `image/vnd.djvu` document. DjVu.js decodes pages in a Web Worker (djvuWorker.ts), and
 * only the pages NEAR the viewport decode (windowed, like the PDF viewer) — so a long scan opens
 * fast and the main thread stays free to annotate while pages decode. Each decoded page is a
 * <canvas> (the worker returns ImageData). An OCR text layer (when present) makes text selectable →
 * a region annotation; pages without OCR get a drag-marquee instead. ctrl/alt-wheel zooms (a CSS
 * resize — no re-decode), with the reading position anchored across zoom; `?page=` tracks the page.
 */
export function DjvuView({ node }: { node: NodeJson }) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0); // pane width (so a page caps at ~1000px like PDF, not full pane)
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ page: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [near, setNear] = useState<Set<number>>(() => new Set()); // pages near the viewport
  const [decoded, setDecoded] = useState<Map<number, DecodedPage>>(() => new Map()); // near pages' pixels+zones
  const sizes = useRef(new Map<number, { w: number; h: number }>()); // remembered native sizes → stable placeholders

  // Annotations: a `djvu` rect region (page + native-pixel box) from a text selection on an OCR
  // page, or a drag-marquee on a page with no OCR. Same picker/flow as image & PDF.
  const material = useMaterialAnnotations(node.path);
  const { openCreate, openEdit, palette, preview } = useAnnotationMenu(material, node.path);
  const regions: DjvuRegion[] = material.annotations
    .filter((a) => a.selector?.type === "djvu")
    .map((a) => ({ page: num(a.selector!.page) || 1, x: num(a.selector!.x), y: num(a.selector!.y), w: num(a.selector!.w), h: num(a.selector!.h), title: a.description, color: colorOf(a), ann: editable(a) ? a : undefined }));
  // keep the just-drawn rectangle visible while the menu is open — in the NEUTRAL preview color (no
  // tag yet), an extra region rather than a synthetic tagged annotation.
  const previewColor = preview?.color ?? DEFAULT_COLOR;
  if (preview?.selector.type === "djvu") {
    const s = preview.selector;
    regions.push({ page: num(s.page) || 1, x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h), color: preview.color });
  }

  // WINDOWED RENDERING: every page keeps a `.djvu-page-wrap` (so the scroll height is right), but
  // only near pages decode + mount a canvas; far pages are estimated-height placeholders.
  const wraps = useRef(new Map<number, HTMLElement>());
  const getPageEls = () => {
    const out: HTMLElement[] = [];
    for (let i = 1; i <= count; i++) { const el = wraps.current.get(i); if (el) out.push(el); }
    return out;
  };
  const paged = usePagedScroll(ref, getPageEls, count > 0 && width > 0);
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  useLayoutEffect(() => { paged.restoreAnchor(); }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the `.filedjvu` scroller on mount so arrows / space / PageUp-Down scroll the document
  // natively (it's a nested scroller the focused RHS pane can't reach). Skip when chunk-embedded.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.closest(".chunk-body")) el.focus({ preventScroll: true });
  }, []);

  // Track the pane width so a page fits but is capped (≤1000px) like the PDF viewer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dispW = Math.min(width, 1000) * zoom; // each page's displayed width in px

  // ctrl/alt-wheel zooms; a plain wheel scrolls. Zoom is a CSS resize (no re-decode), applied live;
  // the reading position is anchored at the burst start and restored after each step.
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

  // Open the document in the worker (off the main thread) → page count. Decoding happens lazily,
  // per near page, in the effect below.
  useEffect(() => {
    let cancelled = false;
    setCount(0); setError(null); setNear(new Set()); setDecoded(new Map());
    wraps.current.clear(); sizes.current.clear();
    (async () => {
      const buf = await fetch(blobUrl(node.path)).then((r) => r.arrayBuffer());
      const n = await openDjvu(buf, node.path);
      if (!cancelled) setCount(n);
    })().catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => { cancelled = true; };
  }, [node.path]);

  // Windowed observer (mirror the PDF viewer): mark pages near the viewport.
  useEffect(() => {
    if (!count) return;
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
      { root: ref.current, rootMargin: "2000px 0px" },
    );
    for (const el of wraps.current.values()) obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, width > 0]);

  // Decode near pages (lazy, in the worker); drop decoded pixels that left the window to bound
  // memory (the worker keeps an LRU cache, so re-entry is fast).
  useEffect(() => {
    let alive = true;
    near.forEach((n) => {
      if (!decoded.has(n)) {
        decodeDjvuPage(n)
          .then((dp) => {
            sizes.current.set(n, { w: dp.w, h: dp.h });
            if (alive) setDecoded((m) => new Map(m).set(n, dp));
          })
          .catch(() => {});
      }
    });
    setDecoded((m) => {
      let changed = false;
      const x = new Map(m);
      for (const k of x.keys()) if (!near.has(k)) { x.delete(k); changed = true; }
      return changed ? x : m;
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near]);

  // A finished text selection on an OCR page → a `djvu` region (its bounding box, in native px).
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    const hostEl = sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement;
    const wrap = hostEl?.closest(".djvu-page-wrap") as HTMLElement | null;
    if (!wrap || !ref.current?.contains(wrap)) return;
    const pn = Number(wrap.dataset.page);
    const wr = wrap.getBoundingClientRect();
    const s = wr.width / (decoded.get(pn)?.w || 1); // display px per native px
    if (!s) return;
    const sr = sel.getRangeAt(0).getBoundingClientRect();
    if (sr.width < 2 || sr.height < 2) return;
    openCreate(
      { type: "djvu", page: pn, x: Math.round((sr.left - wr.left) / s), y: Math.round((sr.top - wr.top) / s), w: Math.round(sr.width / s), h: Math.round(sr.height / s) },
      { x: sr.left, y: sr.bottom + 6 },
    );
  };

  // Marquee drag on a page with NO OCR: draw a box, convert to native px.
  const scaleOf = (pn: number, wrap: HTMLElement) => wrap.getBoundingClientRect().width / (decoded.get(pn)?.w || 1);
  const dragStart = (pn: number, e: React.MouseEvent) => {
    const wr = e.currentTarget.getBoundingClientRect();
    const s = scaleOf(pn, e.currentTarget as HTMLElement);
    setDrag({ page: pn, x0: (e.clientX - wr.left) / s, y0: (e.clientY - wr.top) / s, x1: (e.clientX - wr.left) / s, y1: (e.clientY - wr.top) / s });
  };
  const dragMove = (pn: number, e: React.MouseEvent) => {
    const wr = e.currentTarget.getBoundingClientRect();
    const s = scaleOf(pn, e.currentTarget as HTMLElement);
    setDrag((d) => (d ? { ...d, x1: (e.clientX - wr.left) / s, y1: (e.clientY - wr.top) / s } : d));
  };
  const dragEnd = (pn: number, e: React.MouseEvent) => {
    const d = drag;
    setDrag(null);
    if (!d || d.page !== pn) return;
    const s = scaleOf(pn, e.currentTarget as HTMLElement);
    const left = Math.min(d.x0, d.x1), top = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w * s < 3 || h * s < 3) return; // a click, not a drag
    const wr = e.currentTarget.getBoundingClientRect();
    openCreate(
      { type: "djvu", page: pn, x: Math.round(left), y: Math.round(top), w: Math.round(w), h: Math.round(h) },
      { x: wr.left + left * s, y: wr.top + (top + h) * s + 6 },
    );
  };

  if (error) return <div className="error">djvu: {error}</div>;
  return (
    <>
      <div className="filedjvu yo-zoomable" ref={ref} tabIndex={0} onMouseUp={onMouseUp}>
        {count === 0 && <div className="loading">opening djvu…</div>}
        {width > 0 &&
          Array.from({ length: count }, (_, i) => {
            const pn = i + 1;
            const dp = near.has(pn) ? decoded.get(pn) : undefined;
            const size = sizes.current.get(pn);
            const estHeight = dispW * (size ? size.h / size.w : Math.SQRT2);
            const s = dp ? dispW / dp.w : 0;
            return (
              <div
                key={i}
                className="djvu-page-wrap"
                data-page={pn}
                ref={(el) => { if (el) wraps.current.set(pn, el); else wraps.current.delete(pn); }}
                style={{ width: dispW, height: dp ? undefined : estHeight }}
              >
                {dp ? (
                  <>
                    <DjvuCanvas image={dp.image} />
                    {dp.zones.length > 0 ? (
                      <div className="djvu-textlayer">
                        {dp.zones.map((z, j) => (
                          <span key={j} style={{ left: z.x * s, top: z.y * s, width: z.width * s, height: z.height * s, fontSize: z.height * s }}>{z.text}</span>
                        ))}
                      </div>
                    ) : (
                      <div className="djvu-marquee" onMouseDown={(e) => dragStart(pn, e)} onMouseMove={(e) => dragMove(pn, e)} onMouseUp={(e) => dragEnd(pn, e)}>
                        {drag?.page === pn && (
                          <div className="djvu-region" style={{ left: Math.min(drag.x0, drag.x1) * s, top: Math.min(drag.y0, drag.y1) * s, width: Math.abs(drag.x1 - drag.x0) * s, height: Math.abs(drag.y1 - drag.y0) * s, borderColor: previewColor, background: previewColor + "2e" }} />
                        )}
                      </div>
                    )}
                    {regions.filter((r) => r.page === pn).map((r, j) => {
                      const c = r.color || DEFAULT_COLOR;
                      return (
                        <div
                          key={j}
                          id={r.ann?.fragmentSlug ? fragmentAnchorId(node.path, r.ann.fragmentSlug) : undefined}
                          className={"djvu-region" + (r.ann ? " editable" : "")}
                          title={r.ann ? r.title || "click to recolor or delete" : r.title}
                          onClick={r.ann ? (e) => { e.stopPropagation(); openEdit(r.ann!, { x: e.clientX, y: e.clientY }); } : undefined}
                          style={{ left: r.x * s, top: r.y * s, width: r.w * s, height: r.h * s, borderColor: c, background: c + "2e" }}
                        />
                      );
                    })}
                  </>
                ) : (
                  <div className="djvu-placeholder">{near.has(pn) ? "decoding…" : ""}</div>
                )}
              </div>
            );
          })}
      </div>
      {palette}
    </>
  );
}
