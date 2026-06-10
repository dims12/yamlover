import { useLayoutEffect, useRef, useState } from "react";
import { NodeJson } from "../api";
import { asLink } from "../render";
import { strToSegs } from "../paths";

export const TAG_FORMAT = "x-yamlover-tag";

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
      {tags.map((t) => (
        <a
          key={t.path}
          className="tagtag"
          style={{ background: resolveTagColor({ name: t.label, color: t.color }) }}
          href={t.path}
          title={t.label}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(t.path);
          }}
        >
          {t.label}
        </a>
      ))}
    </>
  );
}

/** A tag's display name: its schema title, else its last path segment. */
function tagLabel(path: string, title?: string | null): string {
  if (title) return title;
  const segs = strToSegs(path);
  return segs.length ? String(segs[segs.length - 1]) : path;
}

/** The child tags of `node` — its one-level link-marker children whose format is
 *  `x-yamlover-tag` (read through either projection shape — see {@link tagFields}). */
function subtagsOf(node: NodeJson): TagLink[] {
  const out: TagLink[] = [];
  for (const [, child] of tagFields(node.value)) {
    const link = asLink(child);
    if (link && link.format === TAG_FORMAT) out.push({ path: link.path, label: tagLabel(link.path, link.title), color: link.color ?? null });
  }
  return out;
}

interface Wire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The renderer for an `object`/`x-yamlover-tag` node: the tag and the tags
 * beneath it. The current tag sits at the top and its **subtags** (tag children)
 * below, each a clickable badge wired to it with SVG lines drawn after layout.
 * The tag's *parent* is not drawn here — it shows in the header bar as a tag
 * badge (see {@link splitTagRefs}), the same way any node shows its tags.
 */
export function TagView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const subtags = subtagsOf(node);

  // ---- wiring: measure badge centers, draw connector lines ------------------
  const boxRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const subRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);
  const [dim, setDim] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      const cur = currentRef.current;
      if (!box || !cur) return;
      const o = box.getBoundingClientRect();
      const topMid = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - o.left, y: r.top - o.top };
      };
      const r = cur.getBoundingClientRect();
      const curBot = { x: r.left + r.width / 2 - o.left, y: r.bottom - o.top };
      const lines: Wire[] = [];
      for (const el of subRefs.current) if (el) {
        const t = topMid(el);
        lines.push({ x1: curBot.x, y1: curBot.y, x2: t.x, y2: t.y });
      }
      setDim({ w: o.width, h: o.height });
      setWires(lines);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [node.path, subtags.length]);

  const currentName = tagLabel(node.path, node.title);
  // a pure color tag shows its explicit color; a named tag its name-derived hue
  const currentColor = resolveTagColor({ name: currentName, color: explicitColor(node.value) });

  return (
    <div className="tagview" ref={boxRef}>
      <svg className="tagwires" width={dim.w} height={dim.h}>
        {wires.map((w, i) => (
          <line key={i} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
        ))}
      </svg>

      <div className="tagrow tagrow-current">
        <div className="tagtag tagtag-current" style={{ background: currentColor }} ref={currentRef}>
          {currentName}
        </div>
      </div>

      {subtags.length > 0 && (
        <div className="tagrow tagrow-sub">
          {subtags.map((t, i) => (
            <a
              key={t.path}
              ref={(el) => (subRefs.current[i] = el)}
              className="tagtag"
              style={{ background: resolveTagColor({ name: t.label, color: t.color }) }}
              href={t.path}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(t.path);
              }}
            >
              {t.label}
            </a>
          ))}
        </div>
      )}

      {(tagBody(node.value) ?? node.description) && <p className="tagdesc">{tagBody(node.value) ?? node.description}</p>}
    </div>
  );
}
