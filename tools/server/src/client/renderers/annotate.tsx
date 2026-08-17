import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, TagRef, createOnto, fetchAnnotations, fetchNode, createFragment, annotate, deleteAnnotation, rekeyNode } from "../api";
import { explicitColor, isColorTagPath, resolveTagColor, tagFields, tagStyle } from "./tag";
import { tagRefOf } from "./tag-resolve";
import { TagTip } from "./tagtip";
import { canonPath, displayPath, fragmentAnchorId, strToSegs } from "../paths";
import { touchesYamlover, useDiffBump } from "../live";
import { QueryCells, useQueryCellHost } from "../query-cells";
import { splitQueryPortions, treeCandidateProvider } from "../query-complete";
import { TocFilterHandle, useTocFilter } from "../toc-filter-session";
import { indexToRefs, invalidateOntos, projectOntos, tagNameOf } from "../ontos";
import { forgetRecent, recordRecent, useRecents, useRecentsPane } from "../recents";
import { READ_ONLY } from "../base";

/**
 * The annotation layer, shared across materials (the UI guide). An annotation is ONE TAG
 * APPLICATION: a region of the material tagged by a tag, optionally commented. You SELECT to
 * annotate — drag-select text in prose or a PDF, drag a rectangle on an image or map — and a
 * floating tag picker appears. A NEW selection preselects NOTHING: no tag is applied and no swatch
 * or chip is outlined until you pick one; the just-drawn region shows in a NEUTRAL color meanwhile.
 * Only the tags a target ALREADY carries are shown (outlined). The picker offers:
 *
 *   - the PURE COLOR TAGS (built-in `yamlover/ontos/colors/…`) as swatches. Click one to apply it.
 *   - the NAMED tags as chips, shown without typing from four sources (most-relevant first): the
 *     tags APPLIED to this target, the tags borne by OTHER components of the same node, the
 *     recently-used tags, and the project taxonomy (the grafted yamlover tags + the configured
 *     tags location). Typing in the path input turns the chip row into a ranked filter over EVERY
 *     tag in the tree (so anything is reachable), and a fresh name creates a tag.
 *   - (text only) a ⧉ COPY button — copies the selected text, creates nothing.
 *
 * Picking a tag IS the apply — it toggles the tag on the region and the menu stays open (multi-tag);
 * clicking an applied tag removes it; closing (✕ / outside-click) commits nothing extra. Clicking an
 * EXISTING annotation reopens the picker in "edit" mode over that mark's tags. A new/edited mark
 * renders IMMEDIATELY (optimistically) — it does not wait for the server round-trip (which
 * reindexes). Annotations are graph-native — saved server-side as yamlover objects, reverse-linked
 * to the material and members of their tag — so they persist on reload.
 */

// The built-in pure color tags (the palette). This constant is the OFFLINE fallback — the picker
// fetches the real `/yamlover/ontos/colors` nodes once per session (useColorOntos) so a project
// that re-themes them wins; the paths and hexes here mirror yamlover/ontos/.yo/body.yo.
export const COLOR_ONTOS: TagRef[] = [
  { path: "::yamlover:ontos:colors:yellow", name: "yellow", color: "#f9e2af" },
  { path: "::yamlover:ontos:colors:green", name: "green", color: "#a6e3a1" },
  { path: "::yamlover:ontos:colors:sky", name: "sky", color: "#89dceb" },
  { path: "::yamlover:ontos:colors:mauve", name: "mauve", color: "#cba6f7" },
  { path: "::yamlover:ontos:colors:pink", name: "pink", color: "#f5c2e7" },
  { path: "::yamlover:ontos:colors:peach", name: "peach", color: "#fab387" },
];
export const DEFAULT_ONTO = COLOR_ONTOS[0];
export const DEFAULT_COLOR = DEFAULT_ONTO.color!;
// The NEUTRAL color a freshly-drawn region / in-progress selection is painted in, before any tag is
// picked — "no tag chosen yet". A new selection preselects nothing, so it is deliberately NOT a tag
// color (a muted gray, not the palette's yellow default).
export const SELECTION_COLOR = "#9399b2";

/** An annotation's display color — its applied tag's (explicit color, else name-derived hue);
 *  the default for legacy marks saved before annotations carried a tag. */
export function colorOf(a: Annotation): string {
  return a.tag ? resolveTagColor(a.tag) : DEFAULT_COLOR;
}

/** An annotation's identity for optimistic reconcile/dedup: the same region tagged by two tags
 *  is TWO annotations, so the key is (selector, tag path) — not the selector alone. The tag path is
 *  CANONICALIZED so an optimistic entry written with a palette ref (`::yamlover:…` link scope)
 *  reconciles against the server's echo (`:yamlover:…` doc scope) instead of lingering as a ghost
 *  `(pending)` duplicate — which would otherwise shadow the real one and block its removal. */
function annKey(a: Annotation): string {
  return JSON.stringify([a.selector ?? null, a.tag?.path ? canonPath(a.tag.path) : null]);
}

/** Two annotations mark the SAME region when their selectors are equal — the join key used to
 *  gather a region's tag applications. Selectors are built field-by-field in a fixed key order by
 *  every renderer, so structural JSON equality is stable (the same basis as {@link annKey}). */
function sameSelector(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Whether an annotation can be edited/deleted here — any STANDALONE annotation file (its node
 *  path is the `.yo` file itself), wherever it lives in the tree: annotations are graph
 *  nodes, not residents of a fixed folder, so one moved to another directory stays editable.
 *  Every embedded annotation (one with a resolved tag) is editable — re-tag/delete just edits its
 *  host body. Transient markers (a `(preview)`/`(pending)` placeholder) are not. */
export function editable(a: Annotation): boolean {
  return !!a.tag && a.path !== "(preview)" && a.path !== "(pending)";
}

// The color tags as indexed (fetched once per session; the constant covers offline/legacy roots).
let colorTagsPromise: Promise<TagRef[]> | null = null;

/** Load the palette, preferring the project's REAL `::ontos:colors` over the self-import graft.
 *  In a yamlover PROJECT the self-import is de-materialized (graft-virtualize), so `::ontos:colors`
 *  is the live palette and `::yamlover:ontos:colors` no longer exists as a node; in a plain/FOREIGN
 *  served root only the built-in graft `::yamlover:ontos:colors` exists. Pin each emitted ref to the
 *  base that resolved, so the written pointer matches the tag PAGE path (`:ontos:colors:<name>` in a
 *  project) and reconciles against the server echo instead of leaving a ghost badge. */
async function loadColorOntos(): Promise<TagRef[]> {
  for (const base of ["::ontos:colors", "::yamlover:ontos:colors"]) {
    try {
      const n = await fetchNode(base, 2);
      const out: TagRef[] = [];
      for (const [name, child] of tagFields(n.value)) {
        const color = explicitColor(child);
        if (color) out.push({ path: `${base}:${encodeURIComponent(name)}`, name, color });
      }
      if (out.length) return out;
    } catch {
      // node absent at this base — try the next
    }
  }
  return COLOR_ONTOS;
}

export function useColorOntos(): TagRef[] {
  const [tags, setTags] = useState<TagRef[]>(COLOR_ONTOS);
  useEffect(() => {
    colorTagsPromise ??= loadColorOntos();
    let cancelled = false;
    colorTagsPromise.then((t) => { if (!cancelled) setTags(t); });
    return () => { cancelled = true; };
  }, []);
  return tags;
}

// The onto VOCABULARY and the "which tags are offered without typing" rule live in the shared
// policy module (ontos.ts) — the yamlover editor's `&` bag suggests the SAME vocabulary, and a
// rule spelled twice is a rule that drifts.
export { indexToRefs };

/** The project's SUGGESTABLE named tags, re-enumerated when a `.yo` source changes (so a
 *  freshly created tag appears at once). Feeds the picker's chips. */
export function useOntoIndex(): TagRef[] {
  const [tags, setTags] = useState<TagRef[]>([]);
  const bump = useDiffBump(touchesYamlover);
  useEffect(() => {
    let cancelled = false;
    invalidateOntos(); // a diff may have BORN a tag — re-ask
    projectOntos()
      .then((t) => { if (!cancelled) setTags(t); })
      .catch(() => { if (!cancelled) setTags([]); });
    return () => { cancelled = true; };
  }, [bump]);
  return tags;
}

/** File a just-applied tag among the PER-PROJECT recents (recents.ts — the same `bookmarks`
 *  bag the yamlover editor's `&` entry reads; a tag application IS a membership bookmark).
 *  Color tags live in the swatch row already and are refused by the bag itself. */
export function rememberTag(t: TagRef): void {
  recordRecent("bookmarks", t);
}

/** Apply `tag` to the material at `target`. With a `selector`, first create a FRAGMENT (the
 *  region, plus an optional PNG crop, under the optional USER-CHOSEN `slug`) and tag THAT;
 *  without one, tag the whole node. */
export async function createAnnotation(
  target: string,
  selector: Record<string, unknown> | null,
  tag: TagRef,
  imageBase64?: string,
  slug?: string,
): Promise<unknown> {
  if (!selector) return annotate({ target, tag: tag.path });
  const { fragmentPath } = await createFragment(target, selector, imageBase64, slug);
  return annotate({ target: fragmentPath, tag: tag.path });
}

/** The host node path that carries a tag application: the node the annotation lives ON (`ann.node`
 *  — a CHUNK for a chunk fragment, else the material), and — when it marks a region — that node's
 *  fragment path (`…:yo:fragments:<slug>`). */
function annotationTarget(materialPath: string, ann: Annotation): string {
  const host = ann.node ?? materialPath;
  if (!ann.fragmentSlug) return host;
  return (host === ":" ? "" : host) + ":yo:fragments:" + ann.fragmentSlug;
}

/** Read-only fetch of a material's annotations; `bump` (a changing number) forces a refetch.
 *  Also refetches whenever a diff (live.ts — the unified change flow) touches a `.yo`
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
  create: (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string; target?: string; slug?: string }) => void;
  remove: (ann: Annotation) => void;
  /** Add `tag` to the REGION identified by `selector`: the FIRST tag creates the fragment (with the
   *  optional crop, under the optional USER-CHOSEN `slug` — the picker's key field), later tags
   *  annotate that same fragment — never a second one, even if clicked before the first create's
   *  server round-trip lands (those queue and drain on the next fetch). `target` is the node the
   *  fragment hangs off — the enclosing CHUNK for a chapter selection, else the material
   *  (default). `silent` suppresses the failure alert. */
  annotateRegion: (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean; target?: string; slug?: string }) => void;
}

