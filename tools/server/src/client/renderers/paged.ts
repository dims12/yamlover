import { useEffect, useRef } from "react";
import { pageFromUrl, writePageToUrl } from "../paths";

/** Page-tracking + zoom-anchoring for a vertically-paged viewer (PDF, DjVu). */
export interface PagedScroll {
  /** Record {page, fraction-within-page} from the current scroll — call BEFORE a zoom commit. */
  captureAnchor(): void;
  /** After the zoom reflow, put that same page+fraction back under the viewport. */
  restoreAnchor(): void;
  /** Scroll a 1-based page to the top of the viewport (used for the initial `?page=` restore). */
  scrollToPage(n: number): void;
  /** The page the URL asked for on mount (1 if none). */
  initialPage: number;
}

/**
 * Tracks the current page of a paged viewer and keeps it stable across zoom and reload.
 *
 * `scrollRef` is the scrolling container; `getPageEls()` returns the page elements top-to-bottom
 * (1-based by array index, may be short/sparse before everything has rendered); `ready` is true
 * once pages are laid out enough to measure. While ready it (a) writes the current page to `?page=`
 * on scroll (rAF-throttled, replaceState — no remount), (b) restores `?page=` once on load
 * (re-attempting until the target page's height settles, since it may start as a placeholder), and
 * (c) exposes capture/restore so the caller can hold the reading position across a zoom reflow.
 *
 * All geometry uses getBoundingClientRect relative to the scroller, so it is correct regardless of
 * which element is the page's offsetParent.
 */
export function usePagedScroll(
  scrollRef: React.RefObject<HTMLElement | null>,
  getPageEls: () => HTMLElement[],
  ready: boolean,
): PagedScroll {
  const initialPage = useRef(pageFromUrl()).current;
  const anchor = useRef<{ page: number; fraction: number } | null>(null);
  const suppress = useRef(false); // true around a programmatic scroll → don't write ?page=
  const restored = useRef(false); // initial ?page= scroll settled
  const lastH = useRef(0); // target-page height at the last restore attempt (settled when stable)

  // A page's top in the scroller's content coordinates (offsetParent-agnostic).
  const contentTop = (el: HTMLElement): number => {
    const sc = scrollRef.current!;
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };
  // The 1-based page at the viewport's "reading" line (a bit below the top).
  const currentPage = (): number => {
    const sc = scrollRef.current;
    const els = getPageEls();
    if (!sc || !els.length) return 1;
    const probeY = sc.getBoundingClientRect().top + sc.clientHeight * 0.3;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]?.getBoundingClientRect();
      if (r && probeY < r.bottom) return i + 1;
    }
    return els.length;
  };
  const scrollTo = (top: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    suppress.current = true;
    sc.scrollTop = top;
    setTimeout(() => (suppress.current = false), 120); // outlast the resulting scroll event
  };
  const scrollToPage = (n: number) => {
    const els = getPageEls();
    if (!els.length) return;
    const t = els[Math.min(Math.max(n, 1), els.length) - 1];
    if (t) scrollTo(contentTop(t));
  };

  // Page tracking — rAF-throttled scroll → ?page=.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !ready) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!suppress.current) writePageToUrl(currentPage());
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => { sc.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Initial ?page= restore — runs each render until the target page's height stabilizes (it may
  // start as an estimated-height placeholder), then latches `restored`.
  useEffect(() => {
    if (restored.current || initialPage <= 1) { restored.current = true; return; }
    if (!ready) return;
    const els = getPageEls();
    const t = els[Math.min(initialPage, els.length) - 1];
    if (!t) return; // target not laid out yet — a later render retries
    const h = t.getBoundingClientRect().height;
    scrollToPage(initialPage);
    if (h > 0 && h === lastH.current) restored.current = true; // height settled → done
    lastH.current = h;
  });

  const captureAnchor = () => {
    const sc = scrollRef.current;
    const els = getPageEls();
    if (!sc || !els.length) { anchor.current = null; return; }
    const page = currentPage();
    const t = els[page - 1];
    const h = t?.getBoundingClientRect().height ?? 0;
    anchor.current = t ? { page, fraction: h ? (sc.scrollTop - contentTop(t)) / h : 0 } : null;
  };
  // Restore the anchored page+fraction, RE-APPLYING over a few frames until scrollTop stabilizes:
  // a zoom commit resizes far-page placeholders and renders newly-near pages asynchronously, which
  // shifts everything above the anchor — a single set would land a page or two off (or, when
  // shrinking hard, at the clamped bottom). Re-applying tracks the anchor page as layout settles.
  const restoreAnchor = () => {
    const a = anchor.current;
    if (!a) return;
    let tries = 0;
    let last = -1;
    suppress.current = true;
    const apply = () => {
      const sc = scrollRef.current;
      const t = getPageEls()[a.page - 1];
      if (!sc || !t) { suppress.current = false; return; }
      sc.scrollTop = contentTop(t) + a.fraction * t.getBoundingClientRect().height;
      if (Math.abs(sc.scrollTop - last) > 1 && tries++ < 8) {
        last = sc.scrollTop;
        requestAnimationFrame(apply);
      } else {
        setTimeout(() => (suppress.current = false), 120); // settled — release the page-writer
      }
    };
    apply();
  };

  return { captureAnchor, restoreAnchor, scrollToPage, initialPage };
}
