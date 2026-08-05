// THE CHAPTER GRAMMAR TABLE AS DATA — mirrors docs/server/chapter-editor the way yed-dispatch.test.ts mirrors the source table. Every row: a key at a
// site → the intent. Change the machine ⇒ change the diagram ⇒ change this file.
import { describe, it, expect } from "vitest";
import { chapterInterpret, type ChapterIntent, type ChapterKey } from "../src/chapter/dispatch";
import type { ChapterSite } from "../src/chapter/site";

const site = (over: Partial<ChapterSite>): ChapterSite => ({
  cell: "prose", enclosing: "chapter", oneLine: true,
  caretAtStart: false, caretAtEnd: false, caretFirstLine: false, caretLastLine: false,
  isRootTitle: false, prevSiblingIsChapter: false, hasPrevItem: false, belowRoot: false,
  materialized: false, movable: true, firstChunkWalkable: true,
  tableEdge: null, atFirstCell: false, atRowStart: false, rowEmpty: false,
  singleRow: false, inTable: false, chunkEmpty: false, currentFormat: "chapter",
  ...over,
});

const rows: { name: string; key: ChapterKey; site: Partial<ChapterSite>; intent: ChapterIntent | null }[] = [
  // --- chapter_title_editing ---
  { name: "Enter on the title walks in (title → description → body)", key: { key: "Enter" }, site: { cell: "title" }, intent: { kind: "enterWalk" } },
  { name: "Enter on a title whose first chunk is a SUBCHAPTER/atom INSERTS a fresh ¶ — never a dead jump", key: { key: "Enter" }, site: { cell: "title", firstChunkWalkable: false }, intent: { kind: "insertHead" } },
  { name: "Enter at a non-empty title's START pushes the subchapter down (insertBefore wins over insertHead)", key: { key: "Enter" }, site: { cell: "title", caretAtStart: true, firstChunkWalkable: false }, intent: { kind: "insertBefore" } },
  { name: "Tab on a title whose previous sibling is a chapter: the subchapter nests", key: { key: "Tab" }, site: { cell: "title", prevSiblingIsChapter: true }, intent: { kind: "indent" } },
  { name: "Tab on a title whose subtree the diff cannot re-root RINGS — never a silent copy", key: { key: "Tab" }, site: { cell: "title", prevSiblingIsChapter: true, movable: false }, intent: { kind: "refuse" } },
  { name: "Tab on the ROOT title never indents", key: { key: "Tab" }, site: { cell: "title", isRootTitle: true, prevSiblingIsChapter: true }, intent: { kind: "nop" } },
  { name: "Tab on a title after a plain paragraph: never conscripts it", key: { key: "Tab" }, site: { cell: "title" }, intent: { kind: "nop" } },
  { name: "Shift-Tab on a subchapter title dissolves it (unwrap)", key: { key: "Tab", shift: true }, site: { cell: "title" }, intent: { kind: "unwrap" } },
  { name: "Shift-Tab on the root title nops", key: { key: "Tab", shift: true }, site: { cell: "title", isRootTitle: true }, intent: { kind: "nop" } },
  { name: "Shift-Tab on a MATERIALIZED subchapter nops (no inlining verb in v1)", key: { key: "Tab", shift: true }, site: { cell: "title", materialized: true }, intent: { kind: "nop" } },
  { name: "arrows on a title always walk (one line)", key: { key: "ArrowDown" }, site: { cell: "title" }, intent: { kind: "move", dir: 1 } },
  { name: "Backspace at a subchapter title's START dissolves it into the paragraph above", key: { key: "Backspace" }, site: { cell: "title", caretAtStart: true }, intent: { kind: "joinPrev" } },
  { name: "Backspace at the ROOT title's start is native", key: { key: "Backspace" }, site: { cell: "title", caretAtStart: true, isRootTitle: true }, intent: null },
  { name: "Backspace on a MATERIALIZED title rings — never dissolves by keystroke", key: { key: "Backspace" }, site: { cell: "title", caretAtStart: true, materialized: true }, intent: { kind: "refuse" } },

  // --- chapter_prose_editing (THE PROSE EXCEPTION) ---
  { name: "Enter in prose splits: the tail is a SIBLING, not a descent", key: { key: "Enter" }, site: { cell: "prose" }, intent: { kind: "splitProse" } },
  { name: "Tab on a paragraph NESTS it — a plain paragraph one level deeper (T makes titles)", key: { key: "Tab" }, site: { cell: "prose", oneLine: true }, intent: { kind: "nest" } },
  { name: "…a multi-line paragraph nests the same way", key: { key: "Tab" }, site: { cell: "prose", oneLine: false }, intent: { kind: "nest" } },
  { name: "Shift-Tab below the root lifts the paragraph out", key: { key: "Tab", shift: true }, site: { cell: "prose", belowRoot: true }, intent: { kind: "dedent" } },
  { name: "Shift-Tab at the root level nops", key: { key: "Tab", shift: true }, site: { cell: "prose" }, intent: { kind: "nop" } },
  { name: "Backspace at the start joins into the previous paragraph", key: { key: "Backspace" }, site: { cell: "prose", caretAtStart: true }, intent: { kind: "joinPrev" } },
  { name: "Backspace at an EMPTY chunk's start deletes THE CHUNK (the deletion law)", key: { key: "Backspace" }, site: { cell: "prose", caretAtStart: true, chunkEmpty: true }, intent: { kind: "deleteChunk" } },
  { name: "Backspace mid-text is native", key: { key: "Backspace" }, site: { cell: "prose" }, intent: null },
  { name: "Delete at the end pulls the next paragraph in", key: { key: "Delete" }, site: { cell: "prose", caretAtEnd: true }, intent: { kind: "joinNext" } },
  { name: "ArrowUp on the first visual line walks; mid-paragraph it is native", key: { key: "ArrowUp" }, site: { cell: "prose", caretFirstLine: true }, intent: { kind: "move", dir: -1 } },
  { name: "ArrowUp mid-paragraph is native", key: { key: "ArrowUp" }, site: { cell: "prose" }, intent: null },
  { name: "printables are native (contentEditable) editing", key: { key: "a" }, site: { cell: "prose" }, intent: null },

  // --- list_item_editing ---
  { name: "Tab nests the item under the previous one", key: { key: "Tab" }, site: { cell: "listItem", hasPrevItem: true, enclosing: "bullets", currentFormat: "bullets" }, intent: { kind: "indent" } },
  { name: "Tab on the first item nops", key: { key: "Tab" }, site: { cell: "listItem", enclosing: "bullets", currentFormat: "bullets" }, intent: { kind: "nop" } },
  { name: "Shift-Tab dedents the item", key: { key: "Tab", shift: true }, site: { cell: "listItem", enclosing: "bullets", currentFormat: "bullets" }, intent: { kind: "dedent" } },

  // --- the table cell walk ---
  { name: "Tab mid-row walks to the next cell", key: { key: "Tab" }, site: { cell: "tableCell", enclosing: "row-cell", tableEdge: "midRow", currentFormat: "table" }, intent: { kind: "cellWalk", dir: 1 } },
  { name: "Tab at a row's end wraps to the next row", key: { key: "Tab" }, site: { cell: "tableCell", enclosing: "row-cell", tableEdge: "rowEnd", currentFormat: "table" }, intent: { kind: "cellWalk", dir: 1 } },
  { name: "Tab at the VERY last cell appends a row (the width is fixed past row one)", key: { key: "Tab" }, site: { cell: "tableCell", enclosing: "row-cell", tableEdge: "lastCell", currentFormat: "table" }, intent: { kind: "appendRow" } },
  { name: "Tab at a SINGLE row's end grows a COLUMN — the creation flow", key: { key: "Tab" }, site: { cell: "tableCell", enclosing: "row-cell", tableEdge: "lastCell", singleRow: true, currentFormat: "table" }, intent: { kind: "appendColumn" } },
  { name: "Shift-Tab walks back", key: { key: "Tab", shift: true }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: { kind: "cellWalk", dir: -1 } },
  { name: "Shift-Tab at the first cell never un-appends", key: { key: "Tab", shift: true }, site: { cell: "tableCell", enclosing: "row-cell", atFirstCell: true, currentFormat: "table" }, intent: { kind: "nop" } },
  { name: "Enter in a cell SPLITS it into chunks — a cell hosts the chapter flow", key: { key: "Enter" }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: { kind: "splitProse" } },
  { name: "Ctrl+Enter in a cell appends a ROW", key: { key: "Enter", ctrl: true }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: { kind: "appendRow" } },
  { name: "Ctrl+Enter in a cell's INNER chunk appends a row too (anywhere in the table)", key: { key: "Enter", ctrl: true }, site: { cell: "prose", inTable: true }, intent: { kind: "appendRow" } },

  // --- THE TABLE GESTURE: Ctrl+Enter OUTSIDE a table initiates one (the bar's ▦ as a keystroke) ---
  { name: "Ctrl+Enter in prose INITIATES a table — the paragraph wraps as its one cell", key: { key: "Enter", ctrl: true }, site: { cell: "prose" }, intent: { kind: "format", chosen: "table" } },
  { name: "Ctrl+Enter on the BOOT cell materializes the first entry as a table", key: { key: "Enter", ctrl: true }, site: { cell: "boot" }, intent: { kind: "format", chosen: "table" } },
  { name: "Ctrl+Enter on a title retags the titled block as a table (the button's target)", key: { key: "Enter", ctrl: true }, site: { cell: "title" }, intent: { kind: "format", chosen: "table" } },
  { name: "Ctrl+Enter in a list item retags the list as a table", key: { key: "Enter", ctrl: true }, site: { cell: "listItem", enclosing: "bullets", currentFormat: "bullets" }, intent: { kind: "format", chosen: "table" } },
  { name: "Ctrl+Enter on an ATOM rings — the format command's gate", key: { key: "Enter", ctrl: true }, site: { cell: "atom" }, intent: { kind: "refuse" } },
  { name: "Ctrl+Enter inside a SOURCE chunk stays the source grammar's", key: { key: "Enter", ctrl: true }, site: { cell: "source" }, intent: null },
  { name: "ArrowRight at a cell's END walks to the next cell", key: { key: "ArrowRight" }, site: { cell: "tableCell", enclosing: "row-cell", caretAtEnd: true, currentFormat: "table" }, intent: { kind: "cellWalk", dir: 1 } },
  { name: "ArrowRight mid-cell is native", key: { key: "ArrowRight" }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: null },
  { name: "ArrowLeft at a cell's START walks to the previous cell", key: { key: "ArrowLeft" }, site: { cell: "tableCell", enclosing: "row-cell", caretAtStart: true, currentFormat: "table" }, intent: { kind: "cellWalk", dir: -1 } },
  { name: "ArrowLeft mid-cell is native", key: { key: "ArrowLeft" }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: null },

  // --- THE TABLE UNWIND LADDER (Backspace) ---
  { name: "Backspace mid-cell-text is native", key: { key: "Backspace" }, site: { cell: "tableCell", enclosing: "row-cell", currentFormat: "table" }, intent: null },
  { name: "Backspace at a cell's start steps into the previous cell", key: { key: "Backspace" }, site: { cell: "tableCell", enclosing: "row-cell", caretAtStart: true, currentFormat: "table" }, intent: { kind: "cellWalk", dir: -1 } },
  { name: "Backspace at an ALL-EMPTY row's first position deletes the row", key: { key: "Backspace" }, site: { cell: "tableCell", enclosing: "row-cell", caretAtStart: true, atRowStart: true, rowEmpty: true, currentFormat: "table" }, intent: { kind: "deleteRow" } },
  { name: "…a NON-empty row's first cell walks instead of deleting", key: { key: "Backspace" }, site: { cell: "tableCell", enclosing: "row-cell", caretAtStart: true, atRowStart: true, currentFormat: "table" }, intent: { kind: "cellWalk", dir: -1 } },
  { name: "…an empty SCALAR row deletes from its single cell", key: { key: "Backspace" }, site: { cell: "tableCell", enclosing: "row", caretAtStart: true, atRowStart: true, rowEmpty: true, currentFormat: "table" }, intent: { kind: "deleteRow" } },

  // --- format_switched ---
  { name: "Ctrl+Alt+3 chooses bullets", key: { key: "3", ctrl: true, alt: true }, site: { cell: "prose" }, intent: { kind: "format", chosen: "bullets" } },
  { name: "re-choosing the ACTIVE format is idle", key: { key: "1", ctrl: true, alt: true }, site: { cell: "prose", currentFormat: "chapter" }, intent: { kind: "nop" } },
  { name: "a format key on the BOOT cell materializes the first entry — no idle state", key: { key: "2", ctrl: true, alt: true }, site: { cell: "boot" }, intent: { kind: "format", chosen: "table" } },
  { name: "a format key on an ATOM rings", key: { key: "2", ctrl: true, alt: true }, site: { cell: "atom" }, intent: { kind: "refuse" } },

  // --- the source escape ---
  { name: "inside a SOURCE chunk the chapter grammar declines everything", key: { key: "Tab" }, site: { cell: "source" }, intent: null },
  { name: "…including Enter", key: { key: "Enter" }, site: { cell: "source" }, intent: null },

  // --- boot / atoms ---
  { name: "Enter on the bootstrap paragraph makes the first chunk", key: { key: "Enter" }, site: { cell: "boot" }, intent: { kind: "splitProse" } },
  { name: "Tab on an atom is swallowed, never a browser focus walk", key: { key: "Tab" }, site: { cell: "atom" }, intent: { kind: "nop" } },
  { name: "arrows walk off an atom", key: { key: "ArrowUp" }, site: { cell: "atom" }, intent: { kind: "move", dir: -1 } },
  { name: "…horizontal arrows too — an atom is ONE stop, any arrow leaves it", key: { key: "ArrowRight" }, site: { cell: "atom" }, intent: { kind: "move", dir: 1 } },
  { name: "…ArrowLeft walks back off the atom", key: { key: "ArrowLeft" }, site: { cell: "atom" }, intent: { kind: "move", dir: -1 } },
];

describe("the chapter dispatch table (the docs/server/yamlover-editor mirror)", () => {
  for (const r of rows) {
    it(r.name, () => {
      expect(chapterInterpret(r.key, site(r.site))).toEqual(r.intent);
    });
  }
});