/** A material's annotations + optimistic create/delete/re-tag. The displayed list merges the
 *  server's annotations with pending creations (shown until the refetch holds them) minus pending
 *  deletions (hidden until the refetch drops them) — so every change is reflected instantly. */
export function useMaterialAnnotations(path: string): MaterialAnnotations {
  const [bump, setBump] = useState(0);
  const fetched = useAnnotations(path, bump);
  const [optimistic, setOptimistic] = useState<Annotation[]>([]); // created, not yet in `fetched`
  const [deleted, setDeleted] = useState<Set<string>>(new Set());  // annKeys hidden, not yet dropped
  // annKeys the user removed WHILE their create was still in flight: we can't delete an annotation
  // the server has not stored yet, so we hide it now and fire the real delete once it lands (below).
  // Without this, deselecting the auto-applied default tag right after selecting a region was a
  // silent no-op — the in-flight create then resurrected the tag on the next refetch.
  const [pendingDel, setPendingDel] = useState<Set<string>>(new Set());

  // Reconcile when the server list refreshes: drop optimistic creations it now holds, and keep an
  // annotation "deleted" only while the server still lists it (so a re-tag's old copy can't flash
  // back). Identity is annKey (selector + tag) — annotations carry no node path of their own.
  useEffect(() => {
    const keys = new Set(fetched.map(annKey));
    setOptimistic((o) => o.filter((a) => !keys.has(annKey(a))));
    setDeleted((d) => new Set([...d].filter((k) => keys.has(k))));
  }, [fetched]);

  const refresh = () => setBump((b) => b + 1);
  const deleteReal = (ann: Annotation, key: string) =>
    deleteAnnotation(annotationTarget(path, ann), ann.tag!.path, ann.inline ? ann.selector : undefined)
      .then(refresh)
      .catch((e) => { setDeleted((d) => { const n = new Set(d); n.delete(key); return n; }); window.alert("delete failed: " + (e as Error).message); }); // un-hide on failure

  // Drain deferred deletes: once a removed-while-pending annotation actually lands in `fetched` (its
  // create finished), it has a real fragment/target, so fire the delete now and move it to `deleted`
  // (hidden until the refetch drops it). Matched by annKey (selector + tag).
  useEffect(() => {
    if (!pendingDel.size) return;
    for (const a of fetched) {
      const k = annKey(a);
      if (!a.tag || !pendingDel.has(k)) continue;
      setPendingDel((p) => { const n = new Set(p); n.delete(k); return n; });
      setDeleted((d) => new Set(d).add(k));
      void deleteReal(a, k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, pendingDel]);

  const rollback = (entry: Annotation, e: unknown, silent?: boolean) => {
    setOptimistic((o) => o.filter((x) => x !== entry));
    if (!silent) window.alert("save failed: " + (e as Error).message);
  };
  const create = (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string; target?: string; slug?: string }) => {
    const target = opts?.target ?? path; // the node the fragment hangs off (a chunk, else the material)
    const entry = { path: "(pending)", node: target, selector: selector ?? undefined, tag } as Annotation;
    setOptimistic((o) => [...o, entry]);
    createAnnotation(target, selector, tag, opts?.imageBase64, opts?.slug).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
  };
  const remove = (ann: Annotation) => {
    if (!ann?.tag) return;
    const key = annKey(ann);
    // Removed before its create landed: hide it now, delete it when it appears in `fetched`.
    if (ann.path === "(pending)") { setPendingDel((p) => new Set(p).add(key)); return; }
    setDeleted((d) => new Set(d).add(key));
    void deleteReal(ann, key);
  };
  // Picks queued during the FIRST create's round-trip (the fragment path isn't known yet) — each
  // carries its optimistic entry, already shown so the badge outlines at once; drained below.
  const pendingPicksRef = useRef<{ selector: Record<string, unknown>; tag: TagRef; entry: Annotation }[]>([]);

  // The fragment node path for a region, from a REAL (non-pending) fetched annotation of it — null
  // until the first create's round-trip lands (so later picks know to annotate vs. queue).
  const regionFragmentTarget = (selector: Record<string, unknown>): string | null => {
    const real = fetched.find((x) => x.fragmentSlug && x.path !== "(pending)" && sameSelector(x.selector, selector));
    return real ? annotationTarget(path, real) : null;
  };

  const annotateRegion = (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean; target?: string; slug?: string }) => {
    const node = opts?.target ?? path; // the region's host node (a chunk, else the material)
    if (selector.type === "text" && !opts?.slug) {
      // the INLINE token spelling: one call per pick — the server wraps the words on the first
      // and appends further memberships to the same token's label (docs/documents/marklower/grammar).
      // A NAMED region (`opts.slug`) skips this: an inline token has no key, so naming it is
      // choosing the explicit `yo: fragments:` member spelling — it falls through to create().
      const entry = { path: "(pending)", node, selector, tag } as Annotation;
      setOptimistic((o) => [...o, entry]);
      annotate({ target: node, tag: tag.path, selector }).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
      return;
    }
    const target = regionFragmentTarget(selector);
    if (target) { // the fragment already exists → just annotate it (a later tag)
      const entry = { path: "(pending)", node, selector, tag } as Annotation;
      setOptimistic((o) => [...o, entry]);
      annotate({ target, tag: tag.path }).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
      return;
    }
    if (optimistic.some((x) => sameSelector(x.selector, selector))) { // first create in flight → queue
      const entry = { path: "(pending)", node, selector, tag } as Annotation;
      setOptimistic((o) => [...o, entry]);
      pendingPicksRef.current.push({ selector, tag, entry });
      return;
    }
    create(selector, tag, opts); // the FIRST tag → create the fragment (+ optional crop)
  };

  // Once the fragment's real path lands, flush any picks queued during the create window — onto the
  // SAME fragment, so a fast second click never spawns a duplicate fragment.
  useEffect(() => {
    if (!pendingPicksRef.current.length) return;
    const still: typeof pendingPicksRef.current = [];
    for (const q of pendingPicksRef.current) {
      const target = regionFragmentTarget(q.selector);
      if (target) annotate({ target, tag: q.tag.path }).then(refresh).catch((e) => rollback(q.entry, e));
      else still.push(q);
    }
    pendingPicksRef.current = still;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched]);

  const seen = new Set<string>();
  const annotations: Annotation[] = [];
  for (const a of [...optimistic, ...fetched]) {
    const k = annKey(a);
    if (deleted.has(k) || pendingDel.has(k) || seen.has(k)) continue;
    seen.add(k);
    annotations.push(a);
  }
  return { annotations, create, remove, annotateRegion };
}

