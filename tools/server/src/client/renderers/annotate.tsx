import { useEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, fetchAnnotations, saveAnnotation } from "../api";

/**
 * The annotation layer, shared across materials. The model is uniform everywhere (URIs.md / the
 * UI guide): you SELECT to annotate — drag-select text in prose, drag a rectangle on an image or
 * map — and a small floating palette appears by the selection:
 *
 *   - a PALETTE of highlight colors; the last-used color is pre-selected and remembered.
 *   - (text only) a COPY button — copies the selected text, creates nothing.
 *   - a CANCEL (✕) button — dismisses, creates nothing.
 *
 * The default is to KEEP the mark: clicking outside the menu commits in the pre-selected color;
 * only Copy or Cancel skip creation. Annotations are graph-native — saved server-side as yamlover
 * objects, reverse-linked to the material — so they persist across reload. This module owns the
 * shared palette (`AnnotationPalette`), the remembered color (`useAnnotationColor`), the save
 * helper (`createAnnotation`), and the TEXT wrapper (`AnnotatedMaterial`); the image/map/pdf
 * renderers import the palette + color + helper to offer the same flow over a dragged region.
 */

// Highlight palette (Catppuccin accents). The first is the historical default; the last-used color
// is remembered in localStorage and pre-selected, so a reader who picks green keeps getting green.
export const PALETTE = ["#f9e2af", "#a6e3a1", "#89dceb", "#cba6f7", "#f5c2e7", "#fab387"];
const COLOR_KEY = "yo-annotate-color";
export const DEFAULT_COLOR = PALETTE[0];

/** The remembered highlight color (persisted in localStorage) + a setter that persists it. The
 *  text wrapper and the region renderers share one remembered color, so picking green anywhere
 *  pre-selects green everywhere. */
export function useAnnotationColor(): [string, (c: string) => void] {
  const [color, set] = useState<string>(() => localStorage.getItem(COLOR_KEY) || DEFAULT_COLOR);
  const setColor = (c: string) => { localStorage.setItem(COLOR_KEY, c); set(c); };
  return [color, setColor];
}

/** Save a `selector` annotation of the material at `target`, in `color`; resolves when persisted. */
export function createAnnotation(target: string, selector: Record<string, unknown>, color: string): Promise<unknown> {
  return saveAnnotation({ target, selector: { ...selector, color } });
}

/** The floating color menu, anchored at viewport point (x, y). `onPick(color)` commits in that
 *  color; `onCancel` dismisses; `onCopy` (text only) is shown when provided. The `color` prop is
 *  the pre-selected swatch (ringed). It is `position: fixed`, so x/y are viewport coordinates. */
export function AnnotationPalette({
  x, y, color, onPick, onCancel, onCopy, menuRef,
}: {
  x: number; y: number; color: string;
  onPick: (c: string) => void; onCancel: () => void; onCopy?: () => void;
  menuRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={menuRef} className="annotate-menu" style={{ left: x, top: y }} role="menu">
      <div className="annotate-palette">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={"annotate-swatch" + (c === color ? " sel" : "")}
            style={{ background: c }}
            title={"highlight " + c}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      {onCopy && <button type="button" className="annotate-tool" title="copy text to clipboard (don't annotate)" onClick={onCopy}>⧉</button>}
      <button type="button" className="annotate-tool" title="cancel (don't annotate)" onClick={onCancel}>✕</button>
    </div>
  );
}

/** Drives the floating palette for a dragged REGION (image / map), mirroring the text flow. The
 *  renderer calls `open(selector, screen)` when a rectangle is dragged; the returned `palette` node
 *  shows the swatches at that point. Picking a swatch — OR clicking outside the menu — commits in
 *  that / the pre-selected color (the default is to keep the mark); ✕ cancels. `onSaved` runs after
 *  a successful save so the renderer can refetch and redraw. Returns the live `color` too (for the
 *  rubber-band). No Copy button — a region has no text to copy. */
export function useRegionAnnotator(
  path: string,
  onSaved: () => void,
): { open: (selector: Record<string, unknown>, screen: { x: number; y: number }) => void; palette: ReactNode; color: string } {
  const [color, setColor] = useAnnotationColor();
  const [pending, setPending] = useState<{ selector: Record<string, unknown>; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = () => setPending(null);
  const commit = (c: string) => {
    if (!pending) return;
    setColor(c);
    createAnnotation(path, pending.selector, c).then(onSaved).catch((e) => window.alert("save failed: " + (e as Error).message));
    close();
  };

  // Click outside the open menu → commit in the pre-selected color (default is to keep the mark).
  useEffect(() => {
    if (!pending) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      commit(color);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, color]);

  const open = (selector: Record<string, unknown>, screen: { x: number; y: number }) =>
    setPending({ selector, x: screen.x, y: screen.y });
  const palette = pending ? (
    <AnnotationPalette menuRef={menuRef} x={pending.x} y={pending.y} color={color} onPick={commit} onCancel={close} />
  ) : null;
  return { open, palette, color };
}

/** Read-only fetch of a material's annotations; `bump` (a changing number) forces a refetch.
 *  The text wrapper, the image overlay, and the pdf overlay all source annotations through this. */
export function useAnnotations(path: string, bump = 0): Annotation[] {
  const [anns, setAnns] = useState<Annotation[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAnnotations(path)
      .then((a) => !cancelled && setAnns(a))
      .catch(() => !cancelled && setAnns([]));
    return () => { cancelled = true; };
  }, [path, bump]);
  return anns;
}

