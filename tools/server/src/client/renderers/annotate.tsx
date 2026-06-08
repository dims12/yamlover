import { useEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, fetchAnnotations, saveAnnotation } from "../api";

/**
 * Wraps a rendered TEXT material: highlights its existing annotations (each `selector.exact`
 * snippet → a `<mark>`) and lets the reader mark a new text selection and save it. Annotations
 * are graph-native — saved server-side as yamlover objects, reverse-linked to the material — so
 * a save persists and re-appears on reload. (Image/map/pdf region selectors are a follow-up;
 * this is the text end-to-end slice.)
 */
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

export function AnnotatedMaterial({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bump, setBump] = useState(0);
  const anns = useAnnotations(path, bump);

  // Re-highlight after each render: the material (esp. a chapter's chunks) may settle a tick
  // after mount, so do it on a frame and clear any prior marks first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => highlight(el, anns));
    return () => cancelAnimationFrame(raf);
  });

  const onAnnotate = () => {
    const sel = window.getSelection();
    const el = ref.current;
    if (!sel || sel.isCollapsed || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) {
      window.alert("Select some text in the material first, then annotate.");
      return;
    }
    const exact = sel.toString().trim();
    if (!exact) return;
    const full = sel.anchorNode.nodeValue ?? "";
    const at = full.indexOf(exact);
    const prefix = at >= 0 ? full.slice(Math.max(0, at - 24), at) : "";
    const suffix = at >= 0 ? full.slice(at + exact.length, at + exact.length + 24) : "";
    const body = window.prompt("Note (optional):", "") ?? "";
    saveAnnotation({ target: path, selector: { type: "text", exact, prefix, suffix }, body })
      .then(() => setBump((b) => b + 1))
      .catch((e) => window.alert("save failed: " + (e as Error).message));
  };

  return (
    <div className="annotated">
      <div className="annotate-bar">
        <button className="annotate-btn" onClick={onAnnotate} title="select text in the material, then click to annotate it">
          ✎ annotate selection
        </button>
        {anns.length > 0 && <span className="annotate-count">{anns.length} annotation{anns.length > 1 ? "s" : ""}</span>}
      </div>
      <div ref={ref}>{children}</div>
    </div>
  );
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
    const exact = a.selector?.type === "text" ? a.selector.exact : undefined;
    if (exact) wrapFirst(container, exact, a.body);
  }
}

/** Wrap the first text occurrence of `exact` (within a single text node) in a `<mark>`. */
function wrapFirst(container: HTMLElement, exact: string, body?: string): void {
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
    if (body) mark.title = body;
    try {
      range.surroundContents(mark); // works when the match is within one text node (v1)
      return;
    } catch {
      /* the snippet spans element boundaries — skip highlighting it for now */
    }
  }
}
