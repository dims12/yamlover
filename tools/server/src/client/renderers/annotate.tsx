import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, TagRef, createTag, fetchAnnotations, fetchNode, query, createFragment, annotate, deleteAnnotation, fetchConfig } from "../api";
import { explicitColor, isColorTagPath, resolveTagColor, tagFields, tagStyle } from "./tag";
import { TagTip } from "./tagtip";
import { canonPath, displayPath, fragmentAnchorId, strToSegs } from "../paths";
import { touchesYamlover, useDiffBump } from "../live";
import { QueryCells, useQueryCellHost } from "../query-cells";
import { splitQueryPortions, treeCandidateProvider } from "../query-complete";
import { TocFilterHandle, useTocFilter } from "../toc-filter-session";

/**
 * The annotation layer, shared across materials (the UI guide). An annotation is ONE TAG
 * APPLICATION: a region of the material tagged by a tag, optionally commented. You SELECT to
 * annotate — drag-select text in prose or a PDF, drag a rectangle on an image or map — and a
 * floating tag picker appears. A NEW selection preselects NOTHING: no tag is applied and no swatch
 * or chip is outlined until you pick one; the just-drawn region shows in a NEUTRAL color meanwhile.
 * Only the tags a target ALREADY carries are shown (outlined). The picker offers:
 *
 *   - the PURE COLOR TAGS (built-in `yamlover/tags/colors/…`) as swatches. Click one to apply it.
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
// The NEUTRAL color a freshly-drawn region / in-progress selection is painted in, before any tag is
// picked — "no tag chosen yet". A new selection preselects nothing, so it is deliberately NOT a tag
// color (a muted gray, not the palette's yellow default).
export const SELECTION_COLOR = "#9399b2";
const RECENT_KEY = "yo-annotate-recent-tags"; // recently-applied NAMED tags, a browser-local convenience list

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
 *  path is the `.yamlover` file itself), wherever it lives in the tree: annotations are graph
 *  nodes, not residents of a fixed folder, so one moved to another directory stays editable.
 *  Every embedded annotation (one with a resolved tag) is editable — re-tag/delete just edits its
 *  host body. Transient markers (a `(preview)`/`(pending)` placeholder) are not. */
export function editable(a: Annotation): boolean {
  return !!a.tag && a.path !== "(preview)" && a.path !== "(pending)";
}

// The color tags as indexed (fetched once per session; the constant covers offline/legacy roots).
let colorTagsPromise: Promise<TagRef[]> | null = null;

/** Load the palette, preferring the project's REAL `::tags:colors` over the self-import graft.
 *  In a yamlover PROJECT the self-import is de-materialized (graft-virtualize), so `::tags:colors`
 *  is the live palette and `::yamlover:tags:colors` no longer exists as a node; in a plain/FOREIGN
 *  served root only the built-in graft `::yamlover:tags:colors` exists. Pin each emitted ref to the
 *  base that resolved, so the written pointer matches the tag PAGE path (`:tags:colors:<name>` in a
 *  project) and reconciles against the server echo instead of leaving a ghost badge. */
