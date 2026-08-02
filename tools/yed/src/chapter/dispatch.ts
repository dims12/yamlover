// THE CHAPTER KEY TABLE — chapterInterpret(key, site) → ChapterIntent | null. The chapter
// projection's own grammar (YAMLOVER_EDITOR.yo §"The CHAPTER projection"): the source
// typing grammar does not apply here (no holes, no `- `/`key:`); THE PROSE EXCEPTION governs
// Enter, THE FORMAT RULE governs Tab and the format commands.
//
// `null` = not this grammar's key: inside a SOURCE chunk the source grammar owns it; in prose
// mid-text the browser's native editing owns it. A claimed intent MUST respond (watchdog.ts).

import type { ChapterSite } from "./site";
import type { ChosenFormat } from "./format";

export type ChapterIntent =
  | { kind: "splitProse" }                       // Enter in prose: head stays, tail is a sibling
  | { kind: "joinPrev" } | { kind: "joinNext" }  // Backspace-at-start / Delete-at-end
  | { kind: "nest" }                             // Tab: THIS chunk nests one level (an untitled group; T titles it)
  | { kind: "unwrap" }                           // Shift-Tab: the title dissolves, body splices out
  | { kind: "indent" } | { kind: "dedent" }      // list nesting / title-under-chapter / prose lift
  | { kind: "cellWalk"; dir: 1 | -1 }            // table: the caret walks the grid
  | { kind: "appendRow" }                        // table: Tab at the very last cell / the + row button
  | { kind: "appendColumn" }                     // table: the + column button (every row gains a cell)
  | { kind: "deleteRow" }                        // table: Backspace at an ALL-EMPTY row's first position
  | { kind: "enterWalk" }                        // Enter on title/description: to the next cell
  | { kind: "insertBefore" }                     // Enter at a subchapter title's START: an empty ¶ opens before it
  | { kind: "move"; dir: 1 | -1 }                // the flat document-order caret walk
  | { kind: "role"; role: "title" | "desc" }     // the bar's T / D (never a key)
  | { kind: "format"; chosen: ChosenFormat }     // Ctrl+Alt+1..4 / the bar
  | { kind: "nop" }                              // claimed-to-swallow (Tab must not walk the browser)
  | { kind: "refuse" };                          // visibly refused — the ring

