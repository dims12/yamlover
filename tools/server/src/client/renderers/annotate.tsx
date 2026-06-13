import { useEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, TagRef, createTag, fetchAnnotations, fetchNode, saveAnnotation, deleteAnnotation } from "../api";
import { TAG_FORMAT, explicitColor, resolveTagColor, tagFields } from "./tag";
import { canonPath, strToSegs } from "../paths";
import { touchesYamlover, useDiffBump } from "../live";

/**
 * The annotation layer, shared across materials (the UI guide). An annotation is ONE TAG
 * APPLICATION: a region of the material tagged by a tag, optionally commented. You SELECT to
 * annotate — drag-select text in prose or a PDF, drag a rectangle on an image or map — and a
 * floating tag picker appears:
 *
 *   - the PURE COLOR TAGS (built-in `yamlover/tags/colors/…`) as swatches; the last-used tag is
 *     pre-selected. Click a swatch to apply that tag.
 *   - the recently used NAMED tags as badges, plus a path input to apply ANY tag by its node
 *     path (a named tag's hue derives from its name; a color tag carries its color).
 *   - a ✓ CONFIRM button — apply the pre-selected tag (the explicit alternative to clicking
 *     outside, which also commits).
 *   - (text only) a ⧉ COPY button — copies the selected text, creates nothing.
 *   - a 🗑 DISCARD button — drops the pending mark.
 *
 * Clicking an EXISTING annotation reopens the picker in "edit" mode: picking a tag RE-TAGS it,
 * 🗑 DELETES it, clicking away just closes. A new/edited mark renders IMMEDIATELY
 * (optimistically) — it does not wait for the server round-trip (which reindexes). Annotations
 * are graph-native — saved server-side as yamlover objects, reverse-linked to the material and
 * members of their tag — so they persist on reload.
 */

// The built-in pure color tags (the palette). This constant is the OFFLINE fallback — the picker
// fetches the real `/yamlover/tags/colors` nodes once per session (useColorTags) so a project
// that re-themes them wins; the paths and hexes here mirror yamlover/tags/.yamlover/body.yamlover.
export const COLOR_TAGS: TagRef[] = [
  { path: "::yamlover:tags:colors:yellow", name: "yellow", color: "#f9e2af" },
  { path: "::yamlover:tags:colors:green", name: "green", color: "#a6e3a1" },
  { path: "::yamlover:tags:colors:sky", name: "sky", color: "#89dceb" },
  { path: "::yamlover:tags:colors:mauve", name: "mauve", color: "#cba6f7" },
  { path: "::yamlover:tags:colors:pink", name: "pink", color: "#f5c2e7" },
  { path: "::yamlover:tags:colors:peach", name: "peach", color: "#fab387" },
];
export const DEFAULT_TAG = COLOR_TAGS[0];
export const DEFAULT_COLOR = DEFAULT_TAG.color!;
const TAG_KEY = "yo-annotate-tag";
const RECENT_KEY = "yo-annotate-recent-tags";

/** An annotation's display color — its applied tag's (explicit color, else name-derived hue);
 *  the default for legacy marks saved before annotations carried a tag. */
export function colorOf(a: Annotation): string {
  return a.tag ? resolveTagColor(a.tag) : DEFAULT_COLOR;
}

/** An annotation's identity for optimistic reconcile/dedup: the same region tagged by two tags
 *  is TWO annotations, so the key is (selector, tag path) — not the selector alone. */
function annKey(a: Annotation): string {
  return JSON.stringify([a.selector ?? null, a.tag?.path ?? null]);
}

/** Whether an annotation can be edited/deleted here — any STANDALONE annotation file (its node
 *  path is the `.yamlover` file itself), wherever it lives in the tree: annotations are graph
 *  nodes, not residents of a fixed folder, so one moved to another directory stays editable.
 *  Excludes the optimistic `(pending)` placeholders and "frozen" annotations authored inline in
 *  shared documents (which the server can't delete without editing that document). */
export function editable(a: Annotation): boolean {
  return typeof a.path === "string" && a.path.endsWith(".yamlover");
}

