import { memo, useEffect, useRef, useState } from "react";
import { TreeNode } from "./api";
import { tocView } from "./renderers/registry";
import { typeIcon } from "./icons";
import { isAncestorPath, displayPath } from "./paths";

interface Props {
  node: TreeNode;
  current: string;
  onSelect: (path: string) => void;
  onLoadChildren: (path: string, levels?: number) => Promise<void>;
  onContext?: (node: TreeNode, x: number, y: number) => void; // right-click → the node context menu
  depth?: number;
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
export const Tree = memo(function Tree({ node, current, onSelect, onLoadChildren, onContext, depth = 0 }: Props) {
  // How this node presents in the TOC: the rows to show, whether it expands, and
  // whether those rows are loaded yet (a renderer may unwrap/filter; default is
  // the node's own children, fetched lazily on first expand).
  const { children: kids, expandable, loaded, loadDepth } = tocView(node);
  // Every branch starts COLLAPSED except the root row — expanding is the user's
  // act (or the reveal-the-selection effect below). Children being loaded says
  // nothing about visibility: an expand may fetch several levels at once
  // (`loadDepth`), and those deeper branches must not spring open with it.
  const [open, setOpen] = useState(depth === 0);
  const [loading, setLoading] = useState(false);
  const selected = node.path === current;
  const onPath = isAncestorPath(node.path, current); // an ancestor of the selection
  const rowRef = useRef<HTMLDivElement>(null);

  // Reveal the selection: keep its ancestors open, and scroll it into view.
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const ti = typeIcon(node.type, node.format, node.concrete);
  // a folder (plain `dir` concrete) shows open vs closed like a normal file manager
  const glyph = open && ti.glyph === "📁" ? "📂" : ti.glyph;

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
      <div
        ref={rowRef}
        className={"tree-row" + (selected ? " selected" : "")}
        style={{ paddingLeft: depth * 14 + 4 }}
        onContextMenu={onContext ? (e) => { e.preventDefault(); onContext(node, e.clientX, e.clientY); } : undefined}
      >
        {expandable ? (
          <button
            className={"toggle" + (open ? " open" : "") + (loading ? " loading" : "")}
            onClick={toggle}
            aria-label={open ? "collapse" : "expand"}
          >
            <span className="chevron">›</span>
          </button>
        ) : (
          <span className="toggle leaf" />
        )}
        <span className={"icon " + ti.cls} title={ti.title}>{glyph}</span>
        <span className="tree-label" onClick={() => onSelect(node.path)} title={`${displayPath(node.path)} (${node.type})`}>
          {node.label}
        </span>
      </div>
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
          />
        ))}
    </div>
  );
});