/** A captured text selection (resolved to a quote selector) plus where to float the menu. */
interface PendingMark {
  exact: string;
  prefix: string;
  suffix: string;
  x: number; // viewport coords (the menu is position:fixed)
  y: number;
}

export function AnnotatedMaterial({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [bump, setBump] = useState(0);
  const [pending, setPending] = useState<PendingMark | null>(null);
  const [color, setColor] = useAnnotationColor();
  const anns = useAnnotations(path, bump);

  // Re-highlight after each render: the material (esp. a chapter's chunks) may settle a tick
  // after mount, so do it on a frame and clear any prior marks first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => highlight(el, anns));
    return () => cancelAnimationFrame(raf);
  });

  // Selecting text inside the material raises the menu by the selection. We listen on `mouseup`
  // (the selection is final by then); a mouseup landing inside the open menu is ignored so its
  // own buttons fire normally.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (menuRef.current?.contains(e.target as Node)) return; // a click within the menu, not a new selection
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      const cap = capture(sel);
      if (!cap) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPending({ ...cap, x: rect.left, y: rect.bottom + 6 });
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  const close = () => {
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /** Persist the pending mark in `c` and remember `c` as the new default color. */
  const commit = (c: string) => {
    if (!pending) return;
    setColor(c);
    createAnnotation(path, { type: "text", exact: pending.exact, prefix: pending.prefix, suffix: pending.suffix }, c)
      .then(() => setBump((b) => b + 1))
      .catch((e) => window.alert("save failed: " + (e as Error).message));
    close();
  };

  const onCopy = () => {
    if (pending) navigator.clipboard?.writeText(pending.exact).catch(() => { /* clipboard blocked — no-op */ });
    close();
  };

  // While the menu is open, a mousedown OUTSIDE it commits the mark in the pre-selected color —
  // the default is to keep the highlight. (A mousedown inside the menu is a button press; its own
  // onClick handles it.) Re-subscribed on [pending, color] so it commits the current pending/color.
  useEffect(() => {
    if (!pending) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      commit(color);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, color]);

  return (
    <div className="annotated">
      {anns.length > 0 && (
        <div className="annotate-bar">
          <span className="annotate-count">{anns.length} annotation{anns.length > 1 ? "s" : ""}</span>
        </div>
      )}
      <div ref={ref}>{children}</div>
      {pending && (
        <AnnotationPalette
          menuRef={menuRef} x={pending.x} y={pending.y} color={color}
          onPick={commit} onCopy={onCopy} onCancel={close}
        />
      )}
    </div>
  );
}

/** Resolve the current selection to a quote selector ({exact, prefix, suffix}), or null if empty. */
function capture(sel: Selection): { exact: string; prefix: string; suffix: string } | null {
  const exact = sel.toString().trim();
  if (!exact) return null;
  const full = sel.anchorNode?.nodeValue ?? "";
  const at = full.indexOf(exact);
  const prefix = at >= 0 ? full.slice(Math.max(0, at - 24), at) : "";
  const suffix = at >= 0 ? full.slice(at + exact.length, at + exact.length + 24) : "";
  return { exact, prefix, suffix };
}

/** (Re)apply highlight marks for the text annotations in `container`. */
function highlight(container: HTMLElement, anns: Annotation[]): void {
  container.querySelectorAll("mark.yo-annotation").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  for (const a of anns) {
    if (a.selector?.type !== "text" || !a.selector.exact) continue;
    wrapFirst(container, a.selector.exact, a.body, typeof a.selector.color === "string" ? a.selector.color : undefined);
  }
}

/** Wrap the first text occurrence of `exact` (within a single text node) in a colored `<mark>`. */
function wrapFirst(container: HTMLElement, exact: string, body?: string, color?: string): void {
  const c = color || DEFAULT_COLOR;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const i = (n.nodeValue ?? "").indexOf(exact);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, i + exact.length);
    const mark = document.createElement("mark");
    mark.className = "yo-annotation";
    mark.style.backgroundColor = c + "4d"; // ~30% alpha (#rrggbb → #rrggbbAA)
    mark.style.borderBottomColor = c;
    if (body) mark.title = body;
    try {
      range.surroundContents(mark); // works when the match is within one text node (v1)
      return;
    } catch {
      /* the snippet spans element boundaries — skip highlighting it for now */
    }
  }
}
