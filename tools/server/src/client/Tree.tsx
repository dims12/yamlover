import { memo, useEffect, useRef, useState } from "react";
import { TreeNode } from "./api";
import { tocView } from "./renderers/registry";
import { TreeRow } from "./TreeRow";
import { isAncestorPath } from "./paths";

interface Props {
  node: TreeNode;
  current: string;
  onSelect: (path: string) => void;
  onLoadChildren: (path: string, levels?: number) => Promise<void>;
  onContext?: (node: TreeNode, x: number, y: number) => void; // right-click → the node context menu
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
export const Tree = memo(function Tree({ node, current, onSelect, onLoadChildren, onContext, depth = 0, initialOpen, filterMode }: Props) {
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

  // Reveal the selection: keep its ancestors open, and scroll it into view.
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
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
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);

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
        chevron={expandable ? { open, loading, onToggle: toggle } : "leaf"}
        onSelect={() => onSelect(node.path)}
        onContext={onContext ? (x, y) => onContext(node, x, y) : undefined}
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
            depth={depth + 1}
            filterMode={filterMode}
          />
        ))}
    </div>
  );
});
