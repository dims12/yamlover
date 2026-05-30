import { useEffect, useRef, useState } from "react";
import { TreeNode } from "./api";
import { isActiveRenderer } from "./renderers/registry";
import { typeIcon } from "./icons";
import { isAncestorPath } from "./paths";

interface Props {
  node: TreeNode;
  current: string;
  onSelect: (path: string) => void;
  onLoadChildren: (path: string) => Promise<void>;
  depth?: number;
}

/**
 * One TOC branch. Every node is shown — scalar fields and array elements
 * included — and labeled by its title or key/index. A node is *expandable* when
 * it has children and no active renderer (object/array passive renderers don't
 * block expansion); past the initially loaded levels, children are fetched on
 * first expand. Selecting a row navigates the RHS.
 */
export function Tree({ node, current, onSelect, onLoadChildren, depth = 0 }: Props) {
  const expandable = node.hasChildren && !isActiveRenderer(node.type, node.format);
  const loaded = node.children.length > 0;
  // Loaded branches start open (so the first levels show expanded); a branch
  // whose children are not loaded yet starts closed and loads when opened.
  const [open, setOpen] = useState(loaded);
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

  const ti = typeIcon(node.type, node.format);

  const toggle = async () => {
    if (!open && expandable && !loaded) {
      setLoading(true);
      try {
        await onLoadChildren(node.path);
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
        <span className={"icon " + ti.cls} title={ti.title}>{ti.glyph}</span>
        <span className="tree-label" onClick={() => onSelect(node.path)} title={`${node.path} (${node.type})`}>
          {node.label}
        </span>
      </div>
      {open &&
        node.children.map((c) => (
          <Tree
            key={c.path}
            node={c}
            current={current}
            onSelect={onSelect}
            onLoadChildren={onLoadChildren}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
