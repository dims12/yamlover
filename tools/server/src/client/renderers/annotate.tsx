import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, TagRef, createTag, fetchAnnotations, fetchNode, query, createFragment, annotate, deleteAnnotation, fetchConfig, saveLastTag } from "../api";
import { TAG_FORMAT, explicitColor, isColorTagPath, resolveTagColor, tagFields } from "./tag";
import { TagTip } from "./tagtip";
import { canonPath, fragmentAnchorId, strToSegs } from "../paths";
import { touchesYamlover, useDiffBump } from "../live";

/**
 * The annotation layer, shared across materials (the UI guide). An annotation is ONE TAG
 * APPLICATION: a region of the material tagged by a tag, optionally commented. You SELECT to
 * annotate — drag-select text in prose or a PDF, drag a rectangle on an image or map — and a
 * floating tag picker appears:
 *
 *   - the PURE COLOR TAGS (built-in `yamlover/tags/colors/…`) as swatches; the last-used tag is
 *     pre-selected. Click a swatch to apply that tag.
 *   - the NAMED tags as chips, shown without typing from four sources (most-relevant first): the
 *     tags APPLIED to this target, the tags borne by OTHER components of the same node, the
 *     recently-used tags, and the project taxonomy (the grafted yamlover tags + the configured
 *     tags location). Typing in the path input turns the chip row into a ranked filter over EVERY
 *     tag in the tree (so anything is reachable), and a fresh name creates a tag.
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
const RECENT_KEY = "yo-annotate-recent-tags"; // the last-used tag now lives in settings.yamlover

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

/** The remembered last-applied tag (persisted in localStorage) + a setter that persists it and
 *  files a NAMED tag among the recents (color tags live in the swatch row already). */
