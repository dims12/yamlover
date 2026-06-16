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
  const [tag, setTag] = useAnnotationTag();
  const [menu, setMenu] = useState<{ target: string; x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<Annotation[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { setMenu(null); setCurrent([]); };

  const reload = (target: string) => fetchAnnotations(target).then(setCurrent).catch(() => setCurrent([]));
  // Open the picker, and if the node has NO tags yet, immediately apply the last-used tag — it
  // opens visibly checked (click it to remove). A node that already has tags is left untouched.
  const openAt = (target: string, x: number, y: number) => {
    setMenu({ target, x, y });
    setCurrent([]);
    fetchAnnotations(target)
      .then((anns) => {
        if (anns.length === 0) annotate({ target, tag: tag.path }).then(() => reload(target)).catch(() => setCurrent([]));
        else setCurrent(anns);
      })
      .catch(() => setCurrent([]));
  };

  const add = (t: TagRef) => {
    if (!menu) return;
    setTag(t);
    annotate({ target: menu.target, tag: t.path }).then(() => reload(menu.target)).catch((e) => window.alert("tag failed: " + (e as Error).message));
  };
  const remove = (t: TagRef) => {
    if (!menu) return;
    // Delete by the REAL applied tag's path (the server's echo, `:yamlover:…` doc form) rather than
    // the clicked ref (a palette swatch is `::yamlover:…` link form) — so a color tag unapplies too.
    const applied = current.find((a) => a.tag && canonPath(a.tag.path) === canonPath(t.path));
    deleteAnnotation(menu.target, applied?.tag?.path ?? t.path).then(() => reload(menu.target)).catch((e) => window.alert("untag failed: " + (e as Error).message));
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
