import { useEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, fetchAnnotations, saveAnnotation, deleteAnnotation } from "../api";

/**
 * The annotation layer, shared across materials (the UI guide). You SELECT to annotate — drag-
 * select text in prose or a PDF, drag a rectangle on an image or map — and a floating menu appears:
 *
 *   - a PALETTE of colors; the last-used color is pre-selected. Click a swatch to annotate in it.
 *   - a ✓ CONFIRM button — annotate in the pre-selected color (the explicit alternative to
 *     clicking outside, which also commits).
 *   - (text only) a ⧉ COPY button — copies the selected text, creates nothing.
 *   - a 🗑 DISCARD button — drops the pending mark.
 *
 * Clicking an EXISTING annotation reopens the menu in "edit" mode: a swatch RECOLORS it, 🗑 DELETES
 * it, clicking away just closes. A new/edited mark renders IMMEDIATELY (optimistically) — it does
 * not wait for the server round-trip (which reindexes). Annotations are graph-native — saved
 * server-side as yamlover objects, reverse-linked to the material — so they persist on reload.
 */

// Highlight palette (Catppuccin accents). The first is the historical default; the last-used color
// is remembered in localStorage and pre-selected, so a reader who picks green keeps getting green.
export const PALETTE = ["#f9e2af", "#a6e3a1", "#89dceb", "#cba6f7", "#f5c2e7", "#fab387"];
const COLOR_KEY = "yo-annotate-color";
export const DEFAULT_COLOR = PALETTE[0];

/** An annotation's saved color, or the default for legacy marks. */
export function colorOf(a: Annotation): string {
  return typeof a.selector?.color === "string" ? a.selector.color : DEFAULT_COLOR;
}

/** Whether an annotation can be edited/deleted here — only those CREATED through the UI (files
 *  under `<root>/annotations/`). Excludes the optimistic pending/preview placeholders and "frozen"
 *  example annotations authored in shared files (which the server can't delete). */
export function editable(a: Annotation): boolean {
  return typeof a.path === "string" && a.path.startsWith("/annotations/");
}

/** The remembered highlight color (persisted in localStorage) + a setter that persists it. */
export function useAnnotationColor(): [string, (c: string) => void] {
  const [color, set] = useState<string>(() => localStorage.getItem(COLOR_KEY) || DEFAULT_COLOR);
  const setColor = (c: string) => { localStorage.setItem(COLOR_KEY, c); set(c); };
  return [color, setColor];
}

/** Save a `selector` annotation of the material at `target`, in `color`; resolves when persisted. */
export function createAnnotation(target: string, selector: Record<string, unknown>, color: string): Promise<unknown> {
  return saveAnnotation({ target, selector: { ...selector, color } });
}

/** Read-only fetch of a material's annotations; `bump` (a changing number) forces a refetch. */
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

/** The actions every renderer needs over a material's annotations, with OPTIMISTIC rendering: a
 *  create/recolor shows at once and a delete hides at once, before the (slow, reindexing) server
 *  round-trip lands. */
export interface MaterialAnnotations {
  annotations: Annotation[];
  create: (selector: Record<string, unknown>, color: string) => void;
  remove: (annPath?: string) => void;
  recolor: (ann: Annotation, color: string) => void;
}

/** A material's annotations + optimistic create/delete/recolor. The displayed list merges the
 *  server's annotations with pending creations (shown until the refetch holds them) minus pending
 *  deletions (hidden until the refetch drops them) — so every change is reflected instantly. */