/** Whether an event landed inside the LEFT (TOC) pane — the popup's close-on-outside-click
 *  must not fire for TOC interactions while the popup drives the TOC filter session. */
export function withinTocPane(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  return !!el?.closest?.(".pane.left");
}

/** Whether an event landed inside the query cells' PORTALED candidate dropdown (`.crumb-dd`,
 *  parked on document.body — OUTSIDE the popup's own DOM): a click or scroll there is part of
 *  the popup's editing session, so the close-on-outside-click must not fire — otherwise picking
 *  a candidate by mouse would close the whole popup before the pick lands (Tab worked, clicks
 *  cancelled). */
export function withinQueryDropdown(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  return !!el?.closest?.(".crumb-dd");
}


/** The floating tag picker — ONE uniform toggle UI. It shows the color-tag swatches and a row of
 *  named-tag chips (the four default sources — see the file header — filtered live as you type); the
 *  tags currently APPLIED to the target are OUTLINED (a color tag outlines its swatch, a named tag
 *  its chip — never both, never a duplicate). Clicking an un-applied option ADDS it (`onPick`);
 *  clicking an applied one REMOVES it (`onUnpick` when given, else it re-picks — the region
 *  edit/create behaviour). Typing filters the chips and a fresh name creates a tag. `position: fixed`,
 *  so x/y are viewport coords.
 *
 *  `applied` is the tags in effect on the target — a region's pre-selected / assigned tag (a single
 *  element), or a node's whole set. `nodeTags` (optional) is the tags borne by OTHER components of
 *  the same node (sibling fragments), surfaced as default chips. Region tagging (`useAnnotationMenu`)
 *  and explorer right-click tagging (`useExplorerTagMenu`) drive this SAME component the same way;
 *  the outline is the only "selected" indicator. */
/** One "＋ New <label>" entry in the menu: a create button plus a concrete selector (default = the
 *  last / richest). `schema` is the entry's identity key; `onCreate` gets the picked concrete id. */
export interface CreateEntry {
  schema: string;
  label: string;
  concretes: { id: string; label: string }[];
  defaultConcrete: string;
  onCreate: (concrete: string) => void;
}

/** A create entry: the `＋ New <label>` button + a `<select>` of concretes (when there's a choice).
 *  The picked concrete is REMEMBERED per schema (localStorage) — creating three file chapters in a
 *  row should not mean re-selecting "file" three times. */
