import { useEffect, useRef, useState } from "react";
import { Annotation, deleteAnnotation } from "./api";
import { fragmentAnchorId } from "./paths";
import { navigateToFragment } from "./renderers/headings";
import { READ_ONLY } from "./base";
import { TagBadges, TagLink } from "./renderers/tag";

/** A fragment's own node path (`<material>:.yo:fragments:<slug>`) — the delete-target FALLBACK
 *  when the wire carried no `fragmentPath` (the server's spelling always wins over this). */
function fragmentNodePath(materialPath: string, slug: string): string {
  return (materialPath === ":" ? "" : materialPath) + ":.yo:fragments:" + slug;
}

/** One row of the fragments panel: a tagged region of the current material, gathered across the
 *  annotations that share its `fragmentSlug` (a region can carry several tags). */
export interface FragmentGroup {
  slug: string;
  node?: string; // the CLIENT path of the node this fragment lives on (a CHUNK, else the material)
  fragmentPath?: string; // the fragment NODE's real path from the wire — the delete target
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
      g = { slug: a.fragmentSlug, node: a.node, fragmentPath: a.fragmentPath, selector: a.selector, imageUrl: a.imageUrl, tags: [] };
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

/** Quoted text for a prose fragment (CSS clamps the length). Region kinds (pdf/image/map) show
 *  their crop, not a type label. */
function fragmentExcerpt(g: FragmentGroup): string | null {
  const sel = g.selector;
  return sel?.type === "text" && typeof sel.exact === "string" ? sel.exact : null;
}

/** Delete-confirm popup — same anchored idiom as DropConfirm (fixed at the click, outside /
 *  Escape cancel, Enter confirms). */
function DeleteConfirm({ x, y, onConfirm, onCancel }: {
  x: number;
  y: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onConfirm, onCancel]);
  const left = Math.min(Number.isFinite(x) ? x : 0, Math.max(0, window.innerWidth - 280));
  const top = Math.min(Number.isFinite(y) ? y : 0, Math.max(0, window.innerHeight - 100));
  return (
    <div ref={ref} className="drop-confirm" role="dialog" aria-label="confirm delete" style={{ left, top }}>
      <div className="drop-confirm-text">Delete this fragment?</div>
      <div className="drop-confirm-actions">
        <button autoFocus onClick={onConfirm}>Delete</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** The RHS pane: the current entity's fragments, each with its tags. Clicking a row sets the URL
 *  hash to the fragment's `#/.yo/fragments/<slug>` anchor — the shared hash-scroll
 *  (headings.ts) and the Leaflet renderers then scroll/pan to and flash the region. Clicking a
 *  tag badge locates the same way (the default fragment click — it does not navigate to the
 *  tag). The trash DELETES the whole fragment after confirm (drops every tag — the server then
 *  removes the now-empty fragment node), which is also how an un-clickable phantom annotation
 *  gets cleaned up. Renders nothing when the entity has no fragments (drives the auto-hide in
 *  App). Collapsing is driven by the topbar toggle, like the TOC. */
export function Fragments({ path, groups, width }: {
  path: string;
  groups: FragmentGroup[];
  width: number;
  onNavigate?: (p: string) => void;
}) {
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ g: FragmentGroup; x: number; y: number } | null>(null);
  const reveal = (g: FragmentGroup) => {
    navigateToFragment(fragmentAnchorId(g.node ?? path, g.slug));
  };
  // Delete the fragment by removing every tag on it; the server drops the emptied fragment node and
  // the SSE diff refreshes App's annotation list (so this group falls away). Hide it at once.
  const removeFragment = async (g: FragmentGroup) => {
    setRemoving((s) => new Set(s).add(g.slug));
    const target = g.fragmentPath ?? fragmentNodePath(g.node ?? path, g.slug);
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
      <ul className="fragments-list">
        {visible.map((g) => {
          const excerpt = fragmentExcerpt(g);
          return (
            <li key={g.slug} className="fragment-row" onClick={() => reveal(g)}>
              {(g.imageUrl || excerpt) && (
                <button
                  type="button"
                  className="fragment-locate"
                  title="Scroll to this fragment"
                  onClick={() => reveal(g)}
                >
                  {g.imageUrl
                    ? <img className="fragment-thumb" src={g.imageUrl} alt="" />
                    : <span className="fragment-excerpt">{excerpt}</span>}
                </button>
              )}
              <div className="fragment-main">
                <div className="fragment-tags">
                  {g.tags.length > 0 && <TagBadges tags={g.tags} onNavigate={() => reveal(g)} />}
                </div>
                {!READ_ONLY && (
                  <button
                    type="button"
                    className="fragment-delete"
                    title="Delete this fragment"
                    aria-label="Delete this fragment"
                    onClick={(e) => { e.stopPropagation(); setPending({ g, x: e.clientX, y: e.clientY }); }}
                  >
                    🗑
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {pending && (
        <DeleteConfirm
          x={pending.x}
          y={pending.y}
          onConfirm={() => { const g = pending.g; setPending(null); void removeFragment(g); }}
          onCancel={() => setPending(null)}
        />
      )}
    </aside>
  );
}