// The color tags as indexed (fetched once per session; the constant covers offline/legacy roots).
let colorTagsPromise: Promise<TagRef[]> | null = null;
export function useColorTags(): TagRef[] {
  const [tags, setTags] = useState<TagRef[]>(COLOR_TAGS);
  useEffect(() => {
    colorTagsPromise ??= fetchNode("::yamlover:tags:colors", 2)
      .then((n) => {
        const out: TagRef[] = [];
        for (const [name, child] of tagFields(n.value)) {
          const color = explicitColor(child);
          // PROJECT-scope ref pinned to `::yamlover:tags:colors:<name>` — NOT derived from
          // `n.path` (the API echoes that in `:`-form, which would mismatch COLOR_TAGS and
          // resurrect the ghost badge); and `:` not `/` (the pre-SEPARATOR separator bug).
          if (color) out.push({ path: `::yamlover:tags:colors:${encodeURIComponent(name)}`, name, color });
        }
        return out.length ? out : COLOR_TAGS;
      })
      .catch(() => COLOR_TAGS);
    let cancelled = false;
    colorTagsPromise.then((t) => { if (!cancelled) setTags(t); });
    return () => { cancelled = true; };
  }, []);
  return tags;
}

/** The remembered last-applied tag (persisted in localStorage) + a setter that persists it and
 *  files a NAMED tag among the recents (color tags live in the swatch row already). */
export function useAnnotationTag(): [TagRef, (t: TagRef) => void] {
  const [tag, set] = useState<TagRef>(() => {
    try {
      const t = JSON.parse(localStorage.getItem(TAG_KEY) || "") as TagRef;
      if (t?.path && t?.name) return t;
    } catch { /* no/invalid stored tag */ }
    return DEFAULT_TAG;
  });
  const setTag = (t: TagRef) => {
    localStorage.setItem(TAG_KEY, JSON.stringify(t));
    rememberRecent(t);
    set(t);
  };
  return [tag, setTag];
}

/** The recently applied NAMED tags (newest first, capped). */
export function recentTags(): TagRef[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as TagRef[];
    if (Array.isArray(r)) return r.filter((t) => t?.path && t?.name);
  } catch { /* no/invalid recents */ }
  return [];
}