function CreateRow({ schema, label, concretes, defaultConcrete, onCreate }: CreateEntry) {
  const memoryKey = "yamlover-create-concrete:" + schema;
  const [concrete, setConcrete] = useState(() => {
    const last = localStorage.getItem(memoryKey);
    return last !== null && concretes.some((o) => o.id === last) ? last : defaultConcrete;
  });
  const pick = (id: string) => {
    setConcrete(id);
    localStorage.setItem(memoryKey, id);
  };
  return (
    <div className={"annotate-create" + (concretes.length > 1 ? " split" : "")}>
      <button type="button" className="annotate-action" onClick={() => onCreate(concrete)}>＋ New {label}</button>
      {concretes.length > 1 && (
        <select className="annotate-concrete" value={concrete} onChange={(e) => pick(e.target.value)} title="storage form">
          {concretes.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

export function AnnotationMenu({
  x, y, applied, nodeTags = [], mode, onPick, onUnpick, onCopy, onClose, menuRef, creates, title, targetPath, keyText, onRenameKey,
}: {
  x: number; y: number; applied: TagRef[]; nodeTags?: TagRef[]; mode: "create" | "edit";
  onPick: (t: TagRef) => void; onUnpick?: (t: TagRef) => void;
  onCopy?: () => void; onClose: () => void;
  menuRef?: React.Ref<HTMLDivElement>;
  /** Object-creation entries shown at the top (e.g. "＋ New chapter" with a concrete selector). */
  creates?: CreateEntry[];
  /** The path/label of the object the menu was opened for — the header row's tooltip. */
  title?: string;
  /** The node the menu tags (canonical client path). A TOC/query pick of this very node CLOSES the
   *  menu instead of tagging — clicking the node again reads as "dismiss", and a node never tags
   *  itself. */
  targetPath?: string;
  /** The target's KEY, shown in the header row (the popup reads as the yamlover spelling it
   *  writes: `key:` above, `& <path>` below). A fragment's slug, a node's key — or "" for a
   *  fresh region whose fragment is not born yet (typing a name there CHOOSES its key). */
  keyText?: string;
  /** Commit a key rename (Enter/blur in the key field). Absent ⇒ the key is read-only. */
  onRenameKey?: (name: string) => void;
}) {
  const colorTags = useColorOntos();
  const tagIndex = useOntoIndex(); // named tags (whole tree) — the scoped ones show as default chips
  // the PER-PROJECT recents bag (recents.ts): shown at once, 404-pruned quietly on open,
  // and closeable — the pane preference is remembered per surface
  const recents = useRecents("bookmarks", { prune: true });
  const [paneOpen, setPaneOpen] = useRecentsPane("picker");
  const [busy, setBusy] = useState(false); // a lookup/create round-trip is in flight
  // THE KEY FIELD's draft — committed to the host on Enter/blur (a rename, or a fresh
  // region's chosen name); an outside change (the host echoing a landed rename) resyncs it
  const [keyDraft, setKeyDraft] = useState(keyText ?? "");
  const keyJustFocused = useRef(false); // the click that focused it must not collapse the select-all
  useEffect(() => { setKeyDraft(keyText ?? ""); }, [keyText]);
  const commitKey = (): void => {
    if (onRenameKey === undefined) return;
    const name = keyDraft.trim();
    if (name === (keyText ?? "").trim()) return;
    onRenameKey(name); // "" reaches the host too — a fresh region's name cleared back to auto
  };
  const verb = mode === "edit" ? "re-tag" : "tag";
  const session = useTocFilter(); // the shared TOC filter — typing here filters the TOC too

  // Compare tag paths on a CANONICAL key — a palette ref is project-scope (`::yamlover:…`)
  // while an applied/edited tag may arrive `:`-form (the API echoes paths in `:`-form, and
  // older localStorage holds `:`-form); raw `===` would miss the match and duplicate the tag.
  const same = (a: string, b: string) => canonPath(a) === canonPath(b);
  const isColor = (t: TagRef) => colorTags.some((c) => same(c.path, t.path));
  const appliedKeys = new Set(applied.map((t) => canonPath(t.path)));
  const isApplied = (p: string) => appliedKeys.has(canonPath(p));

  // Clicking a swatch/chip toggles: an APPLIED tag turns OFF (`onUnpick`, else re-picks), an
  // un-applied one turns ON (`onPick`). The outline (not a separate chip) shows what is applied.
  const toggle = (t: TagRef) => (isApplied(t.path) ? onUnpick ?? onPick : onPick)(t);

  // EVERY picked PATH funnels here — the search row's Enter commit AND a TOC row click while the
  // popup owns the filter session — under ONE rule set: the popup's own TARGET dismisses
  // (clicking the node again = close; a node never tags itself), the ROOT is silently IGNORED
  // (it has no project-scope pointer spelling, so it can never be a tag — and a modal alert for
  // a stray click would out-annoy the mistake). The `how` is the one per-surface difference:
  // a TOC row click TOGGLES (an applied tag turns off, as its chip would — the row reads like a
  // checkbox), while Enter ASSIGNS the typed path — an already-applied tag is a satisfied no-op,
  // never a surprise un-tag.
  const pickPath = (p: string, how: "toggle" | "assign"): void => {
    if (targetPath !== undefined && same(p, targetPath)) return onClose();
    if (canonPath(p) === ":") return;
    tagRefOf(p)
      .then((t) => {
        if (how === "assign" && isApplied(t.path)) return; // already assigned — Enter is satisfied
        (how === "assign" ? onPick : toggle)(t);
      })
      .catch((e) => window.alert(`cannot ${verb} with "${p}": ` + (e as Error).message));
  };
  const pickPathRef = useRef(pickPath);
  pickPathRef.current = pickPath;

  // The SEARCH input is the shared query-cell editor (breadcrumb machinery, PICK mode), opening
  // at the PROJECT scope with a recursive-descent seed — typing a bare name spells
  // `:: ...: name`, the "find a node by name anywhere IN THE PROJECT" query. The project rung
  // is what makes the grafted yamlover taxonomy (the built-in palette included) searchable —
  // `:` would be the document only (docs/language/pointers/scopes). The cells stay fully editable.
  // `commitOnMiss` gates a no-match Enter: only a create-on-miss-ELIGIBLE bare name commits —
  // any other miss keeps the machine editing with the red ring, the typed query still visible.
  const host = useQueryCellHost({
    ctx: () => ({ mode: "pick", ladder: 2, idlePortions: () => [...SEED_CELLS], commitOnMiss: (q) => creatableNameOf(q) !== null }),
    provider: useRef(treeCandidateProvider(":")).current,
    onSelect: (p, meta) => {
      if (meta && /^:*$/.test(meta.query.trim())) return; // empty cells: nothing to apply
      if (p !== null) {
        pickPathRef.current(p, "assign"); // Enter assigns the typed path — never toggles it off
        return;
      }
      if (!meta) return;
      // CREATE-ON-MISS: a bare NAME (alone, or after the seeded `...`) that matches nothing is
      // born as a named tag at the project's tags location. A missed multi-portion query never
      // reaches here — `commitOnMiss` kept the machine editing (ringed) instead of committing —
      // so a typo'd path can neither mint a tag named like a path nor pop a modal error.
      const name = creatableNameOf(meta.query);
      if (name === null) return;
      setBusy(true);
      createOnto(name)
        .then(onPick)
        .catch((e) => window.alert(`cannot create tag "${name}": ` + (e as Error).message))
        .finally(() => setBusy(false));
    },
    session: null, // the menu drives the session itself — a TOC click TOGGLES the tag (pickPath)
  });

  // The popup OWNS the TOC filter session while open: the host's filter results mirror into it,
  // and a TOC row click routes through pickPath — toggling that node as the tag (the popup stays
  // open, multi-tag), or CLOSING when the clicked row is the popup's own target.
  const sessionHandle = useRef<TocFilterHandle | null>(null);
  useEffect(() => {
    if (!session || sessionHandle.current) return;
    sessionHandle.current = session.begin({
      onPick: (p) => pickPathRef.current(p, "toggle"),
      onEvicted: () => {
        sessionHandle.current = null; // another editor took the TOC — the popup keeps its dropdown
      },
    });
    // session's identity churns with App renders — begin once per mount (guarded above)
  }, [session]);
  useEffect(
    () => () => {
      sessionHandle.current?.end();
      sessionHandle.current = null;
    },
    [],
  );
  // Mirror the filter into the TOC only once the user typed PAST the seed — the bare seed
  // (`: ...`) matches everything, and swapping the TOC to a 500-match pruned tree on a mere
  // focus would be noise, not filtering.
  const hostState = host.state;
  const searching =
    hostState.mode === "editing" &&
    hostState.portions.some((p, i) => {
      const live = i === hostState.active ? hostState.activeText : p;
      return live.trim() !== "" && !(i === 0 && live.trim() === "...");
    });
  useEffect(() => {
    sessionHandle.current?.set(searching && host.filterTree ? { root: host.filterTree, truncated: host.truncated } : null);
  }, [searching, host.filterTree, host.truncated]);

  // The popup opens READY TO TYPE: the caret lands in the trailing cell at once.
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    hostRef.current.dispatch({ type: "FOCUS_CELL", index: SEED_CELLS.length - 1, caret: "end" });
  }, []);

  // THE POPUP IS NEVER A DEAD SURFACE (the editor-never-locks law, applied here): whenever the
  // cells fall idle while the popup stands — a blur to NOWHERE, a stray async focus grab, the
  // window drag's mousedown — the caret comes back to the trailing cell, so typing always
  // lands. Only a focus that went to `<body>` is reclaimed: focus the user MOVED somewhere
  // real (a chip, the TOC, another pane) is theirs.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (host.state.mode !== "idle") return;
    const id = requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== null) return;
      hostRef.current.dispatch({ type: "FOCUS_CELL", index: SEED_CELLS.length - 1, caret: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [host.state.mode]);

  // ESCAPE CLOSES THE POPUP — the ladder, taken in CAPTURE so it is decided here and the cells
  // never strand the caret on a plain `ESCAPE` (their handler stops propagation, and leaving
  // the editor would drop focus to `<body>` with the window still up): with the candidate
  // dropdown open the cells own the key (it closes the dropdown only, the edit survives);
  // otherwise the popup closes, from every host — the TOC menu, a region in prose, a PDF or
  // map selection alike. AND: Enter with NOTHING TYPED is "done" — after tagging through the
  // TOC (or the chips) the entry stands empty, and Enter there used to be a dead key (the
  // reported "I can't press Enter afterwards"); an empty query names nothing to apply, so
  // the only meaning left is to confirm and close.
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inKeyField = !!(e.target as Element | null)?.closest?.(".annotate-key");
      const st = hostRef.current.state;
      if (e.key === "Escape") {
        if (inKeyField) return; // the key field reverts/closes itself
        if (st.mode === "editing" && st.dropdown?.open) return; // the cells close their dropdown first
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Enter") {
        // only the ENTRY's own Enter — a button, a select, the key field keep theirs
        if (!(e.target as Element | null)?.closest?.(".annotate-cells")) return;
        if (searchingRef.current) return; // a typed query — the cells' Enter applies it
        // an open dropdown defers Enter only when a row is ARMED (hi >= 0): the unarmed list
        // over an EMPTY cell is "every child", and Enter there used to commit the empty
        // query — a dead key
        if (st.mode === "editing" && st.dropdown?.open && st.dropdown.hi >= 0) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current(); // nothing typed — Enter confirms what is applied and closes
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // A tag chip shows its NAME only; its full path (its spine location) and text value are revealed
  // on HOVER via the coloured <TagTip> card — so same-named tags stay distinguishable without
  // cluttering the label.

  // Collapse a list to one chip per display NAME (first wins → priority order is preserved); color
  // tags belong to the swatch row, never a named chip.
  const dedupeNamed = (list: TagRef[]): TagRef[] => {
    const out: TagRef[] = [];
    const byName = new Set<string>();
    for (const t of list) {
      if (isColor(t)) continue;
      const n = t.name.toLowerCase();
      if (byName.has(n)) continue;
      byName.add(n);
      out.push(t);
    }
    return out;
  };

  // TWO ROWS, two meanings. (a) THE APPLIED row — the tags in effect on this target plus the
  // ones borne by other components of the same node: current STATE, and the outlined chip is
  // the untag affordance, so it is always shown (a collapsed bag must never hide the way to
  // remove a tag). (b) THE RECENTS PANE — the suggestion bag: the per-project recently-used
  // tags then the project taxonomy (the grafted yamlover tags plus the configured location).
  // Anything else in the tree is reachable through the query cells above.
  const scopedIndex = tagIndex; // already scoped to the graft roots + the configured location (ontos.ts)
  const appliedRow = dedupeNamed([...applied, ...nodeTags]);
  const shownNames = new Set(appliedRow.map((t) => t.name.toLowerCase()));
  const bagRow = dedupeNamed([...recents, ...scopedIndex]).filter((t) => !shownNames.has(t.name.toLowerCase()));
  // a recents chip can be FORGOTTEN in place (right-click) — a suggestion list must be
  // correctable; the taxonomy chips are not remembered entries, so they have nothing to forget
  const recentPaths = new Set(recents.map((t) => canonPath(t.path)));
  const forget = (t: TagRef) => { if (recentPaths.has(canonPath(t.path))) forgetRecent("bookmarks", t.path); };

  /** One chip row (applied state / the suggestion bag) — the same face, one meaning apart. */
  const chips = (list: TagRef[], cls: string) => (
    <div className={cls} role="listbox">
      {list.map((t) => (
        <span key={t.path} className="tagframe">
          <TagTip tag={t}>
            <button
              type="button"
              role="option"
              aria-selected={isApplied(t.path)}
              className={"tagtag" + (isApplied(t.path) ? " on" : "")}
              style={tagStyle(resolveTagColor(t))}
              onClick={() => toggle(t)}
              onContextMenu={recentPaths.has(canonPath(t.path)) ? (e) => { e.preventDefault(); forget(t); } : undefined}
              title={recentPaths.has(canonPath(t.path)) ? "right-click to forget this suggestion" : undefined}
            >
              <span className="tt-label">{t.name}</span>
            </button>
          </TagTip>
        </span>
      ))}
    </div>
  );

  // Keep the fixed-position menu fully on-screen: it opens at the selection (x = left, y = the
  // selection's BOTTOM), but near the right/bottom edge that clips it — the tag input then sits
  // off-screen and is unreachable. Measure after layout and clamp into the viewport, flipping ABOVE
  // the selection when there isn't room below. Re-runs each render (the body grows/shrinks as the
  // suggestion list filters), guarded so a stable position doesn't loop.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    if (typeof menuRef === "function") menuRef(el);
    else if (menuRef) (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [menuRef]);
  const [pos, setPos] = useState({ left: x, top: y });
  // Once the user DRAGS the window by its title bar, its position is theirs — stop auto-clamping.
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (moved.current) return;
    const el = boxRef.current;
    if (!el) return;
    const m = 8; // viewport margin
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = x, top = y;
    if (left + w > window.innerWidth - m) left = Math.max(m, window.innerWidth - w - m);
    if (top + h > window.innerHeight - m) {
      const above = y - h - 12; // flip to open upward from the selection
      top = above >= m ? above : Math.max(m, window.innerHeight - h - m);
    }
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  });

  // Drag the window by its header row (a click on its tools or INTO the key input is not a drag).
  const onTitleDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return; // a tool / the key field, not a drag
    e.preventDefault();
    const dx = e.clientX - pos.left;
    const dy = e.clientY - pos.top;
    moved.current = true;
    const onMove = (ev: MouseEvent) => setPos({ left: ev.clientX - dx, top: ev.clientY - dy });
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={setRefs} className="annotate-menu" style={{ left: pos.left, top: pos.top }} role="menu">
      {/* THE HEADER — the popup reads as the yamlover spelling it writes:
              key:
                & <path>
          Row one: the target's KEY (editable when the host wires a rename; typing a name for
          a FRESH region chooses its fragment key), an uneditable `:`, then the ⏎ apply, ⧉
          copy and ✕ close tools docked right. The row is the drag handle (grab anywhere that
          is not the key input or a button); the target's full path rides as its tooltip. */}
      <div className="annotate-topbar" onMouseDown={onTitleDown} title={title}>
        <input
          className="annotate-key"
          value={keyDraft}
          placeholder="name…"
          readOnly={onRenameKey === undefined}
          style={{ width: `${Math.max(3, keyDraft.length || 5) + 0.5}ch` }}
          onChange={(e) => setKeyDraft(e.target.value)}
          // clicking the key PRESELECTS the whole name — renaming is the common intent, and
          // typing then replaces it outright. (The mouseup guard keeps the click that gave
          // focus from collapsing that selection to a caret; a later click inside places the
          // caret normally.)
          onFocus={(e) => { keyJustFocused.current = true; e.currentTarget.select(); }}
          onMouseUp={(e) => { if (keyJustFocused.current) { e.preventDefault(); keyJustFocused.current = false; } }}
          onBlur={() => { keyJustFocused.current = false; commitKey(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitKey(); }
            if (e.key === "Escape") {
              // its own ladder (the capture listener defers to this field): a DIRTY draft
              // reverts first; a clean one closes the window like everywhere else
              e.preventDefault();
              e.stopPropagation();
              if (keyDraft !== (keyText ?? "")) setKeyDraft(keyText ?? "");
              else onClose();
            }
          }}
        />
        <span className="annotate-colon">:</span>
        <span className="annotate-topgap" />
        {/* COPY comes first, and stays out of the ✓/✕ pair. Those two are this window's commit
            and dismiss — they belong side by side, and a third button wedged between them reads
            as a third member of the pair. Copy is a different kind of act entirely: it writes
            nothing and leaves the popup alone. Ctrl/Cmd+C does the same thing (see useCopyKey). */}
        {onCopy && <button type="button" className="annotate-tool copy" title="copy text to clipboard, Ctrl+C (don't annotate)" onClick={onCopy}>⧉</button>}
        <button
          type="button" className="annotate-tool ok" title="apply the typed path (Enter)"
          onMouseDown={(e) => e.preventDefault() /* never blur the cells before the commit */}
          onClick={() => host.dispatch({ type: "ENTER" })}
        >✓</button>
        <button type="button" className="annotate-tool close" title="close (Escape)" onClick={onClose}>✕</button>
      </div>
      {/* the ENTRY row — indented under the key like the source line it writes: an uneditable
          `&` sigil, then the shared query cells (breadcrumb machinery, pick mode, PROJECT
          scope) — the dropdown offers real nodes as TOC rows, the TOC filters live, Enter
          assigns the typed path or creates a fresh named tag, a TOC click toggles that node
          directly (the popup's own target closes instead — see pickPath). Backspace at the
          first cell's start steps the ladder down. */}
      <div className="annotate-entry">
        <span className="annotate-amp">&</span>
        <div className="annotate-typeahead" title={`${verb}: type a name (creates on miss), a path, or any query ⏎`}>
          {busy ? (
            <span className="annotate-busy">creating tag…</span>
          ) : (
            <QueryCells host={host} idlePortions={[...SEED_CELLS]} leadingSep idleLadder={2} scopeKeys placeholder="tag name…" className="annotate-cells" />
          )}
        </div>
      </div>
      {/* the APPLIED row — what this target carries right now (an outlined chip untags it);
          always shown, never inside the collapsible pane */}
      {appliedRow.length > 0 && chips(appliedRow, "annotate-applied")}
      {/* the BAG of recent entries, right under the path entry — a CLOSEABLE pane (the ✕
          collapses it to its header, remembered per surface, so it can never be lost) */}
      {bagRow.length > 0 && (
        <div className="annotate-bag">
          <div className="annotate-bag-head">
            <button
              type="button"
              className="annotate-bag-toggle"
              title={paneOpen ? "hide the recent suggestions" : "show the recent suggestions"}
              onClick={() => setPaneOpen(!paneOpen)}
            >
              {paneOpen ? "▾" : "▸"} recent
            </button>
            {paneOpen && (
              <button type="button" className="annotate-bag-close" title="hide the recent suggestions" onClick={() => setPaneOpen(false)}>✕</button>
            )}
          </div>
          {paneOpen && chips(bagRow, "annotate-recents")}
        </div>
      )}
      <div className="annotate-palette">
        {colorTags.map((t) => (
          <TagTip key={t.path} tag={t}>
            <button
              type="button"
              className={"annotate-swatch" + (isApplied(t.path) ? " on" : "")}
              style={tagStyle(resolveTagColor(t))}
              onClick={() => toggle(t)}
            />
          </TagTip>
        ))}
      </div>
      {creates && creates.length > 0 && (
        <div className="annotate-actions">
          {creates.map((c) => <CreateRow key={c.schema} {...c} />)}
        </div>
      )}
    </div>
  );
}

// The query cells' seed: a recursive descent + the empty typing cell — a bare name typed into
// the popup spells `:: ...: <name>` (find-by-name anywhere in the PROJECT, the grafted
// taxonomy included); every cell stays editable.
const SEED_CELLS = ["...", ""];

/** Strip the query-cell quoting from a typed portion (`'дорожный знак'` → the raw name). */
function unquotePortion(p: string): string {
  if (/^'.*'$/.test(p)) return p.slice(1, -1).replace(/''/g, "'");
  return p;
}

/** The bare NAME a query spells when it is create-on-miss ELIGIBLE — a name alone, or after the
 *  seeded `...` — else null. A multi-portion path or an operator-bearing portion is never
 *  creatable: a typo'd path must not silently mint a tag named like a path. The ONE predicate
 *  behind both the machine's `commitOnMiss` gate and the host's create-on-miss commit. */
function creatableNameOf(query: string): string | null {
  const parts = splitQueryPortions(query);
  const name = unquotePortion(parts[parts.length - 1] ?? "");
  const bare =
    name !== "" && !/[:[\]?*!<>=]/.test(name) && (parts.length === 1 || (parts.length === 2 && parts[0] === "..."));
  return bare ? name : null;
}

/** An open region picker — keyed by its SELECTOR (the join into the material's annotations), not by
 *  a one-shot create/edit. `create` marks a freshly-DRAWN region (vs editing an existing one): only
 *  then does the neutral preview keep the marquee up before the first tag — editing an existing
 *  region down to zero tags must let it disappear (untag). */
type OpenRegion = {
  selector: Record<string, unknown>; nodePath: string; create: boolean; copy?: () => void;
  imageBase64?: string; x: number; y: number; title: string;
  /** The header's KEY: an existing fragment's slug, or the CHOSEN name of a fresh region
   *  (used as the fragment key at first tag; "" = auto/inline). */
  keyText: string;
  /** The existing fragment's node path — set only in EDIT mode over a member fragment;
   *  renaming rekeys it in place. A fresh region and an inline-token mark have none. */
  fragPath?: string;
};

/** Drives the floating picker for a material's REGIONS: `openCreate` after a fresh selection,
 *  `openEdit` on a click on an existing mark — both open the SAME selector-keyed picker, so tagging
 *  is uniform: clicking a tag toggles it on/off the region and the menu STAYS open (multi-tag),
 *  closing only via the close button or outside-click. The first tag on a fresh region creates its
 *  fragment; later tags annotate that same one. Returns the `palette`, plus a `preview` (the region's
 *  selector + a NEUTRAL color) so a renderer keeps the rectangle drawn UNTIL a real tag draws it. */
export function useAnnotationMenu(a: MaterialAnnotations, path: string): {
  openCreate: (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void, imageBase64?: string, nodePath?: string) => void;
  openEdit: (ann: Annotation, screen: { x: number; y: number }) => void;
  palette: ReactNode;
  preview: { selector: Record<string, unknown>; color: string; node?: string } | null;
  color: string;
} {
  const [open, setOpen] = useState<OpenRegion | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);

  // Ctrl/Cmd+C copies the captured text while the popup stands.
  //
  // It has to be wired by hand. Opening the popup plants the caret in its query cells, which
  // takes the browser's ONE selection with it (that is why the neutral preview mark exists at
  // all) — so by the time the key is pressed there is nothing selected for the native copy to
  // act on, and the ⧉ button was the ONLY way to get the text out. Two deliberate stand-asides:
  // a field the user is actually editing keeps its own copy, and a live selection that somehow
  // survived is the browser's to handle.
  const copyFn = open?.copy;
  useEffect(() => {
    if (!copyFn) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "c" && e.key !== "C") || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.selectionStart !== el.selectionEnd) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      e.preventDefault();
      copyFn();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [copyFn]);

  // Selecting a region OPENS the picker but applies NOTHING — a new selection preselects no tag, so
  // nothing is outlined until the user picks one. The just-drawn region stays visible via the neutral
  // `preview` (below) meanwhile. openEdit (a click on an existing mark) opens the same picker over the
  // region's real tags. `nodePath` is the node the region hangs off (a CHUNK for a chapter selection,
  // else the material). The title bar shows the fragment's path (existing region) or the material's.
  const openCreate = (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void, imageBase64?: string, nodePath?: string) => {
    if (READ_ONLY) return; // a fresh region exists only to be tagged — a write; existing marks still render
    setOpen({ selector, nodePath: nodePath ?? path, create: true, copy, imageBase64, x: screen.x, y: screen.y, title: displayPath(nodePath ?? path), keyText: "" });
  };
  const openEdit = (ann: Annotation, screen: { x: number; y: number }) => {
    if (READ_ONLY) return; // the picker only adds/removes tags — both writes
    // a MEMBER fragment carries its key (renamable); an inline-token mark has no node of its
    // own, so its key row stays empty and read-only
    const fragPath = ann.fragmentSlug && !ann.inline ? annotationTarget(path, ann) : undefined;
    setOpen({
      selector: (ann.selector ?? {}) as Record<string, unknown>, nodePath: ann.node ?? path, create: false,
      x: screen.x, y: screen.y, title: displayPath(annotationTarget(path, ann)),
      keyText: fragPath !== undefined ? String(ann.fragmentSlug) : "", fragPath,
    });
  };

  // THE KEY COMMIT: in CREATE mode the name is only REMEMBERED — it becomes the fragment's
  // key when the first tag births it (create-on-first-tag stands; naming alone writes
  // nothing). In EDIT mode over a member fragment it REKEYS the node in place — the crop
  // pointer and the memberships ride inside the block, so they follow for free.
  const renameKey = (name: string): void => {
    setOpen((o) => {
      if (!o) return o;
      if (o.create) return { ...o, keyText: name };
      if (o.fragPath === undefined || name === "") return o;
      rekeyNode(o.fragPath, name)
        .then((r) => setOpen((cur) => (cur ? { ...cur, keyText: name, fragPath: r.path, title: displayPath(r.path) } : cur)))
        .catch((e) => window.alert(`rename failed: ${(e as Error).message}`));
      return o;
    });
  };

  // The region's tag applications, live from the material — toggles reflect at once (optimistic).
  // These ARE the outlined tags: an outlined tag is a real application, so clicking it removes it.
  // Matched by selector AND host node, so the same quoted text in two chunks stays distinct.
  const regionAnns = open ? a.annotations.filter((x) => sameSelector(x.selector, open.selector) && (x.node ?? path) === open.nodePath) : [];
  const applied: TagRef[] = regionAnns.map((x) => x.tag).filter((t): t is TagRef => !!t);
  // The tags borne by OTHER components of this node (its other fragments / its whole-node tags) —
  // surfaced as default chips so the same vocabulary used across the image is one click away.
  const nodeTags: TagRef[] = [];
  const seenNode = new Set<string>();
  for (const an of a.annotations) {
    if (!an.tag) continue;
    const k = canonPath(an.tag.path);
    if (seenNode.has(k)) continue;
    seenNode.add(k);
    nodeTags.push(an.tag);
  }

  const onPick = (t: TagRef) => {
    if (!open) return;
    rememberTag(t); // file it among the recents (no project-scoped "last tag" any more)
    if (applied.some((r) => canonPath(r.path) === canonPath(t.path))) return; // already applied (defensive)
    const slug = open.create && open.keyText.trim() !== "" ? open.keyText.trim() : undefined;
    a.annotateRegion(open.selector, t, { imageBase64: open.imageBase64, target: open.nodePath, slug });
  };
  const onUnpick = (t: TagRef) => {
    if (!open) return;
    const victim = regionAnns.find((x) => x.tag && canonPath(x.tag.path) === canonPath(t.path));
    if (victim) a.remove(victim);
  };

  // Outside-click closes, and so does SCROLLING the page/content: the menu is position:fixed at the
  // selection's viewport coords, so once the content scrolls it would float detached from its mark —
  // closing (like a cancel) is the least surprising. A scroll INSIDE the menu (its suggestion list)
  // is ignored. Whatever tags were applied stay; closing never deletes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (withinTocPane(e.target)) return; // a TOC row click APPLIES the tag — never a close
      if (withinQueryDropdown(e.target)) return; // a candidate pick in the portaled dropdown — never a close
      close();
    };
    // Both a real scrollbar scroll AND a wheel gesture close it: the image / map / PDF viewers
    // pan & zoom on `wheel` WITHOUT a `scroll` event (Leaflet transforms, pdf zoom), so a wheel
    // listener is what catches those. A wheel/scroll INSIDE the menu (its suggestion list) — or
    // in the TOC pane the popup is filtering, or the portaled candidate dropdown — is kept.
    const onShift = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return; // scrolled INSIDE the menu
      if (withinTocPane(e.target)) return;
      if (withinQueryDropdown(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onShift, true); // capture: catch scrolls in any nested container
    window.addEventListener("wheel", onShift, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("wheel", onShift, true);
    };
  }, [open]);

  const palette: ReactNode = open ? (
    <AnnotationMenu
      menuRef={menuRef} x={open.x} y={open.y} applied={applied} nodeTags={nodeTags} mode="create"
      onPick={onPick} onUnpick={onUnpick}
      onCopy={open.copy ? () => { open.copy!(); close(); } : undefined}
      onClose={close} title={open.title} targetPath={open.nodePath}
      keyText={open.keyText}
      onRenameKey={open.create || open.fragPath !== undefined ? renameKey : undefined}
    />
  ) : null;

  // Keep the marquee drawn via a NEUTRAL preview ONLY for a freshly-DRAWN region while it has no tag
  // yet (so the rectangle you just dragged stays visible until its first tag draws it) — in the
  // neutral SELECTION_COLOR, not a tag color, because nothing is preselected. EDITING an existing
  // region never previews — untagging it down to zero must let it vanish, not re-draw a ghost that
  // makes "uncheck all tags" look like a no-op. `node` scopes a TEXT preview to its chunk
  // (AnnotatedMaterial draws it as a mark — see the highlight() preview leg).
  const preview = open && open.create && applied.length === 0
    ? { selector: open.selector, color: SELECTION_COLOR, node: open.nodePath }
    : null;
  return { openCreate, openEdit, palette, preview, color: SELECTION_COLOR };
}

