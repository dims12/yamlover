import type { CSSProperties } from "react";
import { asLink } from "../render";
import { canonPath, strToSegs } from "../paths";

export const TAG_FORMAT = "x-yamlover-tag";

/** Whether a tag node is one of the built-in PURE COLOR tags (the palette) — detected by its
 *  canonical path living under `tags:colors:` (the established color-palette location, also
 *  special-cased in annotate.tsx's `indexToRefs`/`rememberRecent`). Such tags render as a
 *  circular swatch wherever applied tags are listed, not as a name badge. */
export function isColorTagPath(path: string): boolean {
  return /(^|:)tags:colors:/.test(canonPath(path));
}

/** Expose a tag's colour to CSS as `--tag`. Every chip/swatch/dot paints through it — CSS renders
 *  `var(--tag-display)`, the colour re-inked for the active theme (see styles.css :root) — so no
 *  element ever sets a tag colour as a literal `background`/`border` of its own. */
export const tagStyle = (color: string): CSSProperties => ({ ["--tag"]: color } as CSSProperties);

/** A pure color tag rendered as a filled circular swatch — its color IS its identity, so a name
 *  badge would be redundant. Mirrors the menu palette's applied swatch (`.annotate-swatch.on`). */
export function TagSwatch({ color, title, onClick }: { color: string; title: string; onClick?: () => void }) {
  return (
    <span
      className="tagswatch"
      style={tagStyle(color)}
      title={title}
      role={onClick ? "button" : undefined}
      onClick={onClick}
    />
  );
}

export interface TagLink {
  path: string;
  label: string;
  color?: string | null; // a pure color tag's explicit color (else the hue derives from label)
}

/**
 * Split a node's `relations` into **tag references** (any up-edge that resolves to
 * an `x-yamlover-tag` node) and everything else. This includes the structural
 * `..` when the containment parent is itself a tag — so a tag shows its *parent
 * tag* in the bar, exactly as a paper shows the tags it is filed under. Tag
 * references render as badges (see {@link TagBadges}); the rest stay in the
 * ordinary relations panel.
 */
export function splitTagRefs(relations?: Record<string, unknown>): {
  tags: TagLink[];
  rest: Record<string, unknown>;
} {
  const tags: TagLink[] = [];
  const rest: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(relations || {})) {
    const link = asLink(v);
    if (link && link.format === TAG_FORMAT) {
      tags.push({ path: link.path, label: tagLabel(link.path, link.title), color: link.color ?? null });
    } else {
      rest[name] = v;
    }
  }
  return { tags, rest };
}

/** A stable color for a tag, derived from its name — so a tag is the same hue
 *  everywhere it appears. Mid lightness keeps white label text legible. */
export function tagColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 42%)`;
}

/** A tag's display color: its explicit `color` (a "pure color tag"), else the
 *  stable hue derived from its name. */
export function resolveTagColor(t: { name: string; color?: string | null }): string {
  return t.color ?? tagColor(t.name);
}

// A tag node's projected value arrives in one of two shapes: a plain object (a tag with only
// fields), or a `$yamloverMixed` marker (a tag whose description is its BODY — the variant/omni
// shape: `{kind:"omni", value: <body>, entries: [{key, value}]}`). The helpers below read both.
const MIXED_KEY = "$yamloverMixed";
type MixedMarker = { kind?: string; value?: unknown; entries?: { key: string | null; value: unknown }[] };

/** A tag value's keyed fields as [key, value] pairs — from either projection shape. */
export function tagFields(value: unknown): [string, unknown][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const marker = (value as Record<string, unknown>)[MIXED_KEY] as MixedMarker | undefined;
  if (marker?.entries) return marker.entries.filter((e) => e.key != null).map((e) => [e.key!, e.value]);
  return Object.entries(value as Record<string, unknown>);
}

/** A tag's BODY (its description — the node's own scalar value), or null. */
export function tagBody(value: unknown): string | null {
  if (typeof value === "string") return value;
  const marker = (value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as MixedMarker | undefined;
  return typeof marker?.value === "string" ? marker.value : null;
}

/** A tag node value's explicit `color`, if any. Depth-limited projection may hand the color
 *  scalar as a `$yamloverLink` marker instead of a plain string — both shapes are read. */
export function explicitColor(value: unknown): string | null {
  const raw = tagFields(value).find(([k]) => k === "color")?.[1];
  if (typeof raw === "string") return raw;
  const linked = (raw as { $yamloverLink?: { value?: unknown } } | null | undefined)?.$yamloverLink?.value;
  return typeof linked === "string" ? linked : null;
}

/** The tags a node is classified under, each a colored luggage-tag shape (one end
 *  rectangular, the other a pierced triangular point), shown inline in the node's
 *  header bar on every representation. Returns the tags directly (a fragment) so
 *  they flow among the header's type/format chips. */
export function TagBadges({ tags, onNavigate }: { tags: TagLink[]; onNavigate: (path: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((t) => {
        const color = resolveTagColor({ name: t.label, color: t.color });
        if (isColorTagPath(t.path)) {
          return <TagSwatch key={t.path} color={color} title={t.label} onClick={() => onNavigate(t.path)} />;
        }
        return (
          <a
            key={t.path}
            className="tagtag"
            style={tagStyle(color)}
            href={t.path}
            title={t.label}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(t.path);
            }}
          >
            {t.label}
          </a>
        );
      })}
    </>
  );
}

/** A node's display name: its schema title, else its last path segment. */
export function tagLabel(path: string, title?: string | null): string {
  if (title) return title;
  const segs = strToSegs(path);
  return segs.length ? String(segs[segs.length - 1]) : path;
}