export function useMaterialAnnotations(path: string): MaterialAnnotations {
  const [bump, setBump] = useState(0);
  const fetched = useAnnotations(path, bump);
  const [optimistic, setOptimistic] = useState<Annotation[]>([]); // created, not yet in `fetched`
  const [deleted, setDeleted] = useState<Set<string>>(new Set());  // paths hidden, not yet dropped

  // Reconcile when the server list refreshes: drop optimistic creations it now holds, and keep a
  // path "deleted" only while the server still lists it (so a recolor's old copy can't flash back).
  useEffect(() => {
    const keys = new Set(fetched.map((a) => JSON.stringify(a.selector ?? {})));
    setOptimistic((o) => o.filter((a) => !keys.has(JSON.stringify(a.selector ?? {}))));
    const present = new Set(fetched.map((a) => a.path).filter(Boolean) as string[]);
    setDeleted((d) => new Set([...d].filter((p) => present.has(p))));
  }, [fetched]);

  const refresh = () => setBump((b) => b + 1);
  const create = (selector: Record<string, unknown>, color: string) => {
    const entry = { path: "(pending)", selector: { ...selector, color } } as Annotation;
    setOptimistic((o) => [...o, entry]);
    createAnnotation(path, selector, color)
      .then(refresh)
      .catch((e) => { setOptimistic((o) => o.filter((x) => x !== entry)); window.alert("save failed: " + (e as Error).message); }); // roll back the unsaved mark
  };
  const remove = (annPath?: string) => {
    if (!annPath || annPath === "(pending)") return;
    setDeleted((d) => new Set(d).add(annPath));
    deleteAnnotation(annPath)
      .then(refresh)
      .catch((e) => { setDeleted((d) => { const n = new Set(d); n.delete(annPath); return n; }); window.alert("delete failed: " + (e as Error).message); }); // un-hide on failure
  };
  const recolor = (ann: Annotation, color: string) => {
    const sel: Record<string, unknown> = { ...(ann.selector ?? {}) };
    delete sel.color;
    remove(ann.path); // hide + delete the old
    create(sel, color); // show + save the new color
  };

  const seen = new Set<string>();
  const annotations: Annotation[] = [];
  for (const a of [...optimistic, ...fetched]) {
    if (a.path && deleted.has(a.path)) continue;
    const k = JSON.stringify(a.selector ?? {});
    if (seen.has(k)) continue;
    seen.add(k);
    annotations.push(a);
  }
  return { annotations, create, remove, recolor };
}

/** The floating menu — a palette plus action buttons. Mode decides which buttons show (the hook
 *  wires what each does): `create` gets ✓ confirm + optional ⧉ copy + 🗑 discard; `edit` gets just
 *  🗑 delete (a swatch recolors). `position: fixed`, so x/y are viewport coords. */
export function AnnotationMenu({
  x, y, color, mode, onPick, onConfirm, onCopy, onTrash, menuRef,
}: {
  x: number; y: number; color: string; mode: "create" | "edit";
  onPick: (c: string) => void; onConfirm?: () => void; onCopy?: () => void; onTrash: () => void;
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
            title={mode === "edit" ? "recolor " + c : "highlight " + c}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      {onConfirm && <button type="button" className="annotate-tool ok" title="annotate (keep the mark)" onClick={onConfirm}>✓</button>}
      {onCopy && <button type="button" className="annotate-tool" title="copy text to clipboard (don't annotate)" onClick={onCopy}>⧉</button>}
      <button type="button" className="annotate-tool danger" title={mode === "edit" ? "delete this annotation" : "discard (don't annotate)"} onClick={onTrash}>🗑</button>
    </div>
  );
}

type MenuState =
  | { mode: "create"; selector: Record<string, unknown>; copy?: () => void; x: number; y: number }
  | { mode: "edit"; ann: Annotation; x: number; y: number };

/** Drives the floating menu for a material: `openCreate` after a fresh selection, `openEdit` on a
 *  click on an existing mark. Returns the rendered `palette`, and a `preview` selector (the pending
 *  CREATE, so a renderer can keep the rectangle drawn while the menu is open). Outside-click commits
 *  a create (in the pre-selected color) but only closes an edit. */