/** True for a node inside page CHROME rather than document content — the `§N` chunk gutter, any
 *  button, and anything a renderer marks `data-yo-chrome`. Chrome is on the page but not in the
 *  document, so it is never annotatable. */
function isChrome(n: Node | null): boolean {
  const el = n instanceof HTMLElement ? n : n?.parentElement;
  return !!el?.closest?.(".chunk-index, button, [data-yo-chrome]");
}

export function AnnotatedMaterial({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const material = useMaterialAnnotations(path);
  const { openCreate, openEdit, palette, preview } = useAnnotationMenu(material, path);
  const { annotations } = material;

  // The node a selection lives on: the enclosing chapter CHUNK (its `.chunk[data-node-path]`), so the
  // fragment attaches to the chunk (docs/annotations/storage); else the material itself (a standalone doc).
  const nodeAt = (n: Node | null): string => {
    const start = n instanceof HTMLElement ? n : n?.parentElement;
    return (start?.closest?.("[data-node-path]") as HTMLElement | null)?.dataset.nodePath || path;
  };

  // Re-highlight after each render: the material (esp. a chapter's chunks) may settle a tick
  // after mount, so do it on a frame and clear any prior marks first. The `preview` rides along:
  // the tagging popup's first act plants the caret in its query cells, which takes the browser's
  // ONE selection with it — so the just-selected text is re-drawn as a neutral preview mark and
  // stays visible until the first tag lands (or the popup closes).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => highlight(el, annotations, path, preview));
    return () => cancelAnimationFrame(raf);
  });

  // A finished text selection inside the material raises the CREATE menu by the selection.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return; // LEFT release only — right-click goes through onContextMenu below
      const el = ref.current;
      if (!el) return;
      if ((e.target as HTMLElement)?.closest?.(".annotate-menu")) return; // a menu click, not a selection
      if ((e.target as HTMLElement)?.closest?.("mark.yo-annotation")) return; // a mark click → handled by onClick
      const sel = window.getSelection();
      // BOTH ends must sit inside the material — a selection that bleeds out (e.g. dragging from a
      // heading up into surrounding chrome) would capture off-content text whose `exact` is never
      // found in the body, leaving an un-highlightable, hard-to-delete phantom annotation.
      if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return;
      if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return;
      // …and neither end may sit in CHROME. A material's page also carries text the document does
      // not contain — the `§N` gutter, buttons, placeholders, empty-state notes. Annotating it
      // would anchor a fragment to a string that is not in the body, so it could never be
      // highlighted again and would be a chore to delete.
      if (isChrome(sel.anchorNode) || isChrome(sel.focusNode)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      // A selection crossing CHUNKS is a range, hung off the material rather than either chunk
      // (see captureRange). Try it first: `capture` would happily return a quote made of both
      // chunks' text joined, which belongs to neither.
      const span = captureRange(sel, el);
      if (span) {
        const whole = sel.toString().trim();
        openCreate(span as unknown as Record<string, unknown>, { x: rect.left, y: rect.bottom + 6 }, () => copyText(whole), undefined, path);
        return;
      }
      const cap = capture(sel);
      if (!cap) return;
      const copy = () => copyText(cap.exact);
      openCreate({ type: "text", exact: cap.exact, prefix: cap.prefix, suffix: cap.suffix }, { x: rect.left, y: rect.bottom + 6 }, copy, undefined, nodeAt(sel.anchorNode));
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

  // RIGHT-CLICK is also a way in: on an existing mark → edit it; on a live selection → tag it. This
  // mirrors the node context menu (right-click → the window) and needs no precise mouseup timing.
  const onContextMenu = (e: React.MouseEvent) => {
    // READ-ONLY: neither menu below can open — both openEdit and openCreate are writes and bail
    // out. Suppressing the NATIVE menu anyway left a read-only reader with no menu at all and no
    // way to copy a line off the page. Hand the browser its own menu back.
    if (READ_ONLY) return;
    const el = ref.current;
    if (!el) return;
    const mark = (e.target as HTMLElement).closest("mark.yo-annotation") as HTMLElement | null;
    if (mark) {
      const ann = annotations.find((x) => annKey(x) === mark.dataset.annSel);
      if (ann && editable(ann)) { e.preventDefault(); openEdit(ann, { x: e.clientX, y: e.clientY }); }
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return;
    if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return;
    const span = captureRange(sel, el); // a cross-chunk selection — see the mouseup path
    if (span) {
      const whole = sel.toString().trim();
      e.preventDefault();
      openCreate(span as unknown as Record<string, unknown>, { x: e.clientX, y: e.clientY }, () => copyText(whole), undefined, path);
      return;
    }
    const cap = capture(sel);
    if (!cap) return;
    e.preventDefault(); // suppress the native menu; open ours at the cursor
    const copy = () => copyText(cap.exact);
    openCreate({ type: "text", exact: cap.exact, prefix: cap.prefix, suffix: cap.suffix }, { x: e.clientX, y: e.clientY }, copy, undefined, nodeAt(sel.anchorNode));
  };

  // No annotation count here — the RHS fragments panel is the canonical list of what's tagged.
  return (
    <div className="annotated">
      <div ref={ref} onClick={onClickMark} onContextMenu={onContextMenu}>{children}</div>
      {palette}
    </div>
  );
}

/** Copy `text` to the clipboard, working in insecure contexts too. `navigator.clipboard` exists
 *  ONLY in a secure context — `https:` or `http://localhost`/`127.0.0.1`. Reach a `--headless`
 *  server over a LAN IP or hostname on plain HTTP and `navigator.clipboard` is `undefined`, so the
 *  async API silently no-ops (the old `navigator.clipboard?.writeText(...)` "did nothing"). Fall
 *  back to the legacy `execCommand("copy")` on an off-screen textarea, which has no secure-context
 *  requirement. Returns whether the copy is believed to have succeeded. */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => execCommandCopy(text), // permission/focus rejection → try the legacy path before giving up
    );
  }
  return Promise.resolve(execCommandCopy(text));
}

