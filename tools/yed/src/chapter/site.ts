// THE CHAPTER SITE — everything the chapter grammar may branch on; nothing else may.
// (The chapter mirror of grammar/dispatch.ts `Site`.) Model-derived fields come from the doc +
// the focused position; caret-edge fields come from the DOM (the cell passes them with the key).

import { isPointer, type Pointer } from "../../../parser/ts/src/ir.ts";
import type { Document, Node, Path, Value } from "../state";
import { nodeAt } from "../state";
import type { Position } from "../apply";
import { chunkModeOf, currentChosenFormat, declaredFormat, enclosingFormat, formatOfNode, isChapterContainer, type BlockFormat } from "./format";

export interface ChapterSite {
  /** The cell kind the caret stands in. `source` = inside a source chunk's subtree — the
   *  chapter grammar declines and the SOURCE grammar owns the key. */
  cell: "title" | "description" | "prose" | "listItem" | "tableCell" | "boot" | "atom" | "source";
  /** The format of the container the focused ENTRY lives in (spine-derived). */
  enclosing: BlockFormat;
  /** A one-line prose chunk (only those can wrap into a title / take the T role). */
  oneLine: boolean;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  caretFirstLine: boolean;
  caretLastLine: boolean;
  /** The focused title is the DOCUMENT root's (never indents, never unwraps). */
  isRootTitle: boolean;
  /** A title whose previous sibling is a non-flow chapter-shaped container (Tab nests under it). */
  prevSiblingIsChapter: boolean;
  /** A list item with a previous sibling item (the indent gate). */
  hasPrevItem: boolean;
  /** A prose chunk below the root level (the dedent gate). */
  belowRoot: boolean;
  /** A materialized (linked / anchored) subchapter — Shift-Tab nops (no inlining verb in v1). */
  materialized: boolean;
  /** The focused TITLE's subtree may be RE-ROOTED as inline content (Tab's indent) —
   *  see {@link moveSafeValue}. False refuses the move instead of silently corrupting. */
  movable: boolean;
  /** The title's enter-walk lands in a TYPEABLE cell (description / prose / list / table /
   *  boot); false when the first body chunk is a subchapter heading or an atom — Enter must
   *  INSERT a fresh paragraph there instead of walking into something it cannot type into. */
  firstChunkWalkable: boolean;
  /** Where a table-cell caret stands for the Tab walk. */
  tableEdge: "midRow" | "rowEnd" | "lastCell" | null;
  /** The very first cell of a table (Shift-Tab never un-appends). */
  atFirstCell: boolean;
  /** The first cell of THIS row (a scalar row's single cell counts) — the unwind ladder's
   *  row boundary. */
  atRowStart: boolean;
  /** Every cell of THIS row is an empty prose scalar — Backspace at the row's first position
   *  deletes the whole row. */
  rowEmpty: boolean;
  /** The table still has only ONE walkable row — Tab at its end adds a COLUMN (the creation
   *  flow); once a second row exists the column count is FIXED. */
  singleRow: boolean;
  /** ANY strict ancestor is a declared table — Ctrl+Enter appends a row from a cell's inner
   *  chunks too, not only from the cell itself. */
  inTable: boolean;
  /** The focused PROSE chunk is EMPTY (a childless scalar with no text) — Backspace at its
   *  start deletes the CHUNK (the deletion law); a non-empty chunk keeps joinPrev. */
  chunkEmpty: boolean;
  /** The FORMAT TARGET's current chosen format (the bar's highlight; re-choosing it is idle). */
  currentFormat: "chapter" | "table" | "bullets" | "numbered" | null;
}

export interface ChapterEdges {
  atStart?: boolean;
  atEnd?: boolean;
  firstLine?: boolean;
  lastLine?: boolean;
}

const entryHolding = (doc: Document, path: Path) => {
  if (path.length === 0) return null;
  const parent = nodeAt(doc, path.slice(0, -1));
  const e = parent?.entries?.[path[path.length - 1]];
  return parent && e ? { parent, entry: e, index: path[path.length - 1] } : null;
};

