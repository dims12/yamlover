// ONE TOC-style row — the presentational element shared by the TOC tree (Tree.tsx) and the
// breadcrumb's completion dropdown, so both look identical by construction: `.tree-row` with
// the chevron toggle, the (type, format, concrete) icon glyph, and the clickable label.

import { DragEvent, MouseEvent, Ref, useState } from "react";
import { Chevron } from "./chevron";
import { useHoverPeek } from "../../../yed/src/hover-peek";
import { TreeNode } from "./api";
import { dragHasNode, endNodeDrag } from "./dnd";
import { typeIcon } from "./icons";
import { displayPath } from "./paths";

export interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selected?: boolean;
  match?: boolean; // a query-filter MATCH row (accented label)
  highlighted?: boolean; // the dropdown's keyboard/hover highlight
  merged?: boolean; // the node is VISIBLY rendered on the content pane (toc-presence)
  inView?: boolean; // …and its anchor sits inside the pane's viewport right now (the band)
  fragCurrent?: boolean; // …and is the one the URL #fragment names (the reading line)
  /** The expand control: a live chevron, a leaf spacer, or nothing (dropdown rows). */
  chevron?: { open: boolean; loading: boolean; onToggle: () => void } | "leaf" | "none";
  detail?: string; // dim right-hand note (operator rows: "any key", …)
  onSelect?: (e: MouseEvent) => void; // the click event rides along (e.detail routes dblclick)
  onContext?: (x: number, y: number) => void;
  /** The row is a drag SOURCE (an in-project node drag; see dnd.ts). */
  drag?: { onStart: (e: DragEvent) => void };
  /** The row is a drop TARGET (a directory): `canDrop` consults drop-policy for the
   *  current drag; a drop hands back the pointer spot for the confirm popup. */
  drop?: { canDrop: () => boolean; onDrop: (x: number, y: number) => void };
  rowRef?: Ref<HTMLDivElement>;
}

export function TreeRow({ node, depth, selected, match, highlighted, merged, inView, fragCurrent, chevron = "none", detail, onSelect, onContext, drag, drop, rowRef }: TreeRowProps) {
  const [over, setOver] = useState(false);
  const ti = typeIcon(node.type, node.format, node.concrete);
  const labelChildren = (
    <>
      {node.label}
      {/* the scalar self-value, dim after the label — the `large-icons` grid's `key: value`
          convention (explorer.tsx), so a list of plain values reads without opening each row */}
      {node.value != null && <span className="tree-value">{node.value}</span>}
    </>
  );
  // a label the sidebar clips grows a hover twin across the splitter instantly; the native
  // path tooltip above still fires on the browser's own delay
  const labelPeek = useHoverPeek({
    side: "extend-right",
    delayMs: 0,
    className: "hover-peek peek-toc",
    content: labelChildren,
    // headroom: the full sidebar plus half the content pane; past that, ellipsis
    maxWidthPx: (anchor, clip) => {
      const main = document.querySelector("main.pane.right")?.getBoundingClientRect().width ?? 0;
      return clip.right + main / 2 - anchor.left;
    },
  });
  const open = typeof chevron === "object" && chevron.open;
  // a folder (plain `dir` concrete) shows open vs closed like a normal file manager
  const glyph = open && ti.glyph === "📁" ? "📂" : ti.glyph;
  return (
    <div
      ref={rowRef}
      className={"tree-row" + (merged ? " merged" : "") + (inView ? " in-view" : "") + (selected ? " selected" : "") + (fragCurrent ? " frag-current" : "") + (match ? " match" : "") + (highlighted ? " hi" : "") + (over ? " drop-target" : "")}
      style={{ paddingLeft: depth * 14 + 4 }}
      onContextMenu={onContext ? (e) => { e.preventDefault(); onContext(e.clientX, e.clientY); } : undefined}
      draggable={!!drag}
      onDragStart={drag?.onStart}
      onDragEnd={drag ? () => endNodeDrag() : undefined}
      onDragOver={drop ? (e) => {
        if (!dragHasNode(e) || !drop.canDrop()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      } : undefined}
      // crossing the row's own label/icon spans fires dragleave too — only unhighlight on a real exit
      onDragLeave={drop ? (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setOver(false);
      } : undefined}
      onDrop={drop ? (e) => {
        if (!dragHasNode(e)) return;
        e.preventDefault();
        setOver(false);
        drop.onDrop(e.clientX, e.clientY);
      } : undefined}
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
          <Chevron />
        </button>
      ) : chevron === "leaf" ? (
        <span className="toggle leaf" />
      ) : null}
      <span className={"icon " + ti.cls} title={ti.title}>{glyph}</span>
      <span className="tree-label" onClick={onSelect} title={`${displayPath(node.path)} (${node.type})`} {...labelPeek.hoverProps}>
        {labelChildren}
        {labelPeek.overlay}
      </span>
      {detail && <span className="tree-row-detail">{detail}</span>}
    </div>
  );
}
