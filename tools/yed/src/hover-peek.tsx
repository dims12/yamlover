// A hover "peek" for labels the layout clips: while the pointer rests on the element, a
// portal twin renders OVER it — same spot, same font, same background — extended past the
// clipping ancestor so the full text reads. The twin is `pointer-events: none`, so a native
// `title` tooltip on the real element still fires on its own (longer) browser delay.
//
// Shared by the server TOC rows (extend-right past the sidebar splitter) and both chapter
// faces' gutter crumbs (extend-left past the content pane's edge); it lives in yed because
// imports flow server → yed, never back.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Walk up to the first ancestor that can clip horizontal overflow. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowX !== "visible") return p;
  }
  return null;
}

/** The backdrop the element actually sits on — the first non-transparent ancestor background —
 *  so the twin masks what it covers exactly like the original masks its own ground. */
function effectiveBackground(el: HTMLElement): string {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const bg = getComputedStyle(p).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\s*\)$/.test(bg)) return bg;
  }
  return "var(--panel)";
}

export function useHoverPeek({ side, delayMs = 0, className, content, maxWidthPx }: {
  /** Which edge stays pinned to the original: `extend-right` pins the left edge (a TOC label
   *  growing across the splitter), `extend-left` pins the right edge (a right-anchored crumb). */
  side: "extend-right" | "extend-left";
  delayMs?: number;
  className: string;
  /** The full label — the SAME children the real element renders. */
  content: ReactNode;
  /** Width cap in px; text past it ellipsizes (the twin never runs unbounded). */
  maxWidthPx?: (anchor: DOMRect, clip: DOMRect) => number;
}): { hoverProps: { onMouseEnter: MouseEventHandler; onMouseLeave: () => void }; overlay: ReactNode } {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const timer = useRef<number | null>(null);

  const onMouseLeave = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    setStyle(null);
  }, []);
  useEffect(() => onMouseLeave, [onMouseLeave]); // unmount clears a pending timer

  const onMouseEnter: MouseEventHandler = useCallback((e) => {
    const el = e.currentTarget as HTMLElement;
    const clip = clippingAncestor(el);
    if (!clip) return;
    const show = (): void => {
      timer.current = null;
      const rect = el.getBoundingClientRect();
      const clipRect = clip.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // no layout (jsdom) — nothing to peek
      const clipped = side === "extend-right"
        ? rect.right > clipRect.right - 1
        : rect.left < clipRect.left + 1;
      if (!clipped) return; // fully visible labels never grow a twin
      const cs = getComputedStyle(el);
      const s: CSSProperties = {
        top: rect.top,
        height: rect.height,
        lineHeight: `${rect.height}px`,
        font: cs.font,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        background: effectiveBackground(el),
      };
      if (side === "extend-right") s.left = rect.left;
      else s.right = window.innerWidth - rect.right;
      if (maxWidthPx) s.maxWidth = Math.max(0, maxWidthPx(rect, clipRect));
      setStyle(s);
    };
    if (delayMs > 0) timer.current = window.setTimeout(show, delayMs);
    else show();
  }, [side, delayMs, maxWidthPx]);

  // any scroll/resize invalidates the snapshot position — drop the twin rather than track it
  useEffect(() => {
    if (!style) return;
    const hide = (): void => setStyle(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [style]);

  const overlay = style
    ? createPortal(<span className={className} style={style}>{content}</span>, document.body)
    : null;
  return { hoverProps: { onMouseEnter, onMouseLeave }, overlay };
}