/** The pre-Clipboard-API copy: drop the text into an off-screen, focused `<textarea>`, select it,
 *  and ask the document to copy the selection. Works over plain HTTP. Returns success. */
function execCommandCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
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

/** How much text either side of a quote is kept as disambiguating context. */
const CONTEXT = 24;

/** The chunk element a DOM node sits in — the `[data-node-path]` box a chapter wraps each of its
 *  prose items in — or null when the node is not inside one. */
function chunkElOf(n: Node | null, within: HTMLElement): HTMLElement | null {
  const start = n instanceof HTMLElement ? n : n?.parentElement;
  const el = start?.closest?.("[data-node-path]") as HTMLElement | null;
  return el && within.contains(el) ? el : null;
}

/** A quote selector for the part of `r` that falls inside `el`, with context taken from `el`'s own
 *  text. `side` picks which end of the intersection is open: `head` runs from the range's start to
 *  the end of `el`, `tail` from the start of `el` to the range's end. */
function sliceQuote(r: Range, chunk: HTMLElement, side: "head" | "tail"): { exact: string; prefix: string; suffix: string } | null {
  // Prefer the chunk's BODY over the chunk box: the box also holds the `§N` gutter, and a tail
  // slice that runs from the box's start swallows that number into the quote — chrome the reader
  // never selected, stored as if it were their words.
  const body = chunk.querySelector<HTMLElement>(".chunk-body");
  const end = side === "head" ? r.startContainer : r.endContainer;
  const el = body && body.contains(end) ? body : chunk;
  const cut = document.createRange();
  cut.selectNodeContents(el);
  if (side === "head") cut.setStart(r.startContainer, r.startOffset);
  else cut.setEnd(r.endContainer, r.endOffset);
  const exact = cut.toString().trim();
  if (!exact) return null;
  const full = el.textContent ?? "";
  const at = full.indexOf(exact);
  return {
    exact,
    prefix: at >= 0 ? full.slice(Math.max(0, at - CONTEXT), at) : "",
    suffix: at >= 0 ? full.slice(at + exact.length, at + exact.length + CONTEXT) : "",
  };
}

