// PER-PROJECT RECENTS — the browser-local "bag of recent entries" behind the tag picker and
// the yamlover editor's inline `&`/`*` entry. Two independent lists per project: `bookmarks`
// (targets recently bookmarked — the picker and the `&` face share it) and `references`
// (targets recently pointed at — the `*` face). Stored in localStorage KEYED BY PROJECT
// (`settings.uri`, else the served root label), so two projects served from one origin never
// mix their vocabularies. Entries are TagRef-shaped ({ path, name, color }) — the picker's
// chips and the editor's bag rows read the same record.

import { useEffect, useState } from "react";
import { fetchConfig, fetchInfo, fetchNode, type TagRef } from "./api";
import { canonPath } from "./paths";
import { isColorTagPath } from "./renderers/tag";

export type RecentKind = "bookmarks" | "references";
export const MAX_RECENTS = 10;

const storageKey = (kind: RecentKind, project: string): string => `yo-recents:${kind}:${project}`;

// A change BROADCAST: every open surface redraws when a list is written (a tag applied in
// the picker shows up in the editor's bag at once, a forgotten entry disappears everywhere).
const listeners = new Set<() => void>();
const announce = (): void => { for (const l of [...listeners]) l(); };

// The project identity, resolved ONCE per session: the configured project URI, else the served
// root label, else a fixed local key (an unconfigured scratch tree still gets its own bag).
// `resolvedKey` mirrors the settled promise so later reads can be SYNCHRONOUS — the picker's
// chips show at once on every open after the first.
let keyPromise: Promise<string> | null = null;
let resolvedKey: string | null = null;
function projectKey(): Promise<string> {
  keyPromise ??= fetchConfig()
    .then((c) => (c.settings.uri ? encodeURIComponent(c.settings.uri) : fallbackKey()))
    .catch(fallbackKey)
    .then((k) => { resolvedKey = k; return k; });
  return keyPromise;
}
function fallbackKey(): Promise<string> {
  return Promise.resolve()
    .then(() => fetchInfo()) // wrapped: a throwing/absent fetchInfo still lands in the catch
    .then((i) => (i.root ? encodeURIComponent(i.root) : "local"))
    .catch(() => "local");
}

/** Reset the cached project key — tests mock /api/config and /api/info per-case, so the
 *  once-per-session cache must be droppable between them. */
export function _resetRecentsCacheForTests(): void {
  keyPromise = null;
  resolvedKey = null;
}

function parseList(raw: string | null): TagRef[] {
  try {
    const r = JSON.parse(raw || "[]") as TagRef[];
    if (Array.isArray(r)) {
      return r.filter((t) => typeof t?.path === "string" && t.path !== "" && typeof t?.name === "string" && canonPath(t.path) !== ":");
    }
  } catch { /* no/invalid list */ }
  return [];
}

/** The stored list, newest first. */
export async function readRecents(kind: RecentKind): Promise<TagRef[]> {
  return parseList(localStorage.getItem(storageKey(kind, await projectKey())));
}

/** File a just-used target at the head of the list (fire-and-forget — recording is a
 *  convenience, never a gate). The ROOT is refused (it can never be a bookmark/reference
 *  worth suggesting as one), and the color palette stays out of the `bookmarks` bag — the
 *  picker's swatch row already shows those. Deduped on the canonical path, capped. */
export function recordRecent(kind: RecentKind, ref: TagRef): void {
  if (canonPath(ref.path) === ":") return;
  if (kind === "bookmarks" && isColorTagPath(ref.path)) return;
  void projectKey().then((project) => {
    const key = storageKey(kind, project);
    const next = [ref, ...parseList(localStorage.getItem(key)).filter((r) => canonPath(r.path) !== canonPath(ref.path))].slice(0, MAX_RECENTS);
    localStorage.setItem(key, JSON.stringify(next));
    announce();
  });
}

/** FORGET one entry — the bag is a suggestion list, so a wrong or stale suggestion must be
 *  removable in place (right-click a chip / a bag row). Matched on the canonical path. */
export function forgetRecent(kind: RecentKind, path: string): void {
  void projectKey().then((project) => {
    const key = storageKey(kind, project);
    const next = parseList(localStorage.getItem(key)).filter((r) => canonPath(r.path) !== canonPath(path));
    localStorage.setItem(key, JSON.stringify(next));
    announce();
  });
}

// THE PANE PREFERENCE — is the recents pane shown? A per-SURFACE, device-local UI choice
// (not project data, so it is read synchronously and never keyed by project): the picker's
// chips pane and the editor's inline bag each remember their own ✕. A collapsed pane always
// leaves its header behind, so it can never be lost.
export type RecentsSurface = "picker" | "editor";
const paneKey = (s: RecentsSurface): string => `yo-recents-pane:${s}`;

export function recentsPaneOpen(s: RecentsSurface): boolean {
  try { return localStorage.getItem(paneKey(s)) !== "off"; } catch { return true; }
}
export function setRecentsPaneOpen(s: RecentsSurface, open: boolean): void {
  try { localStorage.setItem(paneKey(s), open ? "on" : "off"); } catch { /* private mode — the session's state still stands */ }
  announce();
}

/** The pane preference as React state (shared across every open surface through the
 *  broadcast, so closing it in one place collapses that surface everywhere at once). */
export function useRecentsPane(s: RecentsSurface): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => recentsPaneOpen(s));
  useEffect(() => {
    const sync = () => setOpen(recentsPaneOpen(s));
    listeners.add(sync);
    sync();
    return () => { listeners.delete(sync); };
  }, [s]);
  return [open, (v: boolean) => setRecentsPaneOpen(s, v)];
}

/** Drop entries whose node is GONE: the list outlives the nodes, so a deleted target would
 *  linger as a clickable chip forever. Survivors are written back. Existence is the whole
 *  test — any live node can be a target. */
export async function pruneRecents(kind: RecentKind): Promise<TagRef[]> {
  const key = storageKey(kind, await projectKey());
  const list = parseList(localStorage.getItem(key));
  const kept = await Promise.all(list.map((t) => fetchNode(t.path, 0).then(() => t).catch(() => null)));
  const live = kept.filter(Boolean) as TagRef[];
  if (live.length !== list.length) localStorage.setItem(key, JSON.stringify(live));
  return live;
}

/** The list as React state: the stored entries show at once; with `prune` the 404-checked
 *  survivors replace them quietly (the picker prunes on open; the editor's bag reads as-is —
 *  its entries were recorded on successful commits, and a dangling reference target is still
 *  a legitimate thing to point at again). */
export function useRecents(kind: RecentKind, opts?: { prune?: boolean }): TagRef[] {
  // with the project key already settled the stored list shows SYNCHRONOUSLY (no flash of
  // an empty chip row); the first-ever open in a session reads async
  const [list, setList] = useState<TagRef[]>(() =>
    (resolvedKey === null ? [] : parseList(localStorage.getItem(storageKey(kind, resolvedKey)))));
  const prune = opts?.prune === true;
  useEffect(() => {
    let on = true;
    const reread = () => { void readRecents(kind).then((r) => { if (on) setList(r); }); };
    reread();
    if (prune) void pruneRecents(kind).then((r) => { if (on) setList(r); });
    listeners.add(reread); // a record/forget anywhere redraws this surface
    return () => { on = false; listeners.delete(reread); };
  }, [kind, prune]);
  return list;
}
