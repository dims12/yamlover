import { useState } from "react";
import { Annotation, deleteAnnotation } from "./api";
import { fragmentAnchorId } from "./paths";
import { TagBadges, TagLink } from "./renderers/tag";

/** A fragment's own node path (`<material>:yamlover-fragments:<slug>`) — the delete target. */
function fragmentNodePath(materialPath: string, slug: string): string {
  return (materialPath === ":" ? "" : materialPath) + ":yamlover-fragments:" + slug;
}

/** One row of the fragments panel: a tagged region of the current material, gathered across the
 *  annotations that share its `fragmentSlug` (a region can carry several tags). */
export interface FragmentGroup {
  slug: string;
  selector?: Annotation["selector"];
  imageUrl?: string; // a crop blob for an image/pdf/djvu fragment
  tags: TagLink[];
}

/** Group a material's annotations into one row per fragment (by `fragmentSlug`), gathering each
 *  fragment's tags in first-seen order. Whole-node annotations (no `fragmentSlug`) are skipped —
 *  those are the entity's own tags and live in the toolbar, not here. */
export function fragmentGroups(anns: Annotation[]): FragmentGroup[] {
  const order: string[] = [];
  const bySlug = new Map<string, FragmentGroup>();
  for (const a of anns) {
    if (!a.fragmentSlug) continue;
    let g = bySlug.get(a.fragmentSlug);
    if (!g) {
      g = { slug: a.fragmentSlug, selector: a.selector, imageUrl: a.imageUrl, tags: [] };
      bySlug.set(a.fragmentSlug, g);
      order.push(a.fragmentSlug);
    } else {
      if (!g.selector && a.selector) g.selector = a.selector; // fill from whichever annotation carries it
      if (!g.imageUrl && a.imageUrl) g.imageUrl = a.imageUrl;
    }
    if (a.tag && !g.tags.some((t) => t.path === a.tag!.path)) {
      g.tags.push({ path: a.tag.path, label: a.tag.name, color: a.tag.color });
    }
  }
  return order.map((s) => bySlug.get(s)!);
}

/** The text shown for a fragment with no crop: a prose fragment's quoted text (CSS clamps the
 *  length), else a short kind label by selector type. */
function fragmentLabel(g: FragmentGroup): string {
  const sel = g.selector;
  if (sel?.type === "text" && typeof sel.exact === "string") return sel.exact;
  switch (sel?.type) {
    case "map": return "map region";
    case "pdf": return "PDF region";
    case "rect": return "image region";
    case "djvu": return "djvu region";
    default: return "fragment";
  }
}

/** The RHS pane: the current entity's fragments, each with its tags. Clicking a row sets the URL
 *  hash to the fragment's `#yamlover-fragments/<slug>` anchor — the shared hash-scroll
 *  (headings.ts) and the Leaflet renderers then scroll/pan to and flash the region. Clicking a tag
 *  badge navigates to that tag; the ✕ DELETES the whole fragment (drops every tag — the server then
 *  removes the now-empty fragment node), which is also how an un-clickable phantom annotation gets
 *  cleaned up. Renders nothing when the entity has no fragments (drives the auto-hide in App).
 *  Collapsing is driven by the topbar toggle, like the TOC. */
export function Fragments({ path, groups, width, onNavigate }: {
  path: string;
  groups: FragmentGroup[];
  width: number;
  onNavigate: (p: string) => void;
}) {
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const reveal = (slug: string) => {
    window.location.hash = "#" + fragmentAnchorId(path, slug);
  };
  // Delete the fragment by removing every tag on it; the server drops the emptied fragment node and
  // the SSE diff refreshes App's annotation list (so this group falls away). Hide it at once.
  const removeFragment = async (g: FragmentGroup) => {
    setRemoving((s) => new Set(s).add(g.slug));
    const target = fragmentNodePath(path, g.slug);
    try {
      for (const t of g.tags) await deleteAnnotation(target, t.path);
    } catch (e) {
      setRemoving((s) => { const n = new Set(s); n.delete(g.slug); return n; });
      window.alert("delete failed: " + (e as Error).message);
    }
  };
  const visible = groups.filter((g) => !removing.has(g.slug));
  if (visible.length === 0) return null;
  return (
    <aside className="pane fragments" style={{ width }}>
      <div className="fragments-head">
        <span className="fragments-title">Fragments</span>
        <span className="fragments-count">{visible.length}</span>
      </div>
      <ul className="fragments-list">
        {visible.map((g) => (
          <li key={g.slug} className="fragment-row">
            <div className="fragment-main">
              <button
                type="button"
                className="fragment-locate"
                title="Scroll to this fragment"
                onClick={() => reveal(g.slug)}
              >
                {g.imageUrl
                  ? <img className="fragment-thumb" src={g.imageUrl} alt="" />
                  : <span className="fragment-excerpt">{fragmentLabel(g)}</span>}
              </button>
              <button
                type="button"
                className="fragment-delete"
                title="Delete this fragment"
                aria-label="Delete this fragment"
                onClick={() => removeFragment(g)}
              >
                ✕
              </button>
            </div>
            {g.tags.length > 0 && (
              <div className="fragment-tags">
                <TagBadges tags={g.tags} onNavigate={onNavigate} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