/** A selection spanning SEVERAL chunks, as a W3C RangeSelector — or null when it does not span.
 *
 *  A cross-chunk selection cannot be a text fragment: `capture` would hand back an `exact` made of
 *  text from several chunks run together, a string that occurs in none of them, so the fragment
 *  could never be found again and the selection simply vanished off the page. A range says the
 *  same thing correctly — where it STARTS and where it ENDS, each quoted in its own chunk, with
 *  everything between them implied.
 *
 *  Neither end records which chunk it was in. It is tempting (chunks are addressable, and the
 *  path would be one more field) but wrong for the same reason character offsets are wrong here:
 *  a chunk's position shifts the moment anything is inserted above it, while the quotation
 *  survives every edit but a rewrite of the quoted words themselves. Both ends are searched in the
 *  enclosing material's own text, which contains them by construction. */
function captureRange(sel: Selection, within: HTMLElement): { type: "range"; startSelector: object; endSelector: object } | null {
  if (sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const a = chunkElOf(r.startContainer, within);
  const b = chunkElOf(r.endContainer, within);
  if (!a || !b || a === b) return null; // one chunk (or no chunks at all) — an ordinary text fragment
  const startSelector = sliceQuote(r, a, "head");
  const endSelector = sliceQuote(r, b, "tail");
  if (!startSelector || !endSelector) return null;
  return { type: "range", startSelector: { type: "text", ...startSelector }, endSelector: { type: "text", ...endSelector } };
}

/** (Re)apply highlight marks for the text annotations in `container`. `materialPath` lets a
 *  fragment mark carry its `#/yo/fragments/<slug>` anchor id so the RHS panel / a shared link
 *  can scroll-to-&-flash it. `preview` is the popup's not-yet-tagged selection, drawn as a mark in
 *  the neutral color so it survives the popup taking the browser's selection. */
function highlight(container: HTMLElement, anns: Annotation[], materialPath: string, preview?: { selector: Record<string, unknown>; color: string; node?: string } | null): void {
  container.querySelectorAll("mark.yo-annotation").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  // scope a wrap to the node the fragment lives on: a chapter CHUNK (its `.chunk[data-node-path]`
  // element), so a word repeated across chunks marks only the right one; else the whole material.
  const scopeOf = (node: string | undefined): HTMLElement => {
    if (node) for (const el of container.querySelectorAll<HTMLElement>("[data-node-path]")) if (el.dataset.nodePath === node) return el;
    return container;
  };
  for (const a of anns) {
    // A RANGE is drawn over the WHOLE material, never `scopeOf` — its two ends live in different
    // chunks by definition, and `scopeOf` answers with the FIRST element bearing the path, which
    // for a chapter is its title row: an element containing neither end, so nothing was drawn at
    // all and the selection looked like it had been thrown away.
    if (a.selector?.type === "range") { wrapRange(container, a, a.node ?? materialPath); continue; }
    if (a.selector?.type !== "text" || !a.selector.exact) continue;
    wrapQuote(scopeOf(a.node), a, a.node ?? materialPath);
  }
  if (preview) {
    const p = { selector: preview.selector } as Annotation;
    if (preview.selector.type === "range") wrapRange(container, p, preview.node ?? materialPath, preview.color);
    else if (preview.selector.type === "text" && preview.selector.exact) {
      wrapQuote(scopeOf(preview.node), p, preview.node ?? materialPath, preview.color);
    }
  }
}

/** The container's text nodes flattened into one string, each tagged with its global start offset
 *  — the coordinate space a TextQuoteSelector's match position lives in. */
function flatten(container: HTMLElement): { nodes: { node: Node; at: number }[]; full: string } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: { node: Node; at: number }[] = [];
  let full = "";
  for (let n: Node | null; (n = walker.nextNode()); ) { nodes.push({ node: n, at: full.length }); full += n.nodeValue ?? ""; }
  return { nodes, full };
}

