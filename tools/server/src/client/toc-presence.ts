// THE TOC PRESENCE BUS — the content pane tells the TOC which nodes are VISIBLY merged on the
// page right now (the whole tree as one yamlover view, a chapter inlining its subchapters,
// anything widened by ?depth=) and which one the URL #fragment currently names. The TOC shades
// the merged rows, shades the current one differently, and a click on a merged row scrolls
// in-page (navigateToFragment) instead of navigating.
//
// One module-level store, the format-bus pattern (chapter-editor/format-bus.ts): only one
// content page is mounted at a time, so a singleton is enough. The DOM is the ONLY path→id
// bridge — data views stamp document-rooted fragment ids while chapters stamp page-rooted
// anchorOf ids (which may be render SLOTS not derivable from any path), so the publisher
// SCANS the rendered pane rather than computing ids; the TOC never computes ids either.

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { canonPath, segsToStr, strToSegs } from "./paths";

export interface TocPresence {
  /** canonPath of the merged page's root; null = no merged view mounted (all rows plain). */
  base: string | null;
  /** canonPath → in-page anchor id, one entry per node VISIBLY rendered on the page. */
  anchors: ReadonlyMap<string, string>;
  /** `anchors` closed over ancestors (and `base`) — the TOC's even gray. A rendered leaf
   *  means its spine is on the page too; without this, only the stamped nodes shaded and
   *  a flat row's continuation leaves sat a step darker than their parents. */
  merged: ReadonlySet<string>;
  /** canonPath of the node the URL #fragment currently names (scroll spy / hash), or null. */
  currentPath: string | null;
  /** canonPaths of the nodes whose anchors are inside the pane's VIEWPORT right now — the
   *  on-screen band the TOC shades yellowish, updated on scroll settle. */
  visible: ReadonlySet<string>;
}

const EMPTY: TocPresence = { base: null, anchors: new Map(), merged: new Set(), currentPath: null, visible: new Set() };

/** Every anchored path plus each of its ancestors — one gray for the whole shown spine. */
function mergedOf(base: string, anchors: Map<string, string>): Set<string> {
  const out = new Set<string>([canonPath(base)]);
  for (const p of anchors.keys()) {
    out.add(p);
    const segs = strToSegs(p);
    for (let i = 1; i < segs.length; i++) out.add(segsToStr(segs.slice(0, i)));
  }
  return out;
}
let state: TocPresence = EMPTY;
let byId = new Map<string, string>(); // anchor id → canonPath (the reverse of `anchors`)
let currentFragId: string | null = null; // the last published fragment id, pre-resolution
const listeners = new Set<() => void>();

function emit(next: TocPresence): void {
  state = next;
  listeners.forEach((l) => l());
}

/** Resolve the held fragment id through the current reverse map. */
const resolveCurrent = (): string | null => (currentFragId !== null ? byId.get(currentFragId) ?? null : null);

/** The content pane publishes its rendered set. The SNAPSHOT ONLY SWAPS when something
 *  actually changed (base, an anchor entry, the resolved current path) — useSyncExternalStore
 *  consumers and the memo'd Tree branches must not re-render on an identical re-scan. */
export function publishPresence(base: string, anchors: Map<string, string>): void {
  byId = new Map<string, string>();
  for (const [p, id] of anchors) if (!byId.has(id)) byId.set(id, p);
  const currentPath = resolveCurrent();
  const same =
    state.base === base &&
    state.currentPath === currentPath &&
    state.anchors.size === anchors.size &&
    [...anchors].every(([p, id]) => state.anchors.get(p) === id);
  if (same) return;
  emit({ base, anchors, merged: mergedOf(base, anchors), currentPath, visible: state.visible });
}

/** The on-screen band: anchor IDS currently inside the pane's viewport, resolved to paths —
 *  LITERALLY the entries whose own line is on screen. Deliberately NOT closed over ancestors:
 *  shading an ancestor whose heading has scrolled off puts yellow above a run of unshaded
 *  siblings — the "split yellow" report. Literal visibility keeps the band one contiguous run
 *  (TOC order is document order). Swaps the snapshot only when the set actually changed. */
export function publishVisibleIds(ids: readonly string[], extraPaths: readonly string[] = []): void {
  const visible = new Set<string>();
  for (const id of ids) {
    const p = byId.get(id);
    if (p !== undefined) visible.add(p);
  }
  for (const p of extraPaths) visible.add(canonPath(p));
  if (visible.size === state.visible.size && [...visible].every((p) => state.visible.has(p))) return;
  emit({ ...state, visible });
}

/** The content pane clears the store on unmount — every TOC row goes plain. */
export function clearPresence(): void {
  byId = new Map();
  currentFragId = null;
  if (state !== EMPTY) emit(EMPTY);
}

/** The fragment feed (the scroll spy's settle, navigateToFragment, hash listeners). Held even
 *  when unresolved — a scan may catch up (a lazy subchapter landing) and resolve it then. */
export function publishCurrentFragment(id: string | null): void {
  currentFragId = id;
  const currentPath = resolveCurrent();
  if (currentPath === state.currentPath) return;
  emit({ ...state, currentPath });
}

/** The TOC rows subscribe here (each Tree branch for itself — no props ripple through App). */
export function useTocPresence(): TocPresence {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
    () => state,
  );
}

