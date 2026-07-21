// ONE TOC-style row — the presentational element shared by the TOC tree (Tree.tsx) and the
// breadcrumb's completion dropdown, so both look identical by construction: `.tree-row` with
// the chevron toggle, the (type, format, concrete) icon glyph, and the clickable label.

import { Ref } from "react";
import { TreeNode } from "./api";
import { typeIcon } from "./icons";
import { displayPath } from "./paths";

export interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selected?: boolean;
  match?: boolean; // a query-filter MATCH row (accented label)
  highlighted?: boolean; // the dropdown's keyboard/hover highlight
  /** The expand control: a live chevron, a leaf spacer, or nothing (dropdown rows). */
  chevron?: { open: boolean; loading: boolean; onToggle: () => void } | "leaf" | "none";
  detail?: string; // dim right-hand note (operator rows: "any key", …)
  onSelect?: () => void;
  onContext?: (x: number, y: number) => void;
  rowRef?: Ref<HTMLDivElement>;
}

export function TreeRow({ node, depth, selected, match, highlighted, chevron = "none", detail, onSelect, onContext, rowRef }: TreeRowProps) {
  const ti = typeIcon(node.type, node.format, node.concrete);
  const open = typeof chevron === "object" && chevron.open;
  // a folder (plain `dir` concrete) shows open vs closed like a normal file manager
  const glyph = open && ti.glyph === "📁" ? "📂" : ti.glyph;
  return (
    <div
      ref={rowRef}
      className={"tree-row" + (selected ? " selected" : "") + (match ? " match" : "") + (highlighted ? " hi" : "")}
      style={{ paddingLeft: depth * 14 + 4 }}
      onContextMenu={onContext ? (e) => { e.preventDefault(); onContext(e.clientX, e.clientY); } : undefined}
    >
      {typeof chevron === "object" ? (
        <button
          className={"toggle" + (chevron.open ? " open" : "") + (chevron.loading ? " loading" : "")}
          onClick={chevron.onToggle}
          // expanding/collapsing must never STEAL FOCUS: while a query editor (breadcrumb /
          // reference cell / tag picker) is filtering the TOC, a focusing chevron click would
          // blur the cell and abandon the search — browsing the filtered tree is not a commit
          onMouseDown={(e) => e.preventDefault()}
          aria-label={chevron.open ? "collapse" : "expand"}
        >
          <span className="chevron">›</span>
        </button>
      ) : chevron === "leaf" ? (
        <span className="toggle leaf" />
      ) : null}
      <span className={"icon " + ti.cls} title={ti.title}>{glyph}</span>
      <span className="tree-label" onClick={onSelect} title={`${displayPath(node.path)} (${node.type})`}>
        {node.label}
      </span>
      {detail && <span className="tree-row-detail">{detail}</span>}
    </div>
  );
}
