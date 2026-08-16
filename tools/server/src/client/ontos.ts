// THE PROJECT'S ONTO VOCABULARY — the named tags a target can be filed under, and the ONE
// rule for which of them are offered without typing. Shared by the two surfaces that file
// memberships: the tag picker's chips (renderers/annotate.tsx) and the yamlover editor's `&`
// bag (renderers/yed-cells.tsx) — a bookmark IS a tag application, so both must suggest the
// same vocabulary. Anything else in the tree stays reachable through the query cells.

import { query, fetchConfig, type TagRef } from "./api";
import { canonPath, strToSegs } from "./paths";
import { isColorTagPath } from "./renderers/tag";

// Every NAMED tag in the project: a document-root recursive descent, format-filtered
// (docs/language/pointers/queries/idioms "all tag nodes"). Document-root scope finds tags
// wherever `settings.ontos` puts them — the client need not know that path.
export const ONTO_QUERY = ": ...: !!<format: x-yamlover-onto>";

// The roots whose tags are offered AS SUGGESTIONS without typing: the grafted yamlover
// self-import taxonomy (always present) plus the project's CONFIGURED tags location.
export const GRAFT_ONTO_ROOTS = [":yamlover:ontos", "::yamlover:ontos"];

/** A tag's display name from its node path (its last segment). */
export function tagNameOf(path: string): string {
  const segs = strToSegs(path);
  return segs.length ? String(segs[segs.length - 1]) : path;
}

export function indexToRefs(paths: string[]): TagRef[] {
  // A tag is just a NODE at a real path — keep each path AS-IS (no namespace rewriting). A
  // project's OWN tags (`:ontos:…`) and the GLOBAL self-import tags (`:yamlover:ontos:…`) are
  // DISTINCT nodes and BOTH belong in the picker (IMPORTS.md). Dedup only EXACT duplicates
  // (one node spelled two scope-ways), and drop the color palette (it is the swatch row).
  const byKey = new Map<string, string>();
  for (const p of paths) {
    if (isColorTagPath(p)) continue;
    const key = canonPath(p);
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return [...byKey.values()].map((p) => ({ path: p, name: tagNameOf(p), color: null }));
}

/** Whether `path` is at-or-under one of `roots` (segment-boundary aware, scope-tolerant). */
export function underAnyRoot(path: string, roots: (string | null)[]): boolean {
  const cp = canonPath(path);
  return roots.some((r) => { if (!r) return false; const rc = canonPath(r); return cp === rc || cp.startsWith(rc + ":"); });
}

/** The SUGGESTABLE tags: the project index filtered to the graft roots + the configured
 *  location. Cached per session and invalidated by {@link invalidateOntos} (an SSE `.yo`
 *  diff — a freshly created tag must appear), so a surface can ask on every keystroke. */
let ontosPromise: Promise<TagRef[]> | null = null;
export function projectOntos(): Promise<TagRef[]> {
  ontosPromise ??= Promise.all([
    query(ONTO_QUERY).catch(() => [] as string[]),
    fetchConfig().then((c) => c.settings.ontos ?? null).catch(() => null),
  ]).then(([paths, loc]) => indexToRefs(paths).filter((t) => underAnyRoot(t.path, [...GRAFT_ONTO_ROOTS, loc])));
  return ontosPromise;
}
export function invalidateOntos(): void {
  ontosPromise = null;
}
