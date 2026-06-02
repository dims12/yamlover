import { useLayoutEffect, useRef, useState } from "react";
import { NodeJson } from "../api";
import { asLink } from "../render";
import { strToSegs } from "../paths";

const TAG_FORMAT = "x-yamlover-tag";

interface TagLink {
  path: string;
  label: string;
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
      tags.push({ path: link.path, label: tagLabel(link.path, link.title) });
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
          style={{ background: tagColor(t.label) }}
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
 *  `x-yamlover-tag`. */
function subtagsOf(node: NodeJson): TagLink[] {
  const v = node.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const out: TagLink[] = [];
  for (const child of Object.values(v as Record<string, unknown>)) {
    const link = asLink(child);
    if (link && link.format === TAG_FORMAT) out.push({ path: link.path, label: tagLabel(link.path, link.title) });
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

  return (
    <div className="tagview" ref={boxRef}>
      <svg className="tagwires" width={dim.w} height={dim.h}>
        {wires.map((w, i) => (
          <line key={i} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
        ))}
      </svg>

      <div className="tagrow tagrow-current">
        <div className="tagtag tagtag-current" style={{ background: tagColor(currentName) }} ref={currentRef}>
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
              style={{ background: tagColor(t.label) }}
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

      {node.description && <p className="tagdesc">{node.description}</p>}
    </div>
  );
}