export function useAnnotationTag(): [TagRef, (t: TagRef) => void] {
  const [tag, set] = useState<TagRef>(DEFAULT_TAG); // the palette default until settings load
  // SEED from the project config (IMPORTS.md): the last-used tag lives in `settings.yamlover`
  // (`annotation-tag: *:: …`), so the picker default is PROJECT-SCOPED — shared across browsers and
  // always valid in THIS project. This replaces the old browser-localStorage default, whose paths
  // went stale across served roots and caused the optimistic mark to 400 and vanish.
  useEffect(() => {
    let live = true;
    fetchConfig()
      .then((c) => {
        const p = c.settings.annotationTag;
        if (live && p) set({ path: p, name: tagNameOf(p), color: null });
      })
      .catch(() => { /* no config / not set — keep the palette default */ });
    return () => { live = false; };
  }, []);
  const setTag = (t: TagRef) => {
    rememberRecent(t); // recents stay browser-local (a convenience list, not the project default)
    set(t);
    void saveLastTag(t.path).catch(() => { /* best-effort persist; the seed just won't carry over */ });
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

/** Drop recents whose node is GONE (or stopped being a tag): the localStorage recents list
 *  outlives the tags themselves, so a deleted tag would linger as a clickable badge forever. Each
 *  recent is checked against the server; survivors are written back. (The last-used tag is no longer
 *  in localStorage — it lives in settings.yamlover, always valid for the project.) Resolves to the
 *  live recents — the menu shows those. */
function pruneRememberedTags(): Promise<TagRef[]> {
  const isLive = (t: TagRef): Promise<boolean> =>
    fetchNode(t.path, 0).then((n) => n.format === TAG_FORMAT).catch(() => false);
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

/** The host node path that carries a tag application: the material itself, or — when the
 *  annotation marks a region — that fragment's node path (`…:yamlover-fragments:<slug>`). */
function annotationTarget(materialPath: string, ann: Annotation): string {
  if (!ann.fragmentSlug) return materialPath;
  return (materialPath === ":" ? "" : materialPath) + ":yamlover-fragments:" + ann.fragmentSlug;
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
  create: (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string }) => void;
  remove: (ann: Annotation) => void;
  /** Add `tag` to the REGION identified by `selector`: the FIRST tag creates the fragment (with the
   *  optional crop), later tags annotate that same fragment — never a second one, even if clicked
   *  before the first create's server round-trip lands (those queue and drain on the next fetch).
   *  `silent` suppresses the failure alert (for the implicit apply-on-select of the default tag). */
  annotateRegion: (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean }) => void;
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
  const create = (selector: Record<string, unknown> | null, tag: TagRef, opts?: { silent?: boolean; imageBase64?: string }) => {
    const entry = { path: "(pending)", selector: selector ?? undefined, tag } as Annotation;
    setOptimistic((o) => [...o, entry]);
    // An IMPLICIT save (clicking away with the pre-selected tag) is best-effort — e.g. the
    // default tag may not exist in this tree — so it rolls back QUIETLY (opts.silent).
    createAnnotation(path, selector, tag, opts?.imageBase64).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
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

  const annotateRegion = (selector: Record<string, unknown>, tag: TagRef, opts?: { imageBase64?: string; silent?: boolean }) => {
    const target = regionFragmentTarget(selector);
    if (target) { // the fragment already exists → just annotate it (a later tag)
      const entry = { path: "(pending)", selector, tag } as Annotation;
      setOptimistic((o) => [...o, entry]);
      annotate({ target, tag: tag.path }).then(refresh).catch((e) => rollback(entry, e, opts?.silent));
      return;
    }
    if (optimistic.some((x) => sameSelector(x.selector, selector))) { // first create in flight → queue
      const entry = { path: "(pending)", selector, tag } as Annotation;
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

/** Typeahead rank for a tag against the lowercased query `q` (lower is better): an exact name,
 *  then a name prefix, then a name substring, then matched only via the full path. */
function rankTag(t: TagRef, q: string): number {
  const n = t.name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

/** Expose a tag's colour to CSS as `--tag`, so a swatch / badge can render FILLED (applied) or
 *  HOLLOW (an outline in that colour, not applied) from one stylesheet rule — no per-state ring. */
export const tagStyle = (color: string): React.CSSProperties => ({ ["--tag"]: color } as React.CSSProperties);

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
export function AnnotationMenu({
  x, y, applied, nodeTags = [], mode, onPick, onUnpick, onCopy, onClose, menuRef, actions,
}: {
  x: number; y: number; applied: TagRef[]; nodeTags?: TagRef[]; mode: "create" | "edit";
  onPick: (t: TagRef) => void; onUnpick?: (t: TagRef) => void;
  onCopy?: () => void; onClose: () => void;
  menuRef?: React.Ref<HTMLDivElement>;
  /** Extra command entries shown at the top of the menu (e.g. "＋ New subchapter"). */
  actions?: { label: string; onClick: () => void }[];
}) {
  const colorTags = useColorTags();
  const tagIndex = useTagIndex(); // all named tags (whole tree) — the typeahead searches these
  const tagsLoc = useConfigTagsLocation(); // the configured tags location → its tags show as default chips
  const [recents, setRecents] = useState(recentTags); // shown at once; pruned against the server
  const [path, setPath] = useState("");
  const [hi, setHi] = useState(-1); // highlighted suggestion (-1 = none)
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

  // The chips shown WITHOUT typing — the four sources, most-relevant first: (a) tags APPLIED to this
  // target, (b) tags borne by OTHER components of the same node (sibling fragments), (c) the
  // last-used / recent tags, (d) the project taxonomy — the grafted yamlover tags plus the
  // configured tags location. Tags elsewhere in the tree stay reachable via the typeahead.
  const scopedIndex = tagIndex.filter((t) => underAnyRoot(t.path, [...GRAFT_TAG_ROOTS, tagsLoc]));
  const defaultChips = dedupeNamed([...applied, ...nodeTags, ...recents, ...scopedIndex]);

  // Typeahead: while the user types, the chip row becomes a ranked filter over EVERY named tag
  // (name or full path substring) — so any tag, even outside the default scope, is one click away.
  const q = path.trim().toLowerCase();
  const view: TagRef[] = q
    ? dedupeNamed(
        [...applied, ...nodeTags, ...recents, ...tagIndex]
          .filter((t) => t.name.toLowerCase().includes(q) || canonPath(t.path).toLowerCase().includes(q))
          .map((t) => ({ t, rank: rankTag(t, q) }))
          .sort((a, b) => a.rank - b.rank || a.t.name.localeCompare(b.t.name))
          .map(({ t }) => t),
      ).slice(0, 8)
    : defaultChips;
  // Re-seat the highlight whenever the typed text changes (the filtered list derives from it).
  useEffect(() => { setHi(q ? (view.length ? 0 : -1) : -1); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply an arbitrary tag by its node path: fetch, verify it IS a tag, pick it. A bare NAME
  // (no `/`) that matches no node is CREATED at the project's tags location and then picked —
  // typing a fresh name is how a new named tag is born. A missed multi-segment path stays an
  // error: a typo'd path must not silently mint a tag named like a path. `raw` lets a chosen
  // suggestion route through the same fetch-verify (re-checking the tag still exists).
  const pickPath = (raw?: string) => {
    const p = (raw ?? path).trim();
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
  useLayoutEffect(() => {
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

  return (
    <div ref={setRefs} className="annotate-menu" style={{ left: pos.left, top: pos.top }} role="menu">
      {actions && actions.length > 0 && (
        <div className="annotate-actions">
          {actions.map((a) => (
            <button key={a.label} type="button" className="annotate-action" onClick={a.onClick}>{a.label}</button>
          ))}
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
      {onCopy && <button type="button" className="annotate-tool" title="copy text to clipboard (don't annotate)" onClick={onCopy}>⧉</button>}
      <button type="button" className="annotate-tool close" title="close" onClick={onClose}>✕</button>
      {view.length > 0 && (
        <div className="annotate-recents" role="listbox">
          {view.map((t, i) => (
            <span key={t.path} className="tagframe">
              <TagTip tag={t}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === hi}
                  className={"tagtag" + (isApplied(t.path) ? " on" : "") + (i === hi ? " hi" : "")}
                  style={tagStyle(resolveTagColor(t))}
                  onClick={() => toggle(t)}
                  onMouseEnter={() => { if (q) setHi(i); }}
                >
                  <span className="tt-label">{t.name}</span>
                </button>
              </TagTip>
            </span>
          ))}
        </div>
      )}
      <div className="annotate-typeahead">
        <input
          className="annotate-taginput"
          type="text"
          placeholder={busy ? "creating tag…" : `${verb}: filter, tag path, or new name… ⏎`}
          value={path}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            // Plain Arrow/Enter never reach App.tsx's global nav (it bails on focused inputs),
            // but guard anyway and keep the caret from jumping while we drive the list.
            if (view.length && e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setHi((i) => (i + 1) % view.length); return; }
            if (view.length && e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setHi((i) => (i - 1 + view.length) % view.length); return; }
            if (e.key === "Escape" && path) { e.preventDefault(); e.stopPropagation(); setPath(""); return; }
            if (e.key === "Enter") {
              e.preventDefault(); e.stopPropagation();
              if (hi >= 0 && view[hi]) toggle(view[hi]); // the highlighted tag wins
              else pickPath(); // else the typed path / create-on-miss
            }
          }}
        />
      </div>
    </div>
  );
}

/** An open region picker — keyed by its SELECTOR (the join into the material's annotations), not by
 *  a one-shot create/edit. `seedTag` is the pre-checked default shown while the region has no tags.
 *  `create` marks a freshly-DRAWN region (vs editing an existing one): only then does the synthetic
 *  preview keep the marquee up before the first tag — editing an existing region down to zero tags
 *  must let it disappear (untag). */
type OpenRegion = { selector: Record<string, unknown>; seedTag: TagRef; create: boolean; copy?: () => void; imageBase64?: string; x: number; y: number };

/** Drives the floating picker for a material's REGIONS: `openCreate` after a fresh selection,
 *  `openEdit` on a click on an existing mark — both open the SAME selector-keyed picker, so tagging
 *  is uniform: clicking a tag toggles it on/off the region and the menu STAYS open (multi-tag),
 *  closing only via the close button or outside-click. The first tag on a fresh region creates its
 *  fragment; later tags annotate that same one. Returns the `palette`, plus a `preview` (the seed
 *  tag's selector/color) so a renderer keeps the rectangle drawn UNTIL a real tag draws it instead. */
export function useAnnotationMenu(a: MaterialAnnotations): {
  openCreate: (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void, imageBase64?: string) => void;
  openEdit: (ann: Annotation, screen: { x: number; y: number }) => void;
  palette: ReactNode;
  preview: { selector: Record<string, unknown>; tag: TagRef; color: string } | null;
  color: string;
} {
  const [tag, setTag] = useAnnotationTag();
  const [open, setOpen] = useState<OpenRegion | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);

  // Selecting a region IS tagging it: open the picker AND apply the pre-checked tag at once (the
  // user's "apply immediately on open" — no extra click to commit the default). It becomes a real
  // application, so it shows checked and a click REMOVES it. openEdit (an existing region) opens
  // the same picker but applies nothing — the region already has its tags.
  const openCreate = (selector: Record<string, unknown>, screen: { x: number; y: number }, copy?: () => void, imageBase64?: string) => {
    setOpen({ selector, seedTag: tag, create: true, copy, imageBase64, x: screen.x, y: screen.y });
    a.annotateRegion(selector, tag, { imageBase64, silent: true });
  };
  const openEdit = (ann: Annotation, screen: { x: number; y: number }) =>
    setOpen({ selector: (ann.selector ?? {}) as Record<string, unknown>, seedTag: ann.tag ?? tag, create: false, x: screen.x, y: screen.y });

  // The region's tag applications, live from the material — toggles reflect at once (optimistic).
  // These ARE the outlined tags: an outlined tag is a real application, so clicking it removes it.
  const regionAnns = open ? a.annotations.filter((x) => sameSelector(x.selector, open.selector)) : [];
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
    setTag(t);
    if (applied.some((r) => canonPath(r.path) === canonPath(t.path))) return; // already applied (defensive)
    a.annotateRegion(open.selector, t, { imageBase64: open.imageBase64 });
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
      close();
    };
    // Both a real scrollbar scroll AND a wheel gesture close it: the image / map / PDF viewers
    // pan & zoom on `wheel` WITHOUT a `scroll` event (Leaflet transforms, pdf zoom), so a wheel
    // listener is what catches those. A wheel/scroll INSIDE the menu (its suggestion list) is kept.
    const onShift = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return; // scrolled INSIDE the menu
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
      onClose={close}
    />
  ) : null;

  // Keep the marquee drawn via a synthetic preview ONLY for a freshly-DRAWN region while it has no
  // real tag yet (so the rectangle you just dragged stays visible until its first tag draws it).
  // EDITING an existing region never previews — untagging it down to zero must let it vanish, not
  // re-draw a ghost that makes "uncheck all tags" look like a no-op.
  const preview = open && open.create && applied.length === 0
    ? { selector: open.selector, tag: open.seedTag, color: resolveTagColor(open.seedTag) }
    : null;
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
    const raf = requestAnimationFrame(() => highlight(el, annotations, path));
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
      // BOTH ends must sit inside the material — a selection that bleeds out (e.g. dragging from a
      // heading up into surrounding chrome) would capture off-content text whose `exact` is never
      // found in the body, leaving an un-highlightable, hard-to-delete phantom annotation.
      if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return;
      if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return;
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

  // No annotation count here — the RHS fragments panel is the canonical list of what's tagged.
  return (
    <div className="annotated">
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
    wrapFirst(container, a.selector.exact, a, materialPath);
  }
}

/** Wrap the first text occurrence of an annotation's `exact` (within one text node) in a colored,
 *  clickable `<mark>` carrying its identity key (so a click maps back to the annotation) and, for a
 *  fragment, its `#`-anchor id. A region with several tags is one mark: if the anchor id already
 *  exists in `container`, the region is already drawn — skip (and never duplicate the id). */
function wrapFirst(container: HTMLElement, exact: string, a: Annotation, materialPath: string): void {
  const fragId = a.fragmentSlug ? fragmentAnchorId(materialPath, a.fragmentSlug) : "";
  if (fragId && container.querySelector(`[id="${CSS.escape(fragId)}"]`)) return; // region already marked
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
    if (fragId) mark.id = fragId;
    mark.title = a.description || "click to re-tag or delete";
    try {
      range.surroundContents(mark); // works when the match is within one text node (v1)
      return;
    } catch {
      /* the snippet spans element boundaries — skip highlighting it for now */
    }
  }
}
