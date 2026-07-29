// THE CHAPTER WALK — every caret stop the chapter projection draws, in reading order. The
// chapter's own filter/collapse of the source walk (positionsOf): keyed fields other than
// `description` do not exist here, read-only chunks and atoms collapse to ONE stop, and a
// SOURCE chunk (format.ts chunkModeOf "source") keeps its FULL source sub-walk — the caret
// crosses into the source grammar's positions and back out.
//
// THE POSITIONS LAW (cells.tsx): a chapter cell must draw a focusable cell for every position
// this walk yields in its subtree — a position no cell draws must not exist.

import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Document, Node, Path, Value } from "../state";
import { positionsOf, type Position } from "../apply";
import { chunkModeOf, hasSelfValue, isChapterContainer } from "./format";

/** A node REACHED AS A CHAPTER shows its scalar self as the title — uniformly: the mount root
 *  and every subchapter alike (whether it is a chunk or a title-only chapter is the PARENT
 *  context's call, and walkChapter is only ever entered for chapter-mode nodes). A null self
 *  with no authored raw is NO title (the empty document; titles have no placeholder cells). */
const isTitled = hasSelfValue;

/** Every chapter caret stop, in the order the projection draws them. */
export function chapterPositionsOf(doc: Document): Position[] {
  const out: Position[] = [];
  walkChapter(doc.root, [], out);
  return out;
}

/** A chapter-mode container: title (always drawn first), then entries in source order —
 *  `description` as the subtitle, keyless entries as body chunks, other keyed fields skipped.
 *  A chapter with no BODY entries draws the bootstrap paragraph (`into`). */
function walkChapter(v: Value, path: Path, out: Position[]): void {
  if (isTitled(v)) out.push({ at: "token", path });
  const entries = (isPointer(v) ? [] : ((v as Node).entries ?? []));
  let body = 0;
  entries.forEach((e, i) => {
    const p = [...path, i];
    if (e.key === "description" && ((e.meta ?? {}) as { anchorKey?: string }).anchorKey === undefined) {
      out.push({ at: "token", path: p });
      return;
    }
    // KEYED chunks are body content too (a chunk may carry a key — the gutter shows it)
    body++;
    walkChunk(e.value, p, out);
  });
  if (body === 0) out.push({ at: "into", path }); // the bootstrap paragraph
}

function walkChunk(v: Value, path: Path, out: Position[]): void {
  switch (chunkModeOf(v)) {
    case "prose":
    case "latex":
      out.push({ at: "token", path });
      return;
    case "atom":
    case "readonly":
      out.push({ at: "ptr", path });
      return;
    case "chapter":
      walkChapter(v, path, out);
      return;
    case "bullets":
    case "numbered":
      walkList(v as Node, path, out);
      return;
    case "table":
      walkTable(v as Node, path, out);
      return;
    case "source":
      // the source projection's own walk, verbatim, re-based under this path
      for (const pos of positionsOf({ root: v } as Document)) {
        out.push({ ...pos, path: [...path, ...pos.path] } as Position);
      }
      return;
  }
}

/** List items: an omni item's own text above its sublist; untagged nested containers are
 *  sublists of the same kind at any depth. Keyed fields of a list are skipped. */
function walkList(list: Node, path: Path, out: Position[]): void {
  (list.entries ?? []).forEach((e, i) => {
    if (e.key !== null) return;
    const p = [...path, i];
    const item = e.value;
    if (!isChapterContainer(item)) { walkChunk(item, p, out); return; }
    const n = item as Node;
    if (n.kind === "scalar") out.push({ at: "token", path: p }); // the item's own text
    walkList(n, p, out); // its sublist (inherits the kind)
    if ((n.entries ?? []).length === 0 && n.kind !== "scalar") out.push({ at: "into", path: p });
  });
}

/** Table stops: the keyed `title`, the `header` cells, then every row's cells — all tokens.
 *  Rows/cells are exactly two levels ($defs/table). */
function walkTable(table: Node, path: Path, out: Position[]): void {
  (table.entries ?? []).forEach((e, i) => {
    const p = [...path, i];
    if (e.key === "title") { out.push({ at: "token", path: p }); return; }
    if (e.key === "header" || e.key === null) {
      const row = e.value;
      if (isPointer(row) || (row as Node).kind === "blob") { out.push({ at: "ptr", path: p }); return; }
      const cells = (row as Node).entries ?? [];
      // a SCALAR row is its own single cell (the ▦-promoted paragraph, a retagged list item)
      if ((row as Node).kind === "scalar" && cells.length === 0) { out.push({ at: "token", path: p }); return; }
      if (cells.length === 0) { out.push({ at: "into", path: p }); return; }
      cells.forEach((c, j) => {
        const cp = [...p, j];
        const cell = c.value;
        // a CONTAINER cell hosts chunks — every keyless entry is its own stop
        if (!isPointer(cell) && ((cell as Node).kind === "mapping" || ((cell as Node).entries ?? []).length > 0)) {
          ((cell as Node).entries ?? []).forEach((cc, k) => { if (cc.key === null) out.push({ at: "token", path: [...cp, k] }); });
          return;
        }
        out.push({ at: "token", path: cp });
      });
    }
  });
}

/** The index of `pos` in `list`, or -1 (paths compare structurally). */
export function positionIndex(list: Position[], pos: Position): number {
  return list.findIndex((p) => p.at === pos.at && p.path.length === pos.path.length && p.path.every((s, i) => s === pos.path[i]));
}