/** Is `path` inside (strictly below or at) a SOURCE chunk's subtree? */
export function inSourceChunk(doc: Document, path: Path): boolean {
  for (let i = 1; i <= path.length; i++) {
    const anc = nodeAt(doc, path.slice(0, i));
    if (anc && chunkModeOf(anc) === "source") return true;
  }
  return false;
}

export function chapterSiteOf(doc: Document, focus: Position | null, edges: ChapterEdges = {}): ChapterSite {
  const base: ChapterSite = {
    cell: "boot", enclosing: "chapter", oneLine: false,
    caretAtStart: edges.atStart ?? false, caretAtEnd: edges.atEnd ?? false,
    caretFirstLine: edges.firstLine ?? false, caretLastLine: edges.lastLine ?? false,
    isRootTitle: false, prevSiblingIsChapter: false, hasPrevItem: false, belowRoot: false,
    materialized: false, movable: true, firstChunkWalkable: true,
    tableEdge: null, atFirstCell: false, atRowStart: false, rowEmpty: false,
    singleRow: false, inTable: false, chunkEmpty: false, currentFormat: null,
  };
  if (!focus) return base;
  const path = focus.path;
  base.enclosing = enclosingFormat(doc, path);
  base.currentFormat = currentChosenFormat(doc, path);
  for (let i = 1; i < path.length; i++) {
    const anc = nodeAt(doc, path.slice(0, i));
    if (anc && declaredFormat(anc) === "table") { base.inTable = true; break; }
  }
  if (inSourceChunk(doc, path)) return { ...base, cell: "source" };
  if (focus.at === "into") return base; // the bootstrap paragraph
  if (focus.at === "ptr") return { ...base, cell: "atom" };

  const v = nodeAt(doc, path) as Value | null;
  if (!v) return base;
  const held = entryHolding(doc, path);
  base.materialized = held !== null && ((held.entry.meta ?? {}) as { anchorKey?: string }).anchorKey !== undefined;

  // the TITLE: a token position on a node REACHED AS A CHAPTER — the mount root's scalar self
  // (a chapter by the projection's entry contract), or a chapter-shaped node's
  if (!isPointer(v) && (v as Node).kind === "scalar" && (path.length === 0 || isChapterContainer(v)) && base.enclosing !== "bullets" && base.enclosing !== "numbered" && base.enclosing !== "row-cell") {
    base.cell = "title";
    base.oneLine = true;
    base.isRootTitle = path.length === 0;
    if (held) {
      const prev = held.index > 0 ? held.parent.entries![held.index - 1] : null;
      base.prevSiblingIsChapter = !!prev && isChapterContainer(prev.value) &&
        !((((prev.value as Node).meta ?? {}) as { style?: string }).style === "flow") &&
        formatOfNode(prev.value) === "chapter";
      base.movable = moveSafeValue(held.entry.value);
    }
    // where the enter-walk would land: the body row right after the self line (a leading
    // `description` is a typeable cell of its own, so its presence keeps the walk)
    const entries = (v as Node).entries ?? [];
    const selfAt = (((v as Node).meta ?? {}) as { selfAt?: number }).selfAt ?? 0;
    const first = entries[Math.min(Math.max(selfAt, 0), entries.length)];
    if (first !== undefined && first.key !== "description") {
      const mode = chunkModeOf(first.value);
      base.firstChunkWalkable = mode !== "chapter" && mode !== "atom";
    }
    return base;
  }

  if (held?.entry.key === "description") { base.cell = "description"; base.oneLine = true; return base; }

  if (base.enclosing === "bullets" || base.enclosing === "numbered") {
    base.cell = "listItem";
    base.hasPrevItem = held !== null && held.index > 0;
    base.oneLine = oneLineScalar(v);
    return base;
  }

  const walkableRowCount = (table: Node | null): number =>
    (table?.entries ?? []).filter((e) => (e.key === "header" || e.key === null) && !isPointer(e.value)).length;

  // a SCALAR row edited at the row's own path IS the row's single cell
  if (base.enclosing === "row" && !isPointer(v) && (v as Node).kind === "scalar") {
    base.cell = "tableCell";
    base.atRowStart = true; // the single cell IS the row's first position
    base.rowEmpty = cellEmpty(v);
    if (held) {
      const table = held.parent;
      const keylessRows = (table.entries ?? []).map((e, i) => ({ e, i })).filter((x) => x.e.key === null);
      const rowPos = keylessRows.findIndex((x) => x.i === held.index);
      const hasHeader = (table.entries ?? []).some((e) => e.key === "header");
      base.tableEdge = rowPos >= 0 && rowPos + 1 < keylessRows.length ? "rowEnd" : "lastCell";
      base.atFirstCell = !hasHeader && rowPos <= 0;
      base.singleRow = walkableRowCount(table) === 1;
    }
    return base;
  }
  if (base.enclosing === "row-cell") {
    base.cell = "tableCell";
    if (held) {
      base.atRowStart = held.index === 0;
      base.rowEmpty = (held.parent.entries ?? []).every((e) => cellEmpty(e.value));
      const row = held.parent;
      const tableHeld = entryHolding(doc, path.slice(0, -1));
      const table = tableHeld?.parent ?? null;
      const cells = row.entries ?? [];
      const rowIdx = tableHeld?.index ?? 0;
      const inHeader = tableHeld?.entry.key === "header";
      const hasHeader = (table?.entries ?? []).some((e) => e.key === "header");
      const keylessRows = (table?.entries ?? []).map((e, i) => ({ e, i })).filter((x) => x.e.key === null);
      const rowPos = inHeader ? -1 : keylessRows.findIndex((x) => x.i === rowIdx);
      // the walkable grid reads header row first, then the keyless rows
      const nextRowExists = inHeader ? keylessRows.length > 0 : rowPos >= 0 && rowPos + 1 < keylessRows.length;
      if (held.index + 1 < cells.length) base.tableEdge = "midRow";
      else if (nextRowExists) base.tableEdge = "rowEnd";
      else base.tableEdge = "lastCell";
      base.atFirstCell = held.index === 0 && (hasHeader ? inHeader : rowPos <= 0);
      base.singleRow = walkableRowCount(table) === 1;
    }
    return base;
  }

  base.cell = "prose";
  base.oneLine = oneLineScalar(v);
  base.belowRoot = path.length > 1;
  base.chunkEmpty = cellEmpty(v);
  return base;
}

