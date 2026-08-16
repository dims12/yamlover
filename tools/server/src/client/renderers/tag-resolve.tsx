// tag-resolve.tsx — resolving tag PATHS into display refs { path, name, color }, plus the
// inline chip row the chapter faces hang to the right of titles and chunks. Lives beside
// tag.tsx (the pure chip primitives) but apart from annotate.tsx (the picker) so the render
// paths never import the picker machinery — and no module cycle forms.

import { ReactNode, useEffect, useState } from "react";
import { TagRef, fetchNode } from "../api";
import { canonPath } from "../paths";
import { tagNameOf } from "../ontos";
import { TagBadges, TagLink, TagSwatch, isColorTagPath, resolveTagColor, tagStyle } from "./tag";

/** An OMNI node's scalar self-value (the `$yamloverMixed` marker) as its display title — a
 *  plain LEAF scalar's value is data, not a title, so only the value-plus-fields shape reads. */
function omniTitle(value: unknown): string | null {
  const m = (value as { $yamloverMixed?: { value?: unknown } } | null | undefined)?.$yamloverMixed;
  return m && typeof m.value === "string" && m.value !== "" ? m.value : null;
}

/** A tag node value's explicit `color`, from either projection shape (depth-limited projection
 *  may hand the color scalar as a `$yamloverLink` marker). Local twin of tag.tsx explicitColor —
 *  restated here so this module needs only the fetched value, not tagFields' import. */
function explicitColorOf(value: unknown): string | null {
  const fields =
    value && typeof value === "object" && !Array.isArray(value)
      ? ((value as { $yamloverMixed?: { entries?: { key: string | null; value: unknown }[] } }).$yamloverMixed?.entries?.map((e) => [e.key, e.value] as const) ??
        Object.entries(value as Record<string, unknown>))
      : [];
  const raw = fields.find(([k]) => k === "color")?.[1];
  if (typeof raw === "string") return raw;
  const linked = (raw as { $yamloverLink?: { value?: unknown } } | null | undefined)?.$yamloverLink?.value;
  return typeof linked === "string" ? linked : null;
}

// One fetch per distinct tag path per session — the chips re-render freely, the wire is hit
// once. A rejection is evicted so a transient miss (or a tag created moments later) retries.
const refCache = new Map<string, Promise<TagRef>>();

/** Resolve ANY node path into the tag ref shape { path, name, color }: the name is its omni
 *  scalar title, else its schema title, else its key inside the parent. Cached by path. */
export function tagRefOf(p: string): Promise<TagRef> {
  const key = canonPath(p);
  const hit = refCache.get(key);
  if (hit) return hit;
  const made = fetchNode(p, 1)
    .then((n) => ({ path: n.path, name: omniTitle(n.value) || n.title || tagNameOf(n.path), color: explicitColorOf(n.value) }))
    .catch((e) => {
      refCache.delete(key);
      throw e;
    });
  refCache.set(key, made);
  return made;
}

/** Tag paths as display links, immediately (name from the last segment, derived hue) and then
 *  settled once with each tag's resolved title + explicit color from the cached fetches. */
export function useResolvedTagLinks(paths: readonly string[]): TagLink[] {
  const key = paths.join("\n");
  const [resolved, setResolved] = useState<Map<string, TagRef>>(new Map());
  useEffect(() => {
    let cancelled = false;
    Promise.all(paths.map((p) => tagRefOf(p).catch(() => null))).then((refs) => {
      if (cancelled) return;
      setResolved(new Map(refs.filter((r): r is TagRef => r !== null).map((r) => [canonPath(r.path), r])));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return paths.map((p) => {
    const r = resolved.get(canonPath(p));
    return { path: p, label: r?.name ?? tagNameOf(p), color: r?.color ?? null };
  });
}

/**
 * The inline chip row: a node's membership tags rendered compact at the right of a title or
 * chunk. `inert` (the EDITOR face) makes every chip unfocusable and swallows mousedown, so
 * the caret never leaves the text the user is editing — chips there are display-only.
 */
export function InlineTagChips({ paths, onNavigate, inert }: { paths: readonly string[]; onNavigate: (path: string) => void; inert?: boolean }): ReactNode {
  const tags = useResolvedTagLinks(paths);
  if (tags.length === 0) return null;
  if (inert) {
    // no anchors, no tab stops, mousedown swallowed — the editor's caret never moves here
    return (
      <span onMouseDown={(e) => e.preventDefault()}>
        {tags.map((t) => {
          const color = resolveTagColor({ name: t.label, color: t.color });
          return isColorTagPath(t.path) ? (
            <TagSwatch key={t.path} color={color} title={t.label} />
          ) : (
            <span key={t.path} className="tagtag" style={tagStyle(color)} title={t.label}>{t.label}</span>
          );
        })}
      </span>
    );
  }
  return <TagBadges tags={tags} onNavigate={onNavigate} />;
}