export interface ChapterKey {
  key: string; // "Enter" | "Tab" | "Backspace" | "Delete" | "ArrowUp" | … | "1".."4"
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

const FORMAT_KEYS: Record<string, ChosenFormat> = { "1": "chapter", "2": "table", "3": "bullets", "4": "numbered" };

export function chapterInterpret(k: ChapterKey, s: ChapterSite): ChapterIntent | null {
  if (s.cell === "source") return null; // the SOURCE grammar owns everything in there

  if (k.ctrl && k.alt && FORMAT_KEYS[k.key]) {
    if (s.cell === "atom") return { kind: "refuse" };
    // the BOOT cell takes format commands too: they MATERIALIZE the first entry of that kind
    // (no idle state — an empty chapter can start as a table or a list)
    if (s.cell === "boot") return { kind: "format", chosen: FORMAT_KEYS[k.key] };
    // re-choosing the ACTIVE format is idle — the bar shows it highlighted, the key swallows
    if (FORMAT_KEYS[k.key] === s.currentFormat) return { kind: "nop" };
    return { kind: "format", chosen: FORMAT_KEYS[k.key] };
  }
  // Ctrl+Enter anywhere IN a table (a cell, or a cell's inner chunks) appends a ROW…
  if (k.ctrl && k.key === "Enter" && (s.cell === "tableCell" || s.inTable)) return { kind: "appendRow" };
  // …and OUTSIDE one it INITIATES a table — the bar's ▦ button as a keystroke, with the format
  // command's exact gates. ONE gesture: Ctrl+Enter makes the table, Ctrl+Enter grows it row by row.
  if (k.ctrl && k.key === "Enter") {
    if (s.cell === "atom") return { kind: "refuse" };
    if (s.cell === "boot") return { kind: "format", chosen: "table" };
    if (s.currentFormat === "table") return { kind: "nop" };
    return { kind: "format", chosen: "table" };
  }

  switch (k.key) {
    case "Enter": {
      if (s.cell === "title") {
        // Enter at the START of a non-empty subchapter title: the word-processor push-down —
        // an empty paragraph opens BEFORE the whole subchapter, and the caret enters it.
        // (An EMPTY title is atStart AND atEnd — that stays the enter-walk.)
        if (s.caretAtStart && !s.caretAtEnd && !s.isRootTitle) return { kind: "insertBefore" };
        return { kind: "enterWalk" };
      }
      if (s.cell === "description") return { kind: "enterWalk" };
      if (s.cell === "prose" || s.cell === "listItem" || s.cell === "boot") return { kind: "splitProse" };
      if (s.cell === "tableCell") {
        // Ctrl+Enter appends a ROW; plain Enter splits the cell into CHUNKS — a cell hosts
        // the normal chapter flow (row-cell folds back to chapter rules)
        return k.ctrl ? { kind: "appendRow" } : { kind: "splitProse" };
      }
      return { kind: "nop" }; // atoms: swallowed, never a newline
    }
    case "Tab": {
      if (k.shift) {
        if (s.cell === "listItem") return { kind: "dedent" };
        if (s.cell === "prose") return s.belowRoot ? { kind: "dedent" } : { kind: "nop" };
        if (s.cell === "title") return s.isRootTitle || s.materialized ? { kind: "nop" } : { kind: "unwrap" };
        if (s.cell === "tableCell") return s.atFirstCell ? { kind: "nop" } : { kind: "cellWalk", dir: -1 };
        return { kind: "nop" };
      }
      if (s.cell === "listItem") return s.hasPrevItem ? { kind: "indent" } : { kind: "nop" };
      // Tab on a paragraph NESTS it — a plain paragraph one level deeper (an untitled group);
      // the title role is EXPLICIT (T). Any paragraph nests, one-line or block.
      if (s.cell === "prose") return { kind: "nest" };
      if (s.cell === "title") return s.prevSiblingIsChapter && !s.isRootTitle ? { kind: "indent" } : { kind: "nop" };
      if (s.cell === "tableCell") {
        // the CREATION flow: while the table has one row, Tab at its end grows a COLUMN;
        // with more rows the width is FIXED and Tab at the very last cell appends a row
        if (s.tableEdge === "lastCell") return s.singleRow ? { kind: "appendColumn" } : { kind: "appendRow" };
        return { kind: "cellWalk", dir: 1 };
      }
      return { kind: "nop" }; // Tab never lets the browser walk focus out of the document
    }
    case "Backspace":
      if (s.cell === "tableCell" && s.caretAtStart) {
        // THE TABLE UNWIND LADDER: text deletes natively char by char; at a cell's start the
        // caret steps into the previous cell and keeps deleting there; at the first position
        // of an ALL-EMPTY row the row itself leaves (and the last row takes the emptied
        // table with it) — a table unwinds gradually like every other structure
        if (s.atRowStart && s.rowEmpty) return { kind: "deleteRow" };
        return { kind: "cellWalk", dir: -1 };
      }
      if (s.cell === "title" && s.caretAtStart && !s.isRootTitle) {
        // a subchapter heading deletes into the preceding paragraph — the title dissolves in
        // (Tab-wrap's inverse); a MATERIALIZED subchapter must not dissolve by keystroke
        return s.materialized ? { kind: "refuse" } : { kind: "joinPrev" };
      }
      return (s.cell === "prose" || s.cell === "listItem") && s.caretAtStart ? { kind: "joinPrev" } : null;
    case "Delete":
      return (s.cell === "prose" || s.cell === "listItem") && s.caretAtEnd ? { kind: "joinNext" } : null;
    case "ArrowUp":
      if (s.cell === "title" || s.cell === "description" || s.cell === "atom" || s.cell === "boot") return { kind: "move", dir: -1 };
      return s.caretFirstLine ? { kind: "move", dir: -1 } : null;
    case "ArrowDown":
      if (s.cell === "title" || s.cell === "description" || s.cell === "atom" || s.cell === "boot") return { kind: "move", dir: 1 };
      return s.caretLastLine ? { kind: "move", dir: 1 } : null;
    case "ArrowRight":
      return s.cell === "tableCell" && s.caretAtEnd ? { kind: "cellWalk", dir: 1 } : null;
    case "ArrowLeft":
      return s.cell === "tableCell" && s.caretAtStart ? { kind: "cellWalk", dir: -1 } : null;
    default:
      return null; // printables and everything else: native (contentEditable) editing
  }
}