/** A subtree the chapter verbs may RE-ROOT honestly (indent / dedent / flatten). Refused:
 *  - a NESTED entry with `meta.anchorKey` — it names a member DIRECTORY on disk; re-rooting
 *    would serialize the PROJECTION into the new parent (a copy) and orphan the storage
 *    (the reported json/object flatten: duplicated content, dereferenced links);
 *  - a BLOB — no inline payload exists at all;
 *  - a pointer that resolves RELATIVE to its holder (bare / `:` / `..` bases, `[.±k]` steps)
 *    — moving the holder silently retargets it (`*..:..` stopped meaning json/code).
 *  The entry's OWN anchorKey is deliberately not checked: moving a member DETACHES it (the
 *  pinned scalar-member semantics — content moves inline, the directory orphans). */
export function moveSafeValue(v: Value): boolean {
  if (isPointer(v)) {
    const p = v as Pointer;
    return p.base.scope === "link" && p.steps.every((st) => st.sel !== "relindex");
  }
  const n = v as Node;
  if (n.kind === "blob") return false;
  return (n.entries ?? []).every((e) =>
    ((e.meta ?? {}) as { anchorKey?: string }).anchorKey === undefined && moveSafeValue(e.value));
}

/** An empty prose cell: a childless scalar with no text (the unwind ladder's "cleared"). */
export const cellEmpty = (v: Value): boolean =>
  !isPointer(v) && (v as Node).kind === "scalar" && ((v as Node).entries ?? []).length === 0 &&
  String(((v as Node) as { value?: unknown }).value ?? "") === "";

const oneLineScalar = (v: Value): boolean => {
  if (isPointer(v)) return false;
  const n = v as Node & { value?: unknown; raw?: string };
  if (n.kind !== "scalar") return false;
  const text = String(n.value ?? "");
  return !text.includes("\n") && !(n.raw ?? "").includes("\n");
};