export function useAnnotationMenu(a: MaterialAnnotations): {
  openCreate: (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void) => void;
  openEdit: (ann: Annotation, screen: { x: number; y: number }) => void;
  palette: ReactNode;
  preview: { selector: Record<string, unknown>; color: string } | null;
  color: string;
} {
  const [color, setColor] = useAnnotationColor();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setMenu(null);

  const openCreate = (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void) =>
    setMenu({ mode: "create", selector, copy, x: screen.x, y: screen.y });
  const openEdit = (ann: Annotation, screen: { x: number; y: number }) =>
    setMenu({ mode: "edit", ann, x: screen.x, y: screen.y });

  const commitCreate = (c: string, m: MenuState) => { if (m.mode !== "create") return; setColor(c); a.create(m.selector, c); close(); };
  const commitRecolor = (c: string, m: MenuState) => { if (m.mode !== "edit") return; setColor(c); a.recolor(m.ann, c); close(); };

  // Outside-click: a create commits in the pre-selected color (default keeps the mark); an edit closes.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (menu.mode === "create") commitCreate(color, menu);
      else close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, color]);

  let palette: ReactNode = null;
  if (menu?.mode === "create") {
    palette = (
      <AnnotationMenu
        menuRef={menuRef} x={menu.x} y={menu.y} color={color} mode="create"
        onPick={(c) => commitCreate(c, menu)}
        onConfirm={() => commitCreate(color, menu)}
        onCopy={menu.copy ? () => { menu.copy!(); close(); } : undefined}
        onTrash={close}
      />
    );
  } else if (menu?.mode === "edit") {
    palette = (
      <AnnotationMenu
        menuRef={menuRef} x={menu.x} y={menu.y} color={colorOf(menu.ann)} mode="edit"
        onPick={(c) => commitRecolor(c, menu)}
        onTrash={() => { a.remove(menu.ann.path); close(); }}
      />
    );
  }
  const preview = menu?.mode === "create" ? { selector: menu.selector, color } : null;
  return { openCreate, openEdit, palette, preview, color };
}

export function AnnotatedMaterial({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const material = useMaterialAnnotations(path);
  const { openCreate, openEdit, palette } = useAnnotationMenu(material);
  const { annotations } = material;

  // Re-highlight after each render: the material (esp. a chapter's chunks) may settle a tick
  // after mount, so do it on a frame and clear any prior marks first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => highlight(el, annotations));
    return () => cancelAnimationFrame(raf);
  });

  // A finished text selection inside the material raises the CREATE menu by the selection.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if ((e.target as HTMLElement)?.closest?.(".annotate-menu")) return; // a menu click, not a selection
      if ((e.target as HTMLElement)?.closest?.("mark.yo-annotation")) return; // a mark click → handled by onClick
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      const cap = capture(sel);
      if (!cap) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const copy = () => navigator.clipboard?.writeText(cap.exact).catch(() => { /* clipboard blocked */ });
      openCreate({ type: "text", exact: cap.exact, prefix: cap.prefix, suffix: cap.suffix }, { x: rect.left, y: rect.bottom + 6 }, copy);
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking an existing highlight opens the EDIT menu for that annotation.
  const onClickMark = (e: React.MouseEvent) => {
    const mark = (e.target as HTMLElement).closest("mark.yo-annotation") as HTMLElement | null;
    if (!mark) return;
    const ann = annotations.find((x) => JSON.stringify(x.selector ?? {}) === mark.dataset.annSel);
    if (!ann || !editable(ann)) return;
    e.preventDefault();
    openEdit(ann, { x: e.clientX, y: e.clientY });
  };

  return (
    <div className="annotated">
      {annotations.length > 0 && (
        <div className="annotate-bar">
          <span className="annotate-count">{annotations.length} annotation{annotations.length > 1 ? "s" : ""}</span>
        </div>
      )}
      <div ref={ref} onClick={onClickMark}>{children}</div>
      {palette}
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
    wrapFirst(container, a.selector.exact, a);
  }
}

/** Wrap the first text occurrence of an annotation's `exact` (within one text node) in a colored,
 *  clickable `<mark>` carrying its selector key (so a click maps back to the annotation). */
function wrapFirst(container: HTMLElement, exact: string, a: Annotation): void {
  const c = colorOf(a);
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
    mark.dataset.annSel = JSON.stringify(a.selector ?? {});
    mark.title = a.body || "click to recolor or delete";
    try {
      range.surroundContents(mark); // works when the match is within one text node (v1)
      return;
    } catch {
      /* the snippet spans element boundaries — skip highlighting it for now */
    }
  }
}
