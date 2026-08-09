import { memo, MouseEvent, useEffect, useRef, useState } from "react";
import { isDirConcrete } from "../concrete";
import { TreeNode } from "./api";
import { beginNodeDrag } from "./dnd";
import { tocView } from "./renderers/registry";
import { TreeRow } from "./TreeRow";
import { canonPath, isAncestorPath } from "./paths";
import { useTocPresence } from "./toc-presence";

/** In-project drag-drop wiring for the TOC: `canDrop` consults drop-policy against the
 *  current drag; a drop hands the target + pointer spot to the owner's confirm popup.
 *  Must be referentially STABLE (memoized by the owner) — Tree is memo'd against SSE churn. */
export interface TreeDnd {
  canDrop: (target: TreeNode) => boolean;
  onDropNode: (target: TreeNode, x: number, y: number) => void;
}

interface Props {
  node: TreeNode;
  current: string;
  onSelect: (path: string, e: MouseEvent) => void; // the click event routes dblclick vs in-page scroll
  onLoadChildren: (path: string, levels?: number) => Promise<void>;
  onContext?: (node: TreeNode, x: number, y: number) => void; // right-click → the node context menu
  dnd?: TreeDnd; // rows drag out; directory rows accept drops
  depth?: number;
  // Whether this branch STARTS open (default: only the depth-0 root row does). The TOC search
  // renders each result as its own depth-indented root — those must start collapsed.
  initialOpen?: boolean;
  // FILTER mode (the breadcrumb's query filter): the tree is a PRUNED one — matches + their
  // ancestors only. Every branch with pruned children arrives (and stays) expanded down to
  // the matches; match rows are marked. A match row's chevron still lazy-loads its REAL
  // children (spliced in by the filter owner's onLoadChildren).
  filterMode?: boolean;
}

/**
 * One TOC branch. Children are labeled by title or key/index. How a node appears
 * is the renderer's call (see `tocView`): by default all of its children, but
 * e.g. a chapter surfaces only its subchapters and keeps prose off the tree. A
 * node is *expandable* when it has such children; past the initially loaded
 * levels, children are fetched on first expand. Selecting a row navigates the RHS.
 */
// memo: App re-renders on every SSE task-progress frame (background indexing/hashing — several
// per second); the TOC must only re-render when its own props change.
export const Tree = memo(function Tree({ node, current, onSelect, onLoadChildren, onContext, dnd, depth = 0, initialOpen, filterMode }: Props) {
  // How this node presents in the TOC: the rows to show, whether it expands, and
  // whether those rows are loaded yet (a renderer may unwrap/filter; default is
  // the node's own children, fetched lazily on first expand).
  const { children: kids, expandable, loaded, loadDepth } = tocView(node);
  // Every branch starts COLLAPSED except the root row — expanding is the user's
  // act (or the reveal-the-selection effect below). Children being loaded says
  // nothing about visibility: an expand may fetch several levels at once
  // (`loadDepth`), and those deeper branches must not spring open with it.
  const [open, setOpen] = useState(filterMode ? kids.length > 0 : initialOpen ?? depth === 0);
  const [loading, setLoading] = useState(false);
  const selected = node.path === current;
  const onPath = isAncestorPath(node.path, current); // an ancestor of the selection
  const rowRef = useRef<HTMLDivElement>(null);
  // TOC PRESENCE (toc-presence.ts): each branch subscribes for ITSELF — no prop rides through
  // the memo'd chain, so SSE churn still bails at `memo` while presence changes re-render
  // exactly the subscribed branches. `merged` = visibly rendered on the content pane;
  // `fragCurrent` = the reading line. The reading line may name a node DEEPER than any TOC
  // row (the spy anchors every rendered line; the tree only holds loaded branches) — then
  // the nearest row that cannot hand off to a visible child carries the shade.
  const presence = useTocPresence();
  const key = canonPath(node.path);
  const merged = presence.base !== null && (presence.anchors.has(key) || presence.base === key);
  const cur = presence.currentPath;
  const onFragPath = cur !== null && isAncestorPath(node.path, cur);
  const deeperShown = cur !== null && open && kids.some((c) => c.path === cur || isAncestorPath(c.path, cur));
  const fragCurrent = cur !== null && (cur === key || (onFragPath && !deeperShown));

  // Reveal the selection: keep its ancestors open, and scroll it into view.
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  // …and the reading line (user-chosen: the TOC follows the scroll): ancestors of the
  // fragment-current node spring open too, so the moving shade is never hidden in a
  // collapsed branch. Only already-loaded branches are affected — nothing is fetched.
  useEffect(() => {
    if (onFragPath) setOpen(true);
  }, [onFragPath]);
  // Filter mode: a branch whose pruned children arrive later (a live query refinement)
  // springs open too — the filtered TOC is always expanded down to the matches.
  useEffect(() => {
    if (filterMode && kids.length > 0) setOpen(true);
  }, [filterMode, kids.length]);
  // The SAME component instances survive the normal↔filter tree swap (rows present in both
  // trees keep their keys), carrying `open` across. On each swap, reset it to the incoming
  // tree's baseline — filter: expanded down to the matches; normal: the root and the
  // selection's ancestors — so a branch the filter sprang open never leaves a stale open
  // chevron on a normal-tree row whose children may not even be loaded.
  const prevFilterMode = useRef(!!filterMode);
  useEffect(() => {
    if (prevFilterMode.current === !!filterMode) return;
    prevFilterMode.current = !!filterMode;
    setOpen(filterMode ? kids.length > 0 : (initialOpen ?? depth === 0) || onPath);
  }, [filterMode, kids.length, initialOpen, depth, onPath]);
  useEffect(() => {
    if (selected || fragCurrent) rowRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected, fragCurrent]);

  const toggle = async () => {
    if (!open && expandable && !loaded) {
      setLoading(true);
      try {
        await onLoadChildren(node.path, loadDepth);
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  };

  return (
    <div className="tree-branch">
      <TreeRow
        rowRef={rowRef}
        node={node}
        depth={depth}
        selected={selected}
        match={filterMode && !!node.match}
        merged={merged}
        fragCurrent={fragCurrent}
        chevron={expandable ? { open, loading, onToggle: toggle } : "leaf"}
        onSelect={(e) => onSelect(node.path, e)}
        onContext={onContext ? (x, y) => onContext(node, x, y) : undefined}
        drag={dnd && node.path !== ":" ? { onStart: (e) => beginNodeDrag(e, { path: node.path, concrete: node.concrete ?? null, label: node.label }) } : undefined}
        drop={dnd && isDirConcrete(node.concrete) ? { canDrop: () => dnd.canDrop(node), onDrop: (x, y) => dnd.onDropNode(node, x, y) } : undefined}
      />
      {open &&
        kids.map((c) => (
          <Tree
            key={c.path}
            node={c}
            current={current}
            onSelect={onSelect}
            onLoadChildren={onLoadChildren}
            onContext={onContext}
            dnd={dnd}
            depth={depth + 1}
            filterMode={filterMode}
          />
        ))}
    </div>
  );
});