/** Where `exact` sits in `full`, picking the occurrence whose surroundings best match the quote's
 *  context (prefix weighted higher); −1 when absent. Ties and no-context keep the FIRST match. */
function locateQuote(full: string, exact: string, prefix: string, suffix: string): number {
  let best = -1, bestScore = -1;
  for (let i = full.indexOf(exact); i >= 0; i = full.indexOf(exact, i + 1)) {
    const score = (prefix && full.slice(0, i).endsWith(prefix) ? 2 : 0) + (suffix && full.slice(i + exact.length).startsWith(suffix) ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** A fresh `<mark>` in the annotation's colour, carrying its identity. */
function markFor(a: Annotation, colorOverride?: string, fragId?: string): HTMLElement {
  const c = colorOverride ?? colorOf(a);
  const mark = document.createElement("mark");
  mark.className = "yo-annotation";
  mark.style.backgroundColor = `color-mix(in srgb, ${c} var(--mark-mix, 30%), transparent)`;
  mark.style.borderBottomColor = c;
  mark.dataset.annSel = annKey(a);
  if (fragId) mark.id = fragId;
  mark.title = colorOverride !== undefined ? "" : a.description || "click to re-tag or delete";
  return mark;
}

/** Draw a RANGE fragment: from the start quote through to the end of the end quote, every text
 *  node between them included.
 *
 *  Unlike {@link wrapQuote} this cannot be one `surroundContents` — the whole point of a range is
 *  that it crosses element boundaries, which is exactly what that call refuses. So the span is
 *  wrapped a text node at a time. Each piece is its own `<mark>` carrying the same identity key,
 *  so clicking any of them re-opens the one annotation. */
function wrapRange(container: HTMLElement, a: Annotation, materialPath: string, colorOverride?: string): void {
  const sel = a.selector as { startSelector?: Record<string, unknown>; endSelector?: Record<string, unknown> };
  const s = sel.startSelector, e = sel.endSelector;
  if (!s?.exact || !e?.exact) return;
  const fragId = a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : "";
  if (fragId) for (const el of container.querySelectorAll<HTMLElement>("[id]")) if (el.id === fragId) return;

  const { nodes, full } = flatten(container);
  const from = locateQuote(full, String(s.exact), String(s.prefix ?? ""), String(s.suffix ?? ""));
  if (from < 0) return;
  const endExact = String(e.exact);
  // the end quote is searched AFTER the start — a range never runs backwards, and the same words
  // may well appear earlier on the page
  const tail = full.slice(from);
  const endRel = locateQuote(tail, endExact, String(e.prefix ?? ""), String(e.suffix ?? ""));
  if (endRel < 0) return;
  const to = from + endRel + endExact.length;

  // Collect the slices first, THEN wrap: wrapping splits text nodes, and a half-mutated walk
  // would either miss pieces or re-wrap what it just drew.
  const slices: { node: Node; a: number; b: number }[] = [];
  for (const { node, at } of nodes) {
    const len = node.nodeValue?.length ?? 0;
    const lo = Math.max(from, at), hi = Math.min(to, at + len);
    if (hi > lo) slices.push({ node, a: lo - at, b: hi - at });
  }
  for (const [i, sl] of slices.entries()) {
    const r = document.createRange();
    r.setStart(sl.node, sl.a);
    r.setEnd(sl.node, sl.b);
    try {
      // only the FIRST piece takes the anchor id — an id must be unique, and it is the place a
      // link to this fragment should land
      r.surroundContents(markFor(a, colorOverride, i === 0 ? fragId : undefined));
    } catch {
      /* a slice that is not cleanly inside one text node — skip that piece, keep the rest */
    }
  }
}

/** Wrap the occurrence of an annotation's `exact` that best matches its `prefix`/`suffix` context
 *  — a W3C TextQuoteSelector anchor over `container`'s text, so a word repeated on the page (e.g.
 *  in a heading AND a chunk) marks the SAME one the user selected. Falls back to the first
 *  occurrence when the context does not disambiguate. The `<mark>` carries the annotation's identity
 *  key (a click maps back to it) and, for a fragment, its `#`-anchor id (skip if already drawn). The
 *  match must lie within ONE text node for `surroundContents` (v1); a cross-element match is skipped.
 *  `colorOverride` paints the popup's not-yet-tagged selection preview (the neutral color). */
function wrapQuote(container: HTMLElement, a: Annotation, materialPath: string, colorOverride?: string): void {
  const sel = a.selector!;
  const exact = String(sel.exact);
  const fragId = a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : "";
  // already drawn? (a fragment's id carries `:`/`/` — scan ids rather than a CSS selector, which
  // would need CSS.escape, absent in some engines)
  if (fragId) for (const e of container.querySelectorAll<HTMLElement>("[id]")) if (e.id === fragId) return;
  const { nodes, full } = flatten(container);
  const best = locateQuote(full, exact, String(sel.prefix ?? ""), String(sel.suffix ?? ""));
  if (best < 0) return;
  const hit = nodes.find((e) => best >= e.at && best < e.at + (e.node.nodeValue?.length ?? 0));
  if (!hit) return;
  const local = best - hit.at;
  if (local + exact.length > (hit.node.nodeValue?.length ?? 0)) return; // spans text nodes — skip (v1)
  const range = document.createRange();
  range.setStart(hit.node, local);
  range.setEnd(hit.node, local + exact.length);
  try {
    // The mark's colour works for hex AND a named tag's hsl(). The mix weight is themed
    // (--mark-mix, styles.css): the taxonomy pastels highlight fine at 30% on the dark bg but
    // vanish on the light one.
    range.surroundContents(markFor(a, colorOverride, fragId));
  } catch {
    /* the snippet spans element boundaries — skip highlighting it for now */
  }
}