function rememberRecent(t: TagRef): void {
  if (canonPath(t.path).startsWith(":yamlover:tags:colors:")) return; // the swatch row already shows these
  const next = [t, ...recentTags().filter((r) => r.path !== t.path)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

/** Drop remembered tags whose node is GONE (or stopped being a tag): localStorage outlives the
 *  tags themselves, so a deleted tag would linger as a clickable badge forever. Each recent (and
 *  the remembered last-applied tag) is checked against the server; survivors are written back.
 *  Resolves to the live recents — the menu shows those. */
function pruneRememberedTags(): Promise<TagRef[]> {
  const isLive = (t: TagRef): Promise<boolean> =>
    fetchNode(t.path, 0).then((n) => n.format === TAG_FORMAT).catch(() => false);
  try {
    const t = JSON.parse(localStorage.getItem(TAG_KEY) || "") as TagRef;
    if (t?.path) void isLive(t).then((live) => { if (!live) localStorage.removeItem(TAG_KEY); });
  } catch { /* no/invalid stored tag */ }
  const recents = recentTags();
  return Promise.all(recents.map((t) => isLive(t).then((live) => (live ? t : null)))).then((kept) => {
    const live = kept.filter(Boolean) as TagRef[];
    if (live.length !== recents.length) localStorage.setItem(RECENT_KEY, JSON.stringify(live));
    return live;
  });
}

/** Apply `tag` to the material at `target`, narrowed to `selector` when given (null = the whole
 *  node); resolves when persisted. */
export function createAnnotation(target: string, selector: Record<string, unknown> | null, tag: TagRef): Promise<unknown> {
  return saveAnnotation({ target, tag: tag.path, ...(selector ? { selector } : {}) });
}

/** Read-only fetch of a material's annotations; `bump` (a changing number) forces a refetch.
 *  Also refetches whenever a diff (live.ts — the unified change flow) touches a `.yamlover`
 *  file: an annotation written/deleted ANYWHERE (this page's own save, another tab, a shell rm
 *  reconciled by the watcher) or an edited taxonomy must redraw the marks without a reload. */
export function useAnnotations(path: string, bump = 0): Annotation[] {
  const [anns, setAnns] = useState<Annotation[]>([]);
  const extBump = useDiffBump(touchesYamlover);
  useEffect(() => {
    let cancelled = false;
    fetchAnnotations(path)
      .then((a) => !cancelled && setAnns(a))
      .catch(() => !cancelled && setAnns([]));
    return () => { cancelled = true; };
  }, [path, bump, extBump]);
  return anns;
}

/** The actions every renderer needs over a material's annotations, with OPTIMISTIC rendering: a
 *  create/re-tag shows at once and a delete hides at once, before the (slow, reindexing) server
 *  round-trip lands. */
export interface MaterialAnnotations {
  annotations: Annotation[];
  create: (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean }) => void;
  remove: (annPath?: string) => void;
  retag: (ann: Annotation, tag: TagRef) => void;
}

/** A material's annotations + optimistic create/delete/re-tag. The displayed list merges the
 *  server's annotations with pending creations (shown until the refetch holds them) minus pending
 *  deletions (hidden until the refetch drops them) — so every change is reflected instantly. */
export function useMaterialAnnotations(path: string): MaterialAnnotations {
  const [bump, setBump] = useState(0);
  const fetched = useAnnotations(path, bump);
  const [optimistic, setOptimistic] = useState<Annotation[]>([]); // created, not yet in `fetched`
  const [deleted, setDeleted] = useState<Set<string>>(new Set());  // paths hidden, not yet dropped

  // Reconcile when the server list refreshes: drop optimistic creations it now holds, and keep a
  // path "deleted" only while the server still lists it (so a re-tag's old copy can't flash back).
  useEffect(() => {
    const keys = new Set(fetched.map(annKey));
    setOptimistic((o) => o.filter((a) => !keys.has(annKey(a))));
    const present = new Set(fetched.map((a) => a.path).filter(Boolean) as string[]);
    setDeleted((d) => new Set([...d].filter((p) => present.has(p))));
  }, [fetched]);

  const refresh = () => setBump((b) => b + 1);
  const create = (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean }) => {
    const entry = { path: "(pending)", selector: selector ?? undefined, tag } as Annotation;
    setOptimistic((o) => [...o, entry]);
    createAnnotation(path, selector, tag)
      .then(refresh)
      .catch((e) => {
        setOptimistic((o) => o.filter((x) => x !== entry)); // roll back the unsaved mark
        // An IMPLICIT save (clicking away with the pre-selected tag) is best-effort — e.g. the
        // default tag may not exist in this tree — so it rolls back QUIETLY. Only an explicit
        // pick (a swatch/badge/✓) reports the failure.
        if (!opts?.silent) window.alert("save failed: " + (e as Error).message);
      });
  };
  const remove = (annPath?: string) => {
    if (!annPath || annPath === "(pending)") return;
    setDeleted((d) => new Set(d).add(annPath));
    deleteAnnotation(annPath)
      .then(refresh)
      .catch((e) => { setDeleted((d) => { const n = new Set(d); n.delete(annPath); return n; }); window.alert("delete failed: " + (e as Error).message); }); // un-hide on failure
  };
  const retag = (ann: Annotation, tag: TagRef) => {
    remove(ann.path); // hide + delete the old application
    create(ann.selector ?? null, tag); // show + save the new one
  };

  const seen = new Set<string>();
  const annotations: Annotation[] = [];
  for (const a of [...optimistic, ...fetched]) {
    if (a.path && deleted.has(a.path)) continue;
    const k = annKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    annotations.push(a);
  }
  return { annotations, create, remove, retag };
}

/** A tag's display name from its node path (its last segment). */
function tagNameOf(path: string): string {
  const segs = strToSegs(path);
  return segs.length ? String(segs[segs.length - 1]) : path;
}