async function loadColorTags(): Promise<TagRef[]> {
  for (const base of ["::tags:colors", "::yamlover:tags:colors"]) {
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
  return COLOR_TAGS;
}

export function useColorTags(): TagRef[] {
  const [tags, setTags] = useState<TagRef[]>(COLOR_TAGS);
  useEffect(() => {
    colorTagsPromise ??= loadColorTags();
    let cancelled = false;
    colorTagsPromise.then((t) => { if (!cancelled) setTags(t); });
    return () => { cancelled = true; };
  }, []);
  return tags;
}

// Enumerate every NAMED tag in the project for the picker typeahead: a document-root recursive
// descent, format-filtered (QUERY.md "all tag nodes"). Document-root scope finds tags wherever
// `settings.tags.location` puts them — the client need not know that path. The grafted COLOR
// palette lives off the document root (link scope `::yamlover:…`) so it is naturally absent;
// the defensive filter below also drops any color tag a project re-themes in-tree (those are the
// swatch row, not the suggestion list).
const TAG_QUERY = ": ...: !!<format: x-yamlover-tag>";

export function indexToRefs(paths: string[]): TagRef[] {
  // A tag is just a NODE at a real path — keep each path AS-IS (no namespace rewriting). A project's
  // OWN tags (`:tags:…`, `:67-pdf-tags:tags:…`) and the GLOBAL self-import tags (`:yamlover:tags:…`)
  // are DISTINCT nodes and BOTH belong in the picker (IMPORTS.md — a tag lives anywhere, reached by
  // `:`/`::yamlover`). Dedup only EXACT duplicates (one node spelled two scope-ways), and drop the
  // color palette (it is the swatch row, not a suggestion).
  const byKey = new Map<string, string>();
  for (const p of paths) {
    if (isColorTagPath(p)) continue;
    const key = canonPath(p);
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return [...byKey.values()].map((p) => ({ path: p, name: tagNameOf(p), color: null }));
}

/** The project's named tags, enumerated once and re-enumerated when a `.yamlover` source changes
 *  (so a freshly created tag appears). Feeds the picker's typeahead suggestions. */
export function useTagIndex(): TagRef[] {
  const [tags, setTags] = useState<TagRef[]>([]);
  const bump = useDiffBump(touchesYamlover);
  useEffect(() => {
    let cancelled = false;
    query(TAG_QUERY)
      .then((paths) => { if (!cancelled) setTags(indexToRefs(paths)); })
      .catch(() => { if (!cancelled) setTags([]); });
    return () => { cancelled = true; };
  }, [bump]);
  return tags;
}

// The roots whose tags the picker shows AS CHIPS by default (no typing): the grafted yamlover
// self-import taxonomy (always present) plus the project's CONFIGURED tags location. Tags living
// elsewhere in the tree (e.g. a sub-document's own `tags/`) stay reachable through the typeahead.
const GRAFT_TAG_ROOTS = [":yamlover:tags", "::yamlover:tags"];

/** The project's configured tags location (`settings.tags`), or null until config loads / on error. */
export function useConfigTagsLocation(): string | null {
  const [loc, setLoc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchConfig().then((c) => { if (live) setLoc(c.settings.tags ?? null); }).catch(() => { /* keep null → graft scope only */ });
    return () => { live = false; };
  }, []);
  return loc;
}

/** Whether `path` is at-or-under one of `roots` (segment-boundary aware, scope-spelling tolerant). */
function underAnyRoot(path: string, roots: (string | null)[]): boolean {
  const cp = canonPath(path);
  return roots.some((r) => { if (!r) return false; const rc = canonPath(r); return cp === rc || cp.startsWith(rc + ":"); });
}

/** File a just-applied tag among the recents (a browser-local convenience list; color tags live in
 *  the swatch row already). There is NO project-scoped "last tag" any more — a new selection
 *  preselects nothing, so the only thing an apply remembers is the recents suggestions. */
export function rememberTag(t: TagRef): void {
  rememberRecent(t);
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

/** Drop recents whose node is GONE: the localStorage recents list outlives the tags
 *  themselves, so a deleted tag would linger as a clickable badge forever. Each recent is
 *  checked against the server; survivors are written back. ANY existing node counts — any
 *  node can be a tag now, so liveness is existence, not format. */
function pruneRememberedTags(): Promise<TagRef[]> {
  const isLive = (t: TagRef): Promise<boolean> =>
    fetchNode(t.path, 0).then(() => true).catch(() => false);
  const recents = recentTags();
  return Promise.all(recents.map((t) => isLive(t).then((live) => (live ? t : null)))).then((kept) => {
    const live = kept.filter(Boolean) as TagRef[];
    if (live.length !== recents.length) localStorage.setItem(RECENT_KEY, JSON.stringify(live));
    return live;
  });
}

/** Apply `tag` to the material at `target`. With a `selector`, first create a FRAGMENT (the
 *  region, plus an optional PNG crop) and tag THAT; without one, tag the whole node. */
export async function createAnnotation(
  target: string,
  selector: Record<string, unknown> | null,
  tag: TagRef,
  imageBase64?: string,
): Promise<unknown> {
  if (!selector) return annotate({ target, tag: tag.path });
  const { fragmentPath } = await createFragment(target, selector, imageBase64);
  return annotate({ target: fragmentPath, tag: tag.path });
}

/** The host node path that carries a tag application: the node the annotation lives ON (`ann.node`
 *  — a CHUNK for a chunk fragment, else the material), and — when it marks a region — that node's
 *  fragment path (`…:yamlover-fragments:<slug>`). */
function annotationTarget(materialPath: string, ann: Annotation): string {
  const host = ann.node ?? materialPath;
  if (!ann.fragmentSlug) return host;
  return (host === ":" ? "" : host) + ":yamlover-fragments:" + ann.fragmentSlug;
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
  create: (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string; target?: string }) => void;
  remove: (ann: Annotation) => void;
  /** Add `tag` to the REGION identified by `selector`: the FIRST tag creates the fragment (with the
   *  optional crop), later tags annotate that same fragment — never a second one, even if clicked
   *  before the first create's server round-trip lands (those queue and drain on the next fetch).
   *  `target` is the node the fragment hangs off — the enclosing CHUNK for a chapter selection, else
   *  the material (default). `silent` suppresses the failure alert. */
  annotateRegion: (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean; target?: string }) => void;
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
    deleteAnnotation(annotationTarget(path, ann), ann.tag!.path)
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
  const create = (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string; target?: string }) => {
    const target = opts?.target ?? path; // the node the fragment hangs off (a chunk, else the material)
    const entry = { path: "(pending)", node: target, selector: selector ?? undefined, tag } as Annotation;
    setOptimistic((o) => [...o, entry]);
    createAnnotation(target, selector, tag, opts?.imageBase64).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
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

  const annotateRegion = (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean; target?: string }) => {
    const node = opts?.target ?? path; // the region's host node (a chunk, else the material)
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

/** A tag's display name from its node path (its last segment). */
function tagNameOf(path: string): string {
  const segs = strToSegs(path);
  return segs.length ? String(segs[segs.length - 1]) : path;
}

/** An OMNI node's scalar self-value (the `$yamloverMixed` marker) as its display title — a
 *  plain LEAF scalar's value is data, not a title, so only the value-plus-fields shape reads. */
function omniTitle(value: unknown): string | null {
  const m = (value as { $yamloverMixed?: { value?: unknown } } | null | undefined)?.$yamloverMixed;
  return m && typeof m.value === "string" && m.value !== "" ? m.value : null;
}

/** Resolve ANY node path into the annotation ref shape { path, name, color }: the name is its
 *  omni scalar title, else its schema title, else its key inside the parent. */
async function tagRefOf(p: string): Promise<TagRef> {
  const n = await fetchNode(p, 1);
  return { path: n.path, name: omniTitle(n.value) || n.title || tagNameOf(n.path), color: explicitColor(n.value) };
}

/** Whether an event landed inside the LEFT (TOC) pane — the popup's close-on-outside-click
 *  must not fire for TOC interactions while the popup drives the TOC filter session. */
export function withinTocPane(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  return !!el?.closest?.(".pane.left");
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
  x, y, applied, nodeTags = [], mode, onPick, onUnpick, onCopy, onClose, menuRef, creates, title,
}: {
  x: number; y: number; applied: TagRef[]; nodeTags?: TagRef[]; mode: "create" | "edit";
  onPick: (t: TagRef) => void; onUnpick?: (t: TagRef) => void;
  onCopy?: () => void; onClose: () => void;
  menuRef?: React.Ref<HTMLDivElement>;
  /** Object-creation entries shown at the top (e.g. "＋ New chapter" with a concrete selector). */
  creates?: CreateEntry[];
  /** The path/label of the object the menu was opened for — shown in the draggable title bar. */
  title?: string;
}) {
  const colorTags = useColorTags();
  const tagIndex = useTagIndex(); // named tags (whole tree) — the scoped ones show as default chips
  const tagsLoc = useConfigTagsLocation(); // the configured tags location → its tags show as default chips
  const [recents, setRecents] = useState(recentTags); // shown at once; pruned against the server
  const [busy, setBusy] = useState(false); // a lookup/create round-trip is in flight
  const verb = mode === "edit" ? "re-tag" : "tag";
  const session = useTocFilter(); // the shared TOC filter — typing here filters the TOC too

  // Apply ANY picked node as the tag (no format gate — an annotation is just a reference).
  const applyPath = (p: string): void => {
    tagRefOf(p)
      .then(onPick)
      .catch((e) => window.alert(`cannot ${verb} with "${p}": ` + (e as Error).message));
  };
  const applyPathRef = useRef(applyPath);
  applyPathRef.current = applyPath;

  // The SEARCH input is the shared query-cell editor (breadcrumb machinery, PICK mode), opening
  // at the PROJECT scope with a recursive-descent seed — typing a bare name spells
  // `:: ...: name`, the "find a node by name anywhere IN THE PROJECT" query. The project rung
  // is what makes the grafted yamlover taxonomy (the built-in palette included) searchable —
  // `:` would be the document only (URIs.md ladder). The cells stay fully editable.
  const host = useQueryCellHost({
    ctx: () => ({ mode: "pick", ladder: 2, idlePortions: () => [...SEED_CELLS] }),
    provider: useRef(treeCandidateProvider(":")).current,
    onSelect: (p, meta) => {
      if (meta && /^:*$/.test(meta.query.trim())) return; // empty cells: nothing to apply
      if (p !== null) {
        applyPathRef.current(p);
        return;
      }
      if (!meta) return;
      // CREATE-ON-MISS: a bare NAME (alone, or after the seeded `...`) that matches nothing is
      // born as a named tag at the project's tags location. A missed multi-portion query stays
      // an error — a typo'd path must not silently mint a tag named like a path.
      const parts = splitQueryPortions(meta.query);
      const name = unquotePortion(parts[parts.length - 1] ?? "");
      const bareName =
        name !== "" && !/[:[\]?*!<>=]/.test(name) && (parts.length === 1 || (parts.length === 2 && parts[0] === "..."));
      if (!bareName) {
        window.alert(`cannot ${verb} with "${meta.query}": no such node`);
        return;
      }
      setBusy(true);
      createTag(name)
        .then(onPick)
        .catch((e) => window.alert(`cannot create tag "${name}": ` + (e as Error).message))
        .finally(() => setBusy(false));
    },
    session: null, // the menu drives the session itself — a TOC click APPLIES the tag (below)
  });

  // The popup OWNS the TOC filter session while open: the host's filter results mirror into it,
  // and a TOC row click applies that node as the tag directly (the popup stays open, multi-tag).
  const sessionHandle = useRef<TocFilterHandle | null>(null);
  useEffect(() => {
    if (!session || sessionHandle.current) return;
    sessionHandle.current = session.begin({
      onPick: (p) => applyPathRef.current(p),
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

  // A deleted tag must not survive as a badge: on open, drop remembered tags the server no
  // longer holds (the stored list is shown immediately; the pruned one replaces it quietly).
  useEffect(() => {
    let on = true;
    pruneRememberedTags().then((live) => { if (on) setRecents(live); });
    return () => { on = false; };
  }, []);

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

  // The chips shown by the popup — the four sources, most-relevant first: (a) tags APPLIED to
  // this target, (b) tags borne by OTHER components of the same node (sibling fragments), (c)
  // the last-used / recent tags, (d) the project taxonomy — the grafted yamlover tags plus the
  // configured tags location. ANYTHING else in the tree is reachable through the query cells
  // (the dropdown + the filtered TOC), so the chip row no longer doubles as a search result.
  const scopedIndex = tagIndex.filter((t) => underAnyRoot(t.path, [...GRAFT_TAG_ROOTS, tagsLoc]));
  const view = dedupeNamed([...applied, ...nodeTags, ...recents, ...scopedIndex]);

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

  // Drag the window by its title bar (a click on the ✕ inside it is not a drag — see the guard).
  const onTitleDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // the close button, not a drag
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
      {/* the TOP BAR: a draggable PATH CELL (grab-to-move) on the left, then the ⧉ copy and ✕ close
          tools DOCKED at the top-right (outside the path cell). The path is LEFT-truncated (the right
          TAIL stays visible — the head is already in the breadcrumb): a `direction: rtl` container puts
          the ellipsis at the start, a `<bdi>` keeps the text readable. */}
      <div className="annotate-topbar">
        <div className="annotate-titlebar" onMouseDown={onTitleDown} title={title}>
          <span className="annotate-title"><bdi>{title ?? ""}</bdi></span>
        </div>
        {onCopy && <button type="button" className="annotate-tool copy" title="copy text to clipboard (don't annotate)" onClick={onCopy}>⧉</button>}
        <button type="button" className="annotate-tool close" title="close" onClick={onClose}>✕</button>
      </div>
      {creates && creates.length > 0 && (
        <div className="annotate-actions">
          {creates.map((c) => <CreateRow key={c.schema} {...c} />)}
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
      {view.length > 0 && (
        <div className="annotate-recents" role="listbox">
          {view.map((t) => (
            <span key={t.path} className="tagframe">
              <TagTip tag={t}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isApplied(t.path)}
                  className={"tagtag" + (isApplied(t.path) ? " on" : "")}
                  style={tagStyle(resolveTagColor(t))}
                  onClick={() => toggle(t)}
                >
                  <span className="tt-label">{t.name}</span>
                </button>
              </TagTip>
            </span>
          ))}
        </div>
      )}
      {/* the SEARCH row: the shared query cells (breadcrumb machinery, pick mode, PROJECT
          scope) — the dropdown offers real nodes as TOC rows, the TOC filters live, Enter
          applies the first match or creates a fresh named tag, a TOC click applies that node
          directly. Backspace at the first cell's start steps the ladder down (document scope). */}
      <div className="annotate-typeahead" title={`${verb}: type a name (creates on miss), a path, or any query ⏎`}>
        {busy ? (
          <span className="annotate-busy">creating tag…</span>
        ) : (
          <QueryCells host={host} idlePortions={[...SEED_CELLS]} leadingSep idleLadder={2} scopeKeys placeholder="tag name…" className="annotate-cells" />
        )}
      </div>
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

/** An open region picker — keyed by its SELECTOR (the join into the material's annotations), not by
 *  a one-shot create/edit. `create` marks a freshly-DRAWN region (vs editing an existing one): only
 *  then does the neutral preview keep the marquee up before the first tag — editing an existing
 *  region down to zero tags must let it disappear (untag). */
type OpenRegion = { selector: Record<string, unknown>; nodePath: string; create: boolean; copy?: () => void; imageBase64?: string; x: number; y: number; title: string };

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
  preview: { selector: Record<string, unknown>; color: string } | null;
  color: string;
} {
  const [open, setOpen] = useState<OpenRegion | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);

  // Selecting a region OPENS the picker but applies NOTHING — a new selection preselects no tag, so
  // nothing is outlined until the user picks one. The just-drawn region stays visible via the neutral
  // `preview` (below) meanwhile. openEdit (a click on an existing mark) opens the same picker over the
  // region's real tags. `nodePath` is the node the region hangs off (a CHUNK for a chapter selection,
  // else the material). The title bar shows the fragment's path (existing region) or the material's.
  const openCreate = (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void, imageBase64?: string, nodePath?: string) => {
    setOpen({ selector, nodePath: nodePath ?? path, create: true, copy, imageBase64, x: screen.x, y: screen.y, title: displayPath(nodePath ?? path) });
  };
  const openEdit = (ann: Annotation, screen: { x: number; y: number }) =>
    setOpen({ selector: (ann.selector ?? {}) as Record<string, unknown>, nodePath: ann.node ?? path, create: false, x: screen.x, y: screen.y, title: displayPath(annotationTarget(path, ann)) });

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
    a.annotateRegion(open.selector, t, { imageBase64: open.imageBase64, target: open.nodePath });
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
      close();
    };
    // Both a real scrollbar scroll AND a wheel gesture close it: the image / map / PDF viewers
    // pan & zoom on `wheel` WITHOUT a `scroll` event (Leaflet transforms, pdf zoom), so a wheel
    // listener is what catches those. A wheel/scroll INSIDE the menu (its suggestion list) — or
    // in the TOC pane the popup is filtering — is kept.
    const onShift = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return; // scrolled INSIDE the menu
      if (withinTocPane(e.target)) return;
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
      onClose={close} title={open.title}
    />
  ) : null;

  // Keep the marquee drawn via a NEUTRAL preview ONLY for a freshly-DRAWN region while it has no tag
  // yet (so the rectangle you just dragged stays visible until its first tag draws it) — in the
  // neutral SELECTION_COLOR, not a tag color, because nothing is preselected. EDITING an existing
  // region never previews — untagging it down to zero must let it vanish, not re-draw a ghost that
  // makes "uncheck all tags" look like a no-op.
  const preview = open && open.create && applied.length === 0
    ? { selector: open.selector, color: SELECTION_COLOR }
    : null;
  return { openCreate, openEdit, palette, preview, color: SELECTION_COLOR };
}

export function AnnotatedMaterial({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const material = useMaterialAnnotations(path);
  const { openCreate, openEdit, palette } = useAnnotationMenu(material, path);
  const { annotations } = material;

  // The node a selection lives on: the enclosing chapter CHUNK (its `.chunk[data-node-path]`), so the
  // fragment attaches to the chunk (ANNOTATIONS.md §3); else the material itself (a standalone doc).
  const nodeAt = (n: Node | null): string => {
    const start = n instanceof HTMLElement ? n : n?.parentElement;
    return (start?.closest?.("[data-node-path]") as HTMLElement | null)?.dataset.nodePath || path;
  };

  // Re-highlight after each render: the material (esp. a chapter's chunks) may settle a tick
  // after mount, so do it on a frame and clear any prior marks first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => highlight(el, annotations, path));
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
      const cap = capture(sel);
      if (!cap) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
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

/** (Re)apply highlight marks for the text annotations in `container`. `materialPath` lets a
 *  fragment mark carry its `#/yamlover-fragments/<slug>` anchor id so the RHS panel / a shared link
 *  can scroll-to-&-flash it. */
function highlight(container: HTMLElement, anns: Annotation[], materialPath: string): void {
  container.querySelectorAll("mark.yo-annotation").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  for (const a of anns) {
    if (a.selector?.type !== "text" || !a.selector.exact) continue;
    // scope the wrap to the node the fragment lives on: a chapter CHUNK (its `.chunk[data-node-path]`
    // element), so a word repeated across chunks marks only the right one; else the whole material.
    let scope = container;
    if (a.node) for (const el of container.querySelectorAll<HTMLElement>("[data-node-path]")) if (el.dataset.nodePath === a.node) { scope = el; break; }
    wrapQuote(scope, a, a.node ?? materialPath);
  }
}

/** Wrap the occurrence of an annotation's `exact` that best matches its `prefix`/`suffix` context
 *  — a W3C TextQuoteSelector anchor over `container`'s text, so a word repeated on the page (e.g.
 *  in a heading AND a chunk) marks the SAME one the user selected. Falls back to the first
 *  occurrence when the context does not disambiguate. The `<mark>` carries the annotation's identity
 *  key (a click maps back to it) and, for a fragment, its `#`-anchor id (skip if already drawn). The
 *  match must lie within ONE text node for `surroundContents` (v1); a cross-element match is skipped. */
function wrapQuote(container: HTMLElement, a: Annotation, materialPath: string): void {
  const sel = a.selector!;
  const exact = String(sel.exact);
  const fragId = a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : "";
  // already drawn? (a fragment's id carries `:`/`/` — scan ids rather than a CSS selector, which
  // would need CSS.escape, absent in some engines)
  if (fragId) for (const e of container.querySelectorAll<HTMLElement>("[id]")) if (e.id === fragId) return;
  // Flatten the container's text nodes, tracking each node's global start offset, so a
  // TextQuoteSelector position (measured over the whole text) maps back to a node + local offset.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: { node: Node; at: number }[] = [];
  let full = "";
  for (let n: Node | null; (n = walker.nextNode()); ) { nodes.push({ node: n, at: full.length }); full += n.nodeValue ?? ""; }
  // Pick the occurrence whose preceding text ends with `prefix` and following starts with `suffix`
  // (prefix weighted higher); ties and no-context keep the FIRST match.
  const prefix = String(sel.prefix ?? ""), suffix = String(sel.suffix ?? "");
  let best = -1, bestScore = -1;
  for (let i = full.indexOf(exact); i >= 0; i = full.indexOf(exact, i + 1)) {
    const score = (prefix && full.slice(0, i).endsWith(prefix) ? 2 : 0) + (suffix && full.slice(i + exact.length).startsWith(suffix) ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return;
  const hit = nodes.find((e) => best >= e.at && best < e.at + (e.node.nodeValue?.length ?? 0));
  if (!hit) return;
  const local = best - hit.at;
  if (local + exact.length > (hit.node.nodeValue?.length ?? 0)) return; // spans text nodes — skip (v1)
  const range = document.createRange();
  range.setStart(hit.node, local);
  range.setEnd(hit.node, local + exact.length);
  const c = colorOf(a);
  const mark = document.createElement("mark");
  mark.className = "yo-annotation";
  // Works for hex AND a named tag's hsl(). The mix weight is themed (--mark-mix, styles.css):
  // the taxonomy pastels highlight fine at 30% on the dark bg but vanish on the light one.
  mark.style.backgroundColor = `color-mix(in srgb, ${c} var(--mark-mix, 30%), transparent)`;
  mark.style.borderBottomColor = c;
  mark.dataset.annSel = annKey(a);
  if (fragId) mark.id = fragId;
  mark.title = a.description || "click to re-tag or delete";
  try {
    range.surroundContents(mark);
  } catch {
    /* the snippet spans element boundaries — skip highlighting it for now */
  }
}
