import { ReactNode, useEffect, useRef, useState } from "react";
import { Annotation, TagRef, annotate, deleteAnnotation, fetchAnnotations } from "../api";
import { AnnotationMenu, useAnnotationTag } from "./annotate";
import { canonPath } from "../paths";

/**
 * A right-click tag MANAGER for the directory views (grid / details / board). Reuses the same
 * floating picker as region tagging ({@link AnnotationMenu}), upgraded for whole-node tagging:
 * `openAt(target, x, y)` loads the node's CURRENT tags (shown as a removable row) and offers the
 * palette / recents / typeahead to ADD one. Picking adds a tag; a current chip's ✕ removes it —
 * both via the shared `annotate()` / `deleteAnnotation()` write paths, with the menu's tag list
 * refreshed in place. The underlying view also refreshes through its own `useDiffBump`.
 */
export function useExplorerTagMenu(): { openAt: (target: string, x: number, y: number) => void; tagMenu: ReactNode } {
  const [, setTag] = useAnnotationTag();
  const [menu, setMenu] = useState<{ target: string; x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<Annotation[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { setMenu(null); setCurrent([]); };

  // The whole-node tag menu shows only WHOLE-NODE tags: a FRAGMENT annotation (a tagged region,
  // `fragmentSlug` set) belongs to the fragment, not the node — an image with a tagged region is
  // not itself tagged — so it never counts here.
  const reload = (target: string) =>
    fetchAnnotations(target).then((anns) => setCurrent(anns.filter((a) => !a.fragmentSlug))).catch(() => setCurrent([]));
  // Open the picker on the node's CURRENT whole-node tags; the user picks one to ADD. Unlike REGION
  // tagging (which auto-applies the last tag to save a click once a selection is drawn), a right-click
  // on a whole node must NEVER silently tag it just for opening the menu.
  const openAt = (target: string, x: number, y: number) => {
    setMenu({ target, x, y });
    setCurrent([]);
    reload(target);
  };

  // Both toggles update the menu OPTIMISTICALLY (no wait on the write round-trip) and reconcile from
  // the server's echo when it returns; a failed write rolls the optimistic change back. The
  // underlying view refreshes independently through its own `useDiffBump` on the SSE diff.
  const add = (t: TagRef) => {
    if (!menu) return;
    setTag(t);
    const optimistic: Annotation = { path: "(pending)", tag: t };
    setCurrent((cur) => [...cur, optimistic]);
    annotate({ target: menu.target, tag: t.path })
      .then(() => reload(menu.target))
      .catch((e) => {
        setCurrent((cur) => cur.filter((a) => a !== optimistic));
        window.alert("tag failed: " + (e as Error).message);
      });
  };
  const remove = (t: TagRef) => {
    if (!menu) return;
    // Delete by the REAL applied tag's path (the server's echo, `:yamlover:…` doc form) rather than
    // the clicked ref (a palette swatch is `::yamlover:…` link form) — so a color tag unapplies too.
    const applied = current.find((a) => a.tag && canonPath(a.tag.path) === canonPath(t.path));
    setCurrent((cur) => cur.filter((a) => a !== applied));
    deleteAnnotation(menu.target, applied?.tag?.path ?? t.path)
      .then(() => reload(menu.target))
      .catch((e) => {
        if (applied) setCurrent((cur) => [...cur, applied]);
        window.alert("untag failed: " + (e as Error).message);
      });
  };

  // Outside-click closes (the menu's own buttons/inputs sit inside `ref`).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  // the node's applied tags (resolved from its annotations) — the menu OUTLINES these and toggles
  const applied = current.map((a) => a.tag).filter((t): t is TagRef => !!t);
  const tagMenu = menu ? (
    <AnnotationMenu menuRef={ref} x={menu.x} y={menu.y} applied={applied} mode="create" onPick={add} onUnpick={remove} onClose={close} />
  ) : null;
  return { openAt, tagMenu };
}