/** The floating tag picker — color-tag swatches, recent named-tag badges, a tag-path input, plus
 *  action buttons. Mode decides which buttons show (the hook wires what each does): `create` gets
 *  ✓ confirm + optional ⧉ copy + 🗑 discard; `edit` gets just 🗑 delete (picking a tag re-tags).
 *  `position: fixed`, so x/y are viewport coords. */
export function AnnotationMenu({
  x, y, tag, mode, onPick, onConfirm, onCopy, onTrash, menuRef,
}: {
  x: number; y: number; tag: TagRef; mode: "create" | "edit";
  onPick: (t: TagRef) => void; onConfirm?: () => void; onCopy?: () => void; onTrash: () => void;
  menuRef?: React.Ref<HTMLDivElement>;
}) {
  const colorTags = useColorTags();
  const [recents, setRecents] = useState(recentTags); // shown at once; pruned against the server
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false); // a lookup/create round-trip is in flight
  const verb = mode === "edit" ? "re-tag" : "tag";

  // A deleted tag must not survive as a badge: on open, drop remembered tags the server no
  // longer holds (the stored list is shown immediately; the pruned one replaces it quietly).
  useEffect(() => {
    let on = true;
    pruneRememberedTags().then((live) => { if (on) setRecents(live); });
    return () => { on = false; };
  }, []);

  // Compare tag paths on a CANONICAL key — a palette ref is project-scope (`::yamlover:…`)
  // while a selected/edited tag may arrive `:`-form (the API echoes paths in `:`-form, and
  // older localStorage holds `:`-form); raw `===` would miss the match and duplicate the tag.
  const same = (a: string, b: string) => canonPath(a) === canonPath(b);
  // The badge row must always include THE tag this menu is about (`sel`-framed, like the
  // selected color swatch) — which tag is assigned/pre-selected must be visible at a glance,
  // even when it has aged out of the recents. A PALETTE tag is shown as a swatch, not a badge.
  const badges = colorTags.some((c) => same(c.path, tag.path)) || recents.some((r) => same(r.path, tag.path))
    ? recents
    : [tag, ...recents];

  // Apply an arbitrary tag by its node path: fetch, verify it IS a tag, pick it. A bare NAME
  // (no `/`) that matches no node is CREATED at the project's tags location and then picked —
  // typing a fresh name is how a new named tag is born. A missed multi-segment path stays an
  // error: a typo'd path must not silently mint a tag named like a path.
  const pickPath = () => {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    fetchNode(p.startsWith(":") ? p : p.startsWith("/") ? ":" + p.slice(1).split("/").join(":") : ":" + p, 1)
      .then((n) => {
        if (n.format !== TAG_FORMAT) throw new Error("not a tag node");
        onPick({ path: n.path, name: n.title || tagNameOf(n.path), color: explicitColor(n.value) });
      })
      .catch((e) => {
        if (p.includes(":") || p.includes("/")) throw new Error(`cannot ${verb} with "${p}": ` + (e as Error).message);
        return createTag(p)
          .then(onPick)
          .catch((e2) => { throw new Error(`cannot create tag "${p}": ` + (e2 as Error).message); });
      })
      .catch((e) => window.alert((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <div ref={menuRef} className="annotate-menu" style={{ left: x, top: y }} role="menu">
      <div className="annotate-palette">
        {colorTags.map((t) => (
          <button
            key={t.path}
            type="button"
            className={"annotate-swatch" + (same(t.path, tag.path) ? " sel" : "")}
            style={{ background: resolveTagColor(t) }}
            title={`${verb} ${t.name}`}
            onClick={() => onPick(t)}
          />
        ))}
      </div>
      {onConfirm && <button type="button" className="annotate-tool ok" title={`${verb} ${tag.name} (keep the mark)`} onClick={onConfirm}>✓</button>}
      {onCopy && <button type="button" className="annotate-tool" title="copy text to clipboard (don't annotate)" onClick={onCopy}>⧉</button>}
      <button type="button" className="annotate-tool danger" title={mode === "edit" ? "delete this annotation" : "discard (don't annotate)"} onClick={onTrash}>🗑</button>
      {badges.length > 0 && (
        <div className="annotate-recents">
          {badges.map((t) => (
            // the frame is a WRAPPER: filter applies before clip-path on the same element, so a
            // ring drawn on the clipped .tagtag itself would be clipped away with it (styles.css)
            <span key={t.path} className={"tagframe" + (same(t.path, tag.path) ? " sel" : "")}>
              <button
                type="button"
                className="tagtag"
                style={{ background: resolveTagColor(t) }}
                title={`${verb} ${t.name}`}
                onClick={() => onPick(t)}
              >
                {t.name}
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="annotate-taginput"
        type="text"
        placeholder={busy ? "creating tag…" : `${verb}: tag path or new name… ⏎`}
        value={path}
        disabled={busy}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") pickPath(); }}
      />
    </div>
  );
}

type MenuState =
  | { mode: "create"; selector: Record<string, unknown>; copy?: () => void; x: number; y: number }
  | { mode: "edit"; ann: Annotation; x: number; y: number };

/** Drives the floating picker for a material: `openCreate` after a fresh selection, `openEdit` on
 *  a click on an existing mark. Returns the rendered `palette`, and a `preview` (the pending
 *  CREATE's selector + tag, so a renderer can keep the rectangle drawn while the picker is open).
 *  Outside-click commits a create (with the pre-selected tag) but only closes an edit. */
export function useAnnotationMenu(a: MaterialAnnotations): {
  openCreate: (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void) => void;
  openEdit: (ann: Annotation, screen: { x: number; y: number }) => void;
  palette: ReactNode;
  preview: { selector: Record<string, unknown>; tag: TagRef; color: string } | null;
  color: string;
} {
  const [tag, setTag] = useAnnotationTag();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setMenu(null);

  const openCreate = (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void) =>
    setMenu({ mode: "create", selector, copy, x: screen.x, y: screen.y });
  const openEdit = (ann: Annotation, screen: { x: number; y: number }) =>
    setMenu({ mode: "edit", ann, x: screen.x, y: screen.y });

  const commitCreate = (t: TagRef, m: MenuState, silent = false) => { if (m.mode !== "create") return; setTag(t); a.create(m.selector, t, { silent }); close(); };
  const commitRetag = (t: TagRef, m: MenuState) => { if (m.mode !== "edit") return; setTag(t); a.retag(m.ann, t); close(); };

  // Outside-click: a create commits with the pre-selected tag (default keeps the mark); an edit closes.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (menu.mode === "create") commitCreate(tag, menu, true); // implicit → best-effort, no error popup
      else close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, tag]);

  let palette: ReactNode = null;
  if (menu?.mode === "create") {
    palette = (
      <AnnotationMenu
        menuRef={menuRef} x={menu.x} y={menu.y} tag={tag} mode="create"
        onPick={(t) => commitCreate(t, menu)}
        onConfirm={() => commitCreate(tag, menu)}
        onCopy={menu.copy ? () => { menu.copy!(); close(); } : undefined}
        onTrash={close}
      />
    );
  } else if (menu?.mode === "edit") {
    palette = (
      <AnnotationMenu
        menuRef={menuRef} x={menu.x} y={menu.y} tag={menu.ann.tag ?? DEFAULT_TAG} mode="edit"
        onPick={(t) => commitRetag(t, menu)}
        onTrash={() => { a.remove(menu.ann.path); close(); }}
      />
    );
  }
  const preview = menu?.mode === "create" ? { selector: menu.selector, tag, color: resolveTagColor(tag) } : null;
  return { openCreate, openEdit, palette, preview, color: resolveTagColor(tag) };
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
    const ann = annotations.find((x) => annKey(x) === mark.dataset.annSel);
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
 *  clickable `<mark>` carrying its identity key (so a click maps back to the annotation). */
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
    mark.style.backgroundColor = `color-mix(in srgb, ${c} 30%, transparent)`; // works for hex AND a named tag's hsl()
    mark.style.borderBottomColor = c;
    mark.dataset.annSel = annKey(a);
    mark.title = a.description || "click to re-tag or delete";
    try {
      range.surroundContents(mark); // works when the match is within one text node (v1)
      return;
    } catch {
      /* the snippet spans element boundaries — skip highlighting it for now */
    }
  }
}
