import { ReactNode, useEffect, useRef, useState } from "react";
import { Annotation, TagRef, annotate, deleteAnnotation, fetchAnnotations } from "../api";
import { AnnotationMenu, rememberTag, type CreateEntry } from "./annotate";
import { canonPath, displayPath } from "../paths";
import { creatablesFor, useCreatableLabels } from "./create";

/** A target node's kind, enough to decide what can be created inside it. */
export type NodeKind = { format?: string | null; concrete?: string | null };

/**
 * A right-click node context menu. Reuses the floating picker ({@link AnnotationMenu}) for
 * whole-node tagging (`annotate()`/`deleteAnnotation()`), PLUS — when `opts.onCreate` is given and the
 * target `node` is known — object CREATION: a "＋ New <schema>" entry per creatable schema at that
 * target, each with a concrete selector (see create.ts). `openAt(target, x, y, node)`.
 */
export function useExplorerTagMenu(opts?: {
  /** When given, the menu offers object creation at the target: `(schema, parent, concrete)`. */
  onCreate?: (schema: string, parent: string, concrete: string) => void;
}): { openAt: (target: string, x: number, y: number, node?: NodeKind) => void; tagMenu: ReactNode } {
  const [menu, setMenu] = useState<{ target: string; x: number; y: number; node?: NodeKind } | null>(null);
  const [current, setCurrent] = useState<Annotation[]>([]);
  const labels = useCreatableLabels();
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
  const openAt = (target: string, x: number, y: number, node?: NodeKind) => {
    setMenu({ target, x, y, node });
    setCurrent([]);
    reload(target);
  };

  // Both toggles update the menu OPTIMISTICALLY (no wait on the write round-trip) and reconcile from
  // the server's echo when it returns; a failed write rolls the optimistic change back. The
  // underlying view refreshes independently through its own `useDiffBump` on the SSE diff.
  const add = (t: TagRef) => {
    if (!menu) return;
    rememberTag(t); // file it among the recents (no project-scoped "last tag" any more)
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

  // Outside-click closes (the menu's own buttons/inputs sit inside `ref`); so does scrolling the
  // page/content, since the menu is position:fixed and would otherwise float away from its anchor.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const onShift = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("wheel", onShift, true); // image/map/PDF viewers pan on wheel (no scroll event)
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("wheel", onShift, true);
    };
  }, [menu]);

  // the node's applied tags (resolved from its annotations) — the menu OUTLINES these and toggles
  const applied = current.map((a) => a.tag).filter((t): t is TagRef => !!t);
  // the object-creation entries for this target (a "＋ New <schema>" + concrete selector each)
  const creates: CreateEntry[] | undefined =
    menu?.node && opts?.onCreate
      ? creatablesFor(menu.node, labels).map((c) => ({
          schema: c.schema,
          label: c.label,
          concretes: c.concretes,
          defaultConcrete: c.defaultConcrete,
          onCreate: (concrete: string) => { opts.onCreate!(c.schema, menu.target, concrete); close(); },
        }))
      : undefined;
  const tagMenu = menu ? (
    <AnnotationMenu menuRef={ref} x={menu.x} y={menu.y} applied={applied} mode="create" onPick={add} onUnpick={remove} onClose={close} creates={creates} title={displayPath(menu.target)} />
  ) : null;
  return { openAt, tagMenu };
}