/** Imperative read for click handlers (App's onSelect routes without subscribing). */
export function getTocPresence(): TocPresence {
  return state;
}

/** Just the current path — a primitive snapshot, so a subscriber (App's reveal-the-fragment
 *  loader) re-renders only when the reading line actually moves, not on every re-scan. */
export function useTocCurrentPath(): string | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state.currentPath,
    () => state.currentPath,
  );
}

/** The hash as a fragment id (decoded, null when empty) — the seed for the current shade. */
const hashFragment = (): string | null => decodeURIComponent(window.location.hash.slice(1)) || null;

/**
 * The PRODUCER: scan `root` for the visibly rendered nodes and publish them. Re-scans on a
 * debounced MutationObserver — folds, ?depth= changes, lazy subchapter landings, and diff
 * refetches all reshape childList, and there is no other single signal for "the page's DOM
 * settled". `base` null (not a merged-capable view) publishes nothing and clears.
 *
 * The "REALLY RENDERED" rule (ids are deliberately duplicated on a chapter page — the ID LAW,
 * chapter-shared.tsx — so presence never trusts a bare id lookup):
 *   - a chapter chunk:     `.chunk[id][data-node-path]` — the shell of a rendered chunk;
 *   - a chapter section:   `section.chapter-sub[data-chapter-path]` with MORE THAN ONE child
 *     element (an inlined body = heading + body; a collapsed link-face = its lone heading),
 *     its id read off the section's own `.chapter-title`;
 *   - a data-view node:    `.frag-anchor[id][data-node-path]` (render.tsx stamps both).
 * First occurrence wins in document order when a path appears twice.
 */
export function useTocPresencePublisher(root: RefObject<HTMLElement | null>, base: string | null, dep: unknown): void {
  useEffect(() => {
    const el = root.current;
    if (base == null || !el) { clearPresence(); return; }
    const scan = (): void => {
      const map = new Map<string, string>();
      const put = (path: string | undefined, id: string | undefined | null): void => {
        if (!path || !id) return;
        const key = canonPath(path);
        if (!map.has(key)) map.set(key, id);
      };
      for (const c of el.querySelectorAll<HTMLElement>(".chunk[id][data-node-path]")) {
        put(c.dataset.nodePath, c.id);
      }
      for (const s of el.querySelectorAll<HTMLElement>("section.chapter-sub[data-chapter-path]")) {
        if (s.childElementCount <= 1) continue; // a lone heading is the LINK face, not a rendering
        put(s.dataset.chapterPath, s.querySelector<HTMLElement>(":scope > .chapter-title[id]")?.id);
      }
      for (const a of el.querySelectorAll<HTMLElement>(".frag-anchor[id][data-node-path]")) {
        put(a.dataset.nodePath, a.id);
      }
      publishPresence(canonPath(base), map);
    };
    // The ON-SCREEN BAND: which anchors sit inside the pane's viewport right now. Same walk
    // the scroll spy does; ids the presence map doesn't know (chunk shells' duplicates, SVG
    // internals) simply don't resolve. Runs after every scan and on scroll settle.
    const visScan = (): void => {
      const paneRect = (el.closest(".pane") ?? document.documentElement).getBoundingClientRect();
      const inPane = (node: HTMLElement): boolean => {
        const r = node.getBoundingClientRect();
        return r.bottom >= paneRect.top && r.top <= paneRect.bottom && (r.height > 0 || r.width > 0);
      };
      const ids: string[] = [];
      for (const a of el.querySelectorAll<HTMLElement>("[id]")) {
        if (a.closest("svg")) continue;
        if (inPane(a)) ids.push(a.id);
      }
      // a FLAT row (docs/language/flattening) writes several keys on ONE line; the official
      // `#` id stamps once (first occurrence), so later repeats (`human1: age: 30`) would
      // leave the prefix unshaded. The row lists every segment path; if the LINE is on
      // screen they all yellow.
      const extra: string[] = [];
      for (const row of el.querySelectorAll<HTMLElement>("[data-flat-paths]")) {
        if (!inPane(row)) continue;
        for (const p of (row.dataset.flatPaths ?? "").split(/\s+/)) if (p) extra.push(p);
      }
      publishVisibleIds(ids, extra);
    };
    scan(); // effects run post-commit: synchronously-rendered content is already in the DOM
    visScan();
    publishCurrentFragment(hashFragment()); // a deep link's fragment shades from the start
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rescan = (): void => { clearTimeout(timer); timer = setTimeout(() => { scan(); visScan(); }, 200); };
    const mo = new MutationObserver(rescan); // our scan never mutates the DOM — no feedback
    mo.observe(el, { childList: true, subtree: true });
    let visTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (): void => { clearTimeout(visTimer); visTimer = setTimeout(visScan, 180); };
    window.addEventListener("scroll", onScroll, true); // capture: the scrolling box is a .pane
    window.addEventListener("resize", onScroll);
    // a PURE layout shift — content above the viewport growing or collapsing with no scroll
    // event and no childList change — still moves what's on screen; the content root's size
    // is the one signal that always accompanies it
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    const onHash = (): void => publishCurrentFragment(hashFragment());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      clearTimeout(timer);
      clearTimeout(visTimer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      clearPresence();
    };
  }, [root, base, dep]);
}
