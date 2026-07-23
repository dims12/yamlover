// What TAB means, decided by the ENCLOSING format (format.ts).
//
//   chapter            Tab acts on the CURRENT block, never the previous one: a chunk BECOMES a
//                      subchapter title (wrap), a title nests its whole subchapter under an
//                      existing chapter sibling (indent). Shift-Tab mirrors it: a title dissolves
//                      back into a chunk (unwrap, its body splicing out after it), a chunk moves
//                      out of its enclosing subchapter (dedent). Wrap and unwrap are exact
//                      inverses, so Tab / Shift-Tab on the same block round-trips.
//   bullets / numbered the classic outliner move: the item becomes a child of the previous item,
//                      and an untagged container inside a list IS a sublist of the same kind.
//   row-cell           a pure caret move between the cells of a table, OneNote style: next cell,
//                      wrapping to the next row at a row's end, and appending a fresh row at the
//                      very last cell. No ops at all except that append.
//
// Chapter-Tab and list-Tab differ on purpose: a list item's identity is its POSITION under a
// parent item, so nesting under the previous sibling is what the user means there; a chapter
// block's identity is its own heading-ness, so Tab must promote THAT block, not conscript the
// previous one into being a title it never asked to be.

import type { MNode } from "../yamlover-editor/model";
import { findEntry } from "../yamlover-editor/model";
import { enclosingFormat, formatOfNode } from "./format";

export type TabIntent =
  /** move the entry under its previous sibling (a deeper subchapter / a sublist) */
  | { kind: "indent" }
  /** move the entry out of its parent, after it */
  | { kind: "dedent" }
  /** the CURRENT chunk becomes a subchapter title — a container with the text as its self line */
  | { kind: "wrap" }
  /** the CURRENT title dissolves back into a chunk — its body splices out after it */
  | { kind: "unwrap" }
  /** move the caret to another cell of the table — `entryId` is the cell to focus */
  | { kind: "cell"; entryId: string }
  /** append a row to `tableId` and put the caret in its first cell */
  | { kind: "appendRow"; tableId: string; columns: number }
  /** nothing sensible to do here — swallow the key rather than let the browser move focus */
  | { kind: "nop" };

/** What Tab (or Shift-Tab) should do for the entry the caret is in. Pure: reads the model, decides,
 *  and returns the intent — the host performs it. */
export function resolveTab(root: MNode, entryId: string, shift: boolean): TabIntent {
  const spine = findEntry(root, entryId);
  if (!spine) return { kind: "nop" };
  const where = enclosingFormat(root, entryId);
  if (where === "bullets" || where === "numbered") return shift ? { kind: "dedent" } : { kind: "indent" };
  if (where !== "row-cell") {
    // a chapter: Tab acts on the CURRENT block (see the header)
    const node = spine.entry.node;
    const isTitle = node.kind === "container";
    if (shift) return isTitle ? { kind: "unwrap" } : { kind: "dedent" };
    if (!isTitle) {
      // only a one-line chunk can become a self line (a title is one line by construction)
      const oneLine = node.kind === "scalar" && !node.scalar?.block && !String(node.scalar?.value ?? "").includes("\n");
      return oneLine ? { kind: "wrap" } : { kind: "nop" };
    }
    // a title goes DEEPER only under an existing chapter-shaped sibling — Tab never converts the
    // previous chunk into a title implicitly
    const { container, index } = spine.parents[spine.parents.length - 1];
    const prev = index > 0 ? container.entries[index - 1] : null;
    const prevIsChapter = !!prev && prev.node.kind === "container" && !prev.node.flow && formatOfNode(prev.node) === "chapter";
    return prevIsChapter ? { kind: "indent" } : { kind: "nop" };
  }

  // --- a table cell: walk the grid ---
  const parents = spine.parents;
  const row = parents[parents.length - 1].container;
  const cellIndex = parents[parents.length - 1].index;
  const table = parents[parents.length - 2].container;
  const rowEntry = parents[parents.length - 2];
  const rowIndex = rowEntry.index;

  if (shift) {
    if (cellIndex > 0) return { kind: "cell", entryId: row.entries[cellIndex - 1].id };
    const prevRow = previousRow(table, rowIndex);
    if (!prevRow) return { kind: "nop" }; // the first cell of the first row — never un-appends
    return { kind: "cell", entryId: prevRow.entries[prevRow.entries.length - 1].id };
  }
  if (cellIndex + 1 < row.entries.length) return { kind: "cell", entryId: row.entries[cellIndex + 1].id };
  const nextRow = nextRowOf(table, rowIndex);
  if (nextRow) return { kind: "cell", entryId: nextRow.entries[0].id };
  return { kind: "appendRow", tableId: table.id, columns: columnCount(table, row) };
}

/** A table's ROW entries are its keyless ones — `title` and `header` are keyed fields, not rows
 *  ($defs/table), even though they consume entry indices like everything else. */
const rowsOf = (table: MNode) => table.entries.filter((e) => e.key === null);

function previousRow(table: MNode, rowIndex: number): MNode | null {
  const before = table.entries.slice(0, rowIndex).filter((e) => e.key === null);
  const prev = before[before.length - 1];
  return prev && prev.node.entries.length ? prev.node : null;
}

function nextRowOf(table: MNode, rowIndex: number): MNode | null {
  const after = table.entries.slice(rowIndex + 1).find((e) => e.key === null);
  return after && after.node.entries.length ? after.node : null;
}

/** How wide a new row should be: the header's width when there is one, else the first row's, else
 *  the row we are leaving (mirroring the read renderer's column-count rule). */
function columnCount(table: MNode, current: MNode): number {
  const header = table.entries.find((e) => e.key === "header");
  if (header && header.node.entries.length) return header.node.entries.length;
  const first = rowsOf(table)[0];
  if (first && first.node.entries.length) return first.node.entries.length;
  return Math.max(current.entries.length, 1);
}

/** True where Tab would land in a table cell — the projection uses this to keep a Tab from
 *  reaching the browser's focus walk even when the intent turns out to be a nop. */
export function isTableCell(root: MNode, entryId: string): boolean {
  return enclosingFormat(root, entryId) === "row-cell";
}

/** The block a FORMAT command targets, given the caret's entry: standing in a list item retags the
 *  LIST (making the item a one-item list of its own would be nobody's intent), standing in a table
 *  cell retags the TABLE, and standing in a chapter paragraph retags that paragraph. */
export function formatTarget(root: MNode, entryId: string): string | null {
  const spine = findEntry(root, entryId);
  if (!spine) return null;
  const parents = spine.parents;
  const where = enclosingFormat(root, entryId);
  if (where === "bullets" || where === "numbered") return parents[parents.length - 1].container.id;
  if (where === "row-cell") return parents[parents.length - 2].container.id;
  if (where === "row") return parents[parents.length - 1].container.id;
  // a chapter paragraph, or a block that already carries a tag of its own
  return spine.entry.node.id;
}

/** True when `node` is a container the format bar should show as ACTIVE for `chosen`. */
export function isFormat(node: MNode, chosen: string): boolean {
  return formatOfNode(node) === chosen;
}
