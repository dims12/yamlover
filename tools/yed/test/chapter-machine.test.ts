// THE CHAPTER MACHINE, pure — the port of the legacy chapter-projection op-semantics pins as
// doc-in/doc-out state tests (ops now come from the persistence diff, tested server-side).
// The two structural laws: a WRAP serializes identically (zero ops by construction), and an
// emptied wrapped container IS its scalar again (unwrap of a childless title = exact inverse).
import { describe, it, expect } from "vitest";
import { parseSource, sourceOf, type Node } from "../src/state";
import type { Position } from "../src/apply";
import {
  applyChapterIntent, applyChapterKey, commitChapterText, demoteDescription, demoteTitle,
  indentEntry, initialChapterState, joinWalk, makeDescription, makeTitle, nestParagraph,
  promoteFormat, splitProse, unwrapChapter, type ChapterState,
} from "../src/chapter/apply";
import { chapterPositionsOf } from "../src/chapter/positions";
import { chapterSiteOf } from "../src/chapter/site";
import { chunkModeOf, enclosingFormat } from "../src/chapter/format";
import { chapterWatchdog } from "../src/chapter/watchdog";
import fs from "node:fs";
import path from "node:path";

const st = (src: string, focus?: Position): ChapterState =>
  ({ ...initialChapterState(parseSource(src)), ...(focus ? { focus, caret: null } : {}) });
const tok = (...p: number[]): Position => ({ at: "token", path: p });

describe("nest / dedent — Tab makes a nested PARAGRAPH (T makes titles)", () => {
  it("Tab NESTS the chunk into a fresh untitled group — still a paragraph, one level deeper", () => {
    const s0 = st("- hello\n- world\n", tok(0));
    const s1 = nestParagraph(s0, [0]);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- - hello\n- world\n");
    expect(s1.focus).toEqual(tok(0, 0));
    expect(chapterSiteOf(s1.doc, s1.focus).cell).toBe("prose"); // NOT a title — the same state as typing nested
  });

  it("nest → dedent round-trips exactly (the husk leaves with its last paragraph)", () => {
    const s0 = st("- hello\n- world\n", tok(0));
    const nested = nestParagraph(s0, [0]);
    const s2 = applyChapterIntent(nested, { kind: "dedent" });
    expect(JSON.stringify(s2.doc.root)).toBe(JSON.stringify(s0.doc.root));
    expect(s2.focus).toEqual(tok(0));
  });

  it("a MULTI-LINE paragraph nests too (no title is being made)", () => {
    const s0 = st("- |-\n  two\n  lines\n- x\n", tok(0));
    const s1 = nestParagraph(s0, [0]);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toContain("- - |-");
  });

  it("a KEYED chunk refuses to nest (its key has no place in a group)", () => {
    const s0 = st("note: keep me\n- x\n", tok(0));
    expect(nestParagraph(s0, [0]).refused).toBe(true);
  });

  it("nest → T titles the group — the composed flow replaces the old wrap", () => {
    const s0 = st("- Dogs\n- tail\n", tok(0));
    const nested = nestParagraph(s0, [0]);
    const titled = makeTitle(nested, [0, 0]);
    expect(titled.refused).toBe(false);
    expect(sourceOf(titled.doc)).toBe("- Dogs\n- tail\n"); // title-only group spells the same line
    expect(chapterSiteOf(titled.doc, titled.focus).cell).toBe("title");
  });

  it("unwrap splices the body out AFTER the title, in order; the description dissolves first", () => {
    const s0 = st("- Dogs\n  description: sub\n  - woof\n  - bark\n- tail\n", tok(0));
    const s1 = unwrapChapter(s0, [0]);
    expect(sourceOf(s1.doc)).toBe("- Dogs\n- sub\n- woof\n- bark\n- tail\n");
    expect(s1.focus).toEqual(tok(0));
  });
});

describe("split / join — THE PROSE EXCEPTION", () => {
  it("Enter splits at the caret: head stays, the tail is a fresh sibling, the caret follows it", () => {
    const s1 = splitProse(st("- helloworld\n", tok(0)), [0], "hello", "world");
    expect(sourceOf(s1.doc)).toBe("- hello\n- world\n");
    expect(s1.focus).toEqual(tok(1));
    expect(s1.caret).toBe("start");
    expect(s1.revs["0"]).toBe(1); // the head's DOM must reset to the truncated text
  });

  it("Backspace at the start joins into the previous paragraph, caret at the junction", () => {
    const s1 = joinWalk(st("- hello\n- world\n", tok(1)), -1);
    expect(sourceOf(s1.doc)).toBe("- helloworld\n");
    expect(s1.focus).toEqual(tok(0));
    expect(s1.caret).toBe(5);
  });

  it("the join is WALK-ADJACENT: Delete absorbs the first paragraph INSIDE an untitled group", () => {
    // the old sibling-scoped law refused here; the walk's next stop is the nested paragraph
    const s1 = joinWalk(st("- a\n- - nested\n", tok(0)), 1);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- anested\n"); // …and the emptied untitled husk is gone
    expect(s1.focus).toEqual(tok(0));
    expect(s1.caret).toBe(1);
  });

  it("the HUSK LOOP: absorbing the last paragraph of an untitled group leaves no ghost", () => {
    const s1 = joinWalk(st("- intro\n- - only\n", tok(0)), 1);
    expect(sourceOf(s1.doc)).toBe("- introonly\n");
  });

  it("Delete at the end before a SUBCHAPTER dissolves its title in (the reported dead key)", () => {
    const s1 = joinWalk(st("- intro\n- Dogs\n  - woof\n- tail\n", tok(0)), 1);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- introDogs\n- woof\n- tail\n");
    expect(s1.focus).toEqual(tok(0));
    expect(s1.caret).toBe(5); // the junction — "intro" | "Dogs"
  });

  it("Backspace at a subchapter TITLE's start mirrors the dissolve", () => {
    const s0 = st("- intro\n- Dogs\n  description: sub\n  - woof\n", tok(1));
    const s1 = applyChapterKey(s0, { key: "Backspace" }, { atStart: true })!;
    expect(sourceOf(s1.doc)).toBe("- introDogs\n- sub\n- woof\n"); // description dissolved first
    expect(s1.caret).toBe(5);
  });

  it("Backspace onto a preceding TITLE-ONLY chapter merges title-first", () => {
    // the title-only group arises from nest → T (the composed flow)
    const s0 = st("- Dogs\n- tail\n", tok(0));
    const titled = makeTitle(nestParagraph(s0, [0]), [0, 0]);
    const s1 = joinWalk({ ...titled, focus: tok(1), caret: null }, -1);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- Dogstail\n");
    expect(s1.caret).toBe(4); // after "Dogs"
  });

  it("a paragraph never swallows its OWN chapter's heading — the ring", () => {
    const s1 = joinWalk(st("- Dogs\n  - woof\n", tok(0, 0)), -1);
    expect(s1.refused).toBe(true);
    expect(sourceOf(s1.doc)).toBe("- Dogs\n  - woof\n");
  });

  it("non-prose partners refuse: a description is not absorbed by join", () => {
    // Backspace at the first body paragraph walks back onto the description — ring
    const s1 = joinWalk(st("description: d\n- p\n", tok(1)), -1);
    expect(s1.refused).toBe(true);
  });

  it("a MATERIALIZED title's Backspace refuses at dispatch (never dissolves by keystroke)", () => {
    const doc = parseSource("- intro\n- Dogs\n  - woof\n");
    (doc.root as Node).entries![1].meta = { anchorKey: "01-Dogs" } as never;
    const s0 = { ...initialChapterState(doc), focus: tok(1), caret: null };
    const s1 = applyChapterKey(s0, { key: "Backspace" }, { atStart: true })!;
    expect(s1.refused).toBe(true);
    expect(sourceOf(s1.doc)).toBe("- intro\n- Dogs\n  - woof\n");
  });

  it("the ROOT title's Backspace stays unclaimed — native editing", () => {
    const s0 = st("Book\n- p\n", { at: "token", path: [] });
    expect(applyChapterKey(s0, { key: "Backspace" }, { atStart: true })).toBeNull();
  });

  it("list items join only within the SAME list", () => {
    const s1 = joinWalk(st("- !!<*yamlover: $defs: bullets>\n  - one\n  - two\n- after\n", tok(0, 1)), -1);
    expect(s1.refused).toBe(false); // one ← two, same list
    expect(sourceOf(s1.doc)).toContain("- onetwo");
    const s2 = joinWalk(st("- !!<*yamlover: $defs: bullets>\n  - one\n- after\n", tok(1)), -1);
    expect(s2.refused).toBe(true); // a list item never merges with outside prose
  });
});

describe("Tab nesting — titles and lists", () => {
  it("a title nests its WHOLE subchapter under the previous chapter sibling", () => {
    const s0 = st("- Dogs\n  - woof\n- Cats\n  - meow\n", tok(2)); // hmm: [1] is Cats
    const s1 = indentEntry(s0, [1]);
    expect(sourceOf(s1.doc)).toBe("- Dogs\n  - woof\n  - Cats\n    - meow\n");
  });

  it("a list item indents under the previous item; the leaf previous becomes an omni", () => {
    const s1 = indentEntry(st("- one\n- two\n", tok(1)), [1]);
    expect(sourceOf(s1.doc)).toBe("- one\n  - two\n");
  });

  it("dedent is the inverse", () => {
    const s0 = st("- one\n  - two\n", tok(0, 0));
    const s1 = applyChapterIntent({ ...s0, focus: tok(0, 0) }, { kind: "dedent" });
    expect(sourceOf(s1.doc)).toBe("- one\n- two\n");
  });
});

describe("roles — T / D", () => {
  it("T makes the focused one-line chunk the chapter's TITLE (the omni self)", () => {
    const s1 = makeTitle(st("- Book\n- p\n", tok(0)), [0]);
    expect(sourceOf(s1.doc)).toBe("Book\n- p\n");
    expect(s1.focus).toEqual({ at: "token", path: [] });
  });

  it("T on the title demotes it into the first body chunk", () => {
    const s1 = demoteTitle(st("Book\n- p\n", { at: "token", path: [] }), []);
    expect(sourceOf(s1.doc)).toBe('- Book\n- p\n');
    expect(s1.focus).toEqual(tok(0));
  });

  it("T refuses when a title already exists", () => {
    expect(makeTitle(st("Book\n- p\n", tok(0)), [0]).refused).toBe(true);
  });

  it("T TOGGLES on a body-less title — promote then demote round-trips", () => {
    // the browser-caught defect: a title with NO entries refused to demote (kind-shape guard)
    const born = applyChapterIntent(
      { ...initialChapterState(parseSource("")), focus: { at: "into", path: [] }, caret: null },
      { kind: "splitProse" }, { head: "Hello world", tail: "" },
    );
    const promoted = makeTitle(born, [0]);
    expect(sourceOf(promoted.doc)).toBe("Hello world\n");
    const demoted = demoteTitle(promoted, []);
    expect(demoted.refused).toBe(false);
    expect(sourceOf(demoted.doc)).toBe("- Hello world\n");
  });

  it("D makes the chunk the description — the container's FIRST entry", () => {
    const s1 = makeDescription(st("- p\n- about\n", tok(1)), [1]);
    expect(sourceOf(s1.doc)).toBe("description: about\n- p\n");
    expect(s1.focus).toEqual(tok(0));
  });

  it("D on the description demotes it into a plain chunk in its place", () => {
    const s1 = demoteDescription(st("description: about\n- p\n", tok(0)), [0]);
    expect(sourceOf(s1.doc)).toBe("- about\n- p\n");
  });

  it("D refuses when a description exists", () => {
    expect(makeDescription(st("description: d\n- x\n", tok(1)), [1]).refused).toBe(true);
  });

  it("roles are CHAPTER moves — a list item refuses both T and D", () => {
    const s0 = st("- !!<*yamlover: $defs: bullets>\n  - one\n  - two\n", tok(0, 0));
    expect(makeTitle(s0, [0, 0]).refused).toBe(true);
    expect(makeDescription(s0, [0, 0]).refused).toBe(true);
  });

  it("the EMPTY document's scalar-null root is NOT a title — T works on the first typed chunk", () => {
    // the debug-page regression: parseSource("") roots as {kind:"scalar", value:null, raw:""},
    // and a kind-based "title exists" test wrongly disabled T forever
    const born = applyChapterIntent(
      { ...initialChapterState(parseSource("")), focus: { at: "into", path: [] }, caret: null },
      { kind: "splitProse" }, { head: "My title", tail: "" },
    );
    expect(sourceOf(born.doc)).toBe("- My title\n");
    const s1 = makeTitle(born, [0]);
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("My title\n");
    expect(s1.focus).toEqual({ at: "token", path: [] });
  });
});

describe("format — the ENCLOSING block, tag spelling, the drop rule", () => {
  it("a LEAF paragraph → bullets wraps the prose as the one item (project-ladder spelling)", () => {
    const s1 = promoteFormat(st("- item\n- x\n", tok(0)), [0], "bullets");
    expect(sourceOf(s1.doc)).toBe("- !!<*:: yamlover: $defs: bullets>\n  - item\n- x\n");
    expect(s1.focus).toEqual(tok(0, 0)); // the caret follows the prose into the item
  });

  it("a tagged container retags with the DOCUMENT's own spelling", () => {
    const s1 = promoteFormat(st("!!<*yamlover: $defs: chapter>\nT\n- !!<*yamlover: $defs: bullets>\n  - x\n", tok(0, 0)), [0], "numbered");
    expect(sourceOf(s1.doc)).toContain("!!<*yamlover: $defs: numbered>");
  });

  it("→ chapter DROPS the tag (untagged ≡ subchapter)", () => {
    const s1 = promoteFormat(st("- !!<*yamlover: $defs: bullets>\n  - x\n", tok(0, 0)), [0], "chapter");
    expect(sourceOf(s1.doc)).not.toContain("!!<");
    expect(sourceOf(s1.doc)).toContain("- x");
  });

  it("standing IN a list item retags the LIST; in a table cell, the TABLE", () => {
    const s1 = promoteFormat(st("- !!<*yamlover: $defs: bullets>\n  - one\n  - two\n", tok(0, 1)), [0, 1], "numbered");
    expect(sourceOf(s1.doc)).toContain("$defs: numbered");
    expect(sourceOf(s1.doc)).toContain("- one");
  });

  it("¶ in a list is ITEM-LOCAL: the item exits, the list SPLITS around it (labour preserved)", () => {
    const s1 = promoteFormat(st("- !!<*yamlover: $defs: bullets>\n  - one\n  - two\n  - three\n", tok(0, 1)), [0, 1], "chapter");
    expect(s1.refused).toBe(false);
    const src = sourceOf(s1.doc);
    // "two" is a plain paragraph now; "one" and "three" keep their (tagged) lists
    expect(src).toBe("- !!<*yamlover: $defs: bullets>\n  - one\n- two\n- !!<*yamlover: $defs: bullets>\n  - three\n");
    expect(s1.focus).toEqual(tok(1));
  });

  it("▦ on a paragraph makes a working ONE-CELL table (a scalar row IS its single cell)", () => {
    const s0 = st("- data point\n- x\n", tok(0));
    const s1 = promoteFormat(s0, [0], "table");
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- !!<*:: yamlover: $defs: table>\n  - data point\n- x\n");
    // the scalar row is a WALKABLE, editable cell — not an invisible nothing
    const list = chapterPositionsOf(s1.doc);
    expect(list).toContainEqual({ at: "token", path: [0, 0] });
    const site = chapterSiteOf(s1.doc, { at: "token", path: [0, 0] });
    expect(site.cell).toBe("tableCell");
    expect(site.tableEdge).toBe("lastCell"); // Tab appends the second row
  });

  it("+ COLUMN: every row gains a cell; a SCALAR row becomes its two-cell array", () => {
    const src = "- !!<*yamlover: $defs: table>\n  header:\n    - A\n  - - '1'\n  - solo\n";
    const s0 = st(src, tok(0, 1, 0)); // the '1' cell
    const s1 = applyChapterIntent(s0, { kind: "appendColumn" });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- !!<*yamlover: $defs: table>\n  header:\n    - A\n    - ''\n  - - '1'\n    - ''\n  - - solo\n    - ''\n");
    expect(s1.focus).toEqual(tok(0, 1, 1)); // this row's fresh cell
  });

  it("Enter in a cell SPLITS it into chunks — the cell hosts the chapter flow from then on", () => {
    const src = "- !!<*yamlover: $defs: table>\n  - - alpha beta\n";
    const s0 = st(src, tok(0, 0, 0));
    const s1 = applyChapterIntent(s0, { kind: "splitProse" }, { head: "alpha", tail: "beta" });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- !!<*yamlover: $defs: table>\n  - - - alpha\n      - beta\n");
    expect(s1.focus).toEqual(tok(0, 0, 0, 1)); // the tail chunk, inside the cell
    // the inner paragraphs are CHAPTER context — a further Enter splits generically
    const s2 = applyChapterIntent(s1, { kind: "splitProse" }, { head: "be", tail: "ta" });
    expect(sourceOf(s2.doc)).toContain("- be\n");
    expect(sourceOf(s2.doc)).toContain("- ta\n");
  });

  it("Tab at a SINGLE row's end grows a COLUMN; a second row fixes the width", () => {
    const one = st("- !!<*yamlover: $defs: table>\n  - - a\n", tok(0, 0, 0));
    const grown = applyChapterKey(one, { key: "Tab" }, { atEnd: true, atStart: false })!;
    expect(sourceOf(grown.doc)).toBe("- !!<*yamlover: $defs: table>\n  - - a\n    - ''\n");
    const two = st("- !!<*yamlover: $defs: table>\n  - - a\n    - b\n  - - c\n    - d\n", tok(0, 1, 1));
    const rowed = applyChapterKey(two, { key: "Tab" }, {})!;
    expect(sourceOf(rowed.doc)).toContain("- ''\n"); // a fresh ROW, not a column
    expect(((rowed.doc.root as Node).entries![0].value as Node).entries!.length).toBe(3);
  });

  it("↓ at the DOCUMENT's end adds a fresh chunk — always (but never spams empties)", () => {
    const s0 = st("- last words\n", tok(0));
    const s1 = applyChapterIntent(s0, { kind: "move", dir: 1 });
    expect(sourceOf(s1.doc)).toBe("- last words\n- ''\n");
    expect(s1.focus).toEqual(tok(1));
    const s2 = applyChapterIntent(s1, { kind: "move", dir: 1 });
    expect(sourceOf(s2.doc)).toBe("- last words\n- ''\n"); // already on a trailing empty — stay
  });

  it("↑/↓ in a table move by COLUMN; the bottom edge LEAVES the table (the way out)", () => {
    const src = "- !!<*yamlover: $defs: table>\n  header:\n    - A\n    - B\n  - - '1'\n    - '2'\n- after\n";
    const s0 = st(src, tok(0, 0, 1)); // header cell B
    const down = applyChapterIntent(s0, { kind: "move", dir: 1 });
    expect(down.focus).toEqual(tok(0, 1, 1)); // same COLUMN, the data row
    const out = applyChapterIntent(down, { kind: "move", dir: 1 });
    expect(out.focus).toEqual(tok(1)); // the bottom edge left the table
    const back = applyChapterIntent(out, { kind: "move", dir: -1 });
    expect(back.focus?.path[0]).toBe(0); // …and ↑ walks back into it
  });

  it("↓ past a table INSIDE A SUBCHAPTER appends the chunk after the TABLE — the subchapter grows, not the root", () => {
    // the reported bug: the fresh chunk landed at the ROOT, outside the subchapter
    const src = "- intro\n- Sub\n  - text\n  - !!<*yamlover: $defs: table>\n    - - a\n      - b\n";
    const s0 = st(src, tok(1, 1, 0, 0)); // cell 'a' — the table ends the document
    const s1 = applyChapterIntent(s0, { kind: "move", dir: 1 });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- intro\n- Sub\n  - text\n  - !!<*yamlover: $defs: table>\n    - - a\n      - b\n  - ''\n");
    expect(s1.focus).toEqual(tok(1, 2)); // the fresh paragraph, INSIDE the subchapter
    // …and no empty-spam: ↓ again stays on the fresh empty paragraph
    const s2 = applyChapterIntent(s1, { kind: "move", dir: 1 });
    expect(sourceOf(s2.doc)).toBe(sourceOf(s1.doc));
    expect(s2.focus).toEqual(tok(1, 2));
  });

  it("a split cell joined back to ONE paragraph FOLDS BACK to the scalar cell (Enter's inverse)", () => {
    // the reported bug: the join left a one-item container husk (`- - эелемент 2-2`)
    const src = "- !!<*yamlover: $defs: table>\n  - - a\n    - b\n  - - c\n    - d\n";
    const s0 = st(src, tok(0, 1, 1)); // the last cell 'd'
    const split = applyChapterIntent(s0, { kind: "splitProse" }, { head: "d", tail: "" });
    expect(sourceOf(split.doc)).toBe("- !!<*yamlover: $defs: table>\n  - - a\n    - b\n  - - c\n    - - d\n      - ''\n");
    const joined = applyChapterIntent(split, { kind: "joinPrev" });
    expect(joined.refused).toBe(false);
    expect(sourceOf(joined.doc)).toBe(src); // the EXACT original — no husk
    expect(joined.focus).toEqual(tok(0, 1, 1)); // the caret is back on the scalar cell
    expect(joined.caret).toBe(1); // at the junction, after 'd'
  });


  it("¶ on a SINGLE-item list dissolves it to the paragraph — the wrap cycle is STABLE", () => {
    // the reported bug: ¶/• cycling nested deeper each round without converging
    const s0 = st("- item\n- x\n", tok(0));
    const listed = promoteFormat(s0, [0], "bullets");
    expect(sourceOf(listed.doc)).toBe("- !!<*:: yamlover: $defs: bullets>\n  - item\n- x\n");
    const back = promoteFormat({ ...listed, focus: tok(0, 0), caret: null }, [0, 0], "chapter");
    expect(sourceOf(back.doc)).toBe("- item\n- x\n"); // the exact inverse
    const again = promoteFormat({ ...back, focus: tok(0), caret: null }, [0], "bullets");
    expect(sourceOf(again.doc)).toBe("- !!<*:: yamlover: $defs: bullets>\n  - item\n- x\n"); // …and again, no residue
  });
});

describe("the chapter walk — positions and cells", () => {
  it("title → description → chunks → subchapter → KEYED chunk — reading order, keys included", () => {
    const src = "T\ndescription: d\n- p1\n- Sub\n  - deep\nother: visible\n";
    const list = chapterPositionsOf(parseSource(src));
    expect(list).toEqual([
      { at: "token", path: [] },        // the title
      { at: "token", path: [0] },       // description
      { at: "token", path: [1] },       // p1
      { at: "token", path: [2] },       // Sub's title
      { at: "token", path: [2, 0] },    // deep
      { at: "token", path: [3] },       // the KEYED chunk — body content, its key is its label
    ]);
  });

  it("an empty chapter yields ONE bootstrap stop", () => {
    expect(chapterPositionsOf(parseSource(""))).toEqual([{ at: "into", path: [] }]);
  });

  it("a SOURCE chunk keeps its full source sub-walk — keys and all", () => {
    const src = "- !!<*yamlover: $defs: recipe>\n  serves: 4\n  time: 20\n- p\n";
    const doc = parseSource(src);
    expect(chunkModeOf((doc.root as Node).entries![0].value)).toBe("source");
    const list = chapterPositionsOf(doc);
    const under0 = list.filter((p) => p.path[0] === 0);
    expect(under0.some((p) => p.at === "key")).toBe(true); // source positions, not one atom
  });

  it("enclosingFormat folds the spine: sublists inherit, tables are two-deep", () => {
    const doc = parseSource("- !!<*yamlover: $defs: bullets>\n  - one\n  - - nested\n- !!<*yamlover: $defs: table>\n  - - a\n    - b\n");
    expect(enclosingFormat(doc, [0, 1, 0])).toBe("bullets");   // the nested sublist item
    expect(enclosingFormat(doc, [1, 0, 0])).toBe("row-cell");  // a table cell
  });
});

describe("the keystroke surface — applyChapterKey", () => {
  it("Enter on the title walks to the description; on the description, to the first paragraph", () => {
    const s0 = st("T\ndescription: d\n- p\n", { at: "token", path: [] });
    const s1 = applyChapterKey(s0, { key: "Enter" })!;
    expect(s1.focus).toEqual(tok(0));
    const s2 = applyChapterKey(s1, { key: "Enter" })!;
    expect(s2.focus).toEqual(tok(1));
  });

  it("nest → T → commitText → Enter keeps the typed title (the vanishing-title pin)", () => {
    const s0 = st("- p1\n- fresh\n", tok(1));
    const titled = makeTitle(nestParagraph(s0, [1]), [1, 0]);
    const retyped = commitChapterText(titled, [1], "My chapter");
    const entered = applyChapterKey(retyped, { key: "Enter" })!;
    expect(sourceOf(entered.doc)).toBe("- p1\n- My chapter\n  - ''\n");
    expect(entered.focus).toEqual(tok(1, 0)); // the fresh first paragraph
    expect(entered.caret).toBe("start");
  });

  it("Enter on a title with an EMPTY body creates the first paragraph", () => {
    const s0 = st("T\n", { at: "token", path: [] });
    const s1 = applyChapterKey(s0, { key: "Enter" })!;
    expect(sourceOf(s1.doc)).toBe("T\n- ''\n");
    expect(s1.focus).toEqual(tok(0));
  });

  it("printables are NOT the grammar's — native editing", () => {
    expect(applyChapterKey(st("- p\n", tok(0)), { key: "a" })).toBeNull();
  });

  it("Ctrl+Alt+3 formats to bullets", () => {
    const s1 = applyChapterKey(st("- item\n", tok(0)), { key: "3", ctrl: true, alt: true })!;
    expect(sourceOf(s1.doc)).toContain("$defs: bullets");
  });

  it("typed text commits per keystroke; an emptied TITLE drops the self line", () => {
    const s0 = st("T\n- p\n", { at: "token", path: [] });
    const s1 = commitChapterText(s0, [], "New");
    expect(sourceOf(s1.doc)).toBe("New\n- p\n");
    const s2 = commitChapterText(s1, [], "");
    expect(sourceOf(s2.doc)).toBe("- p\n");
  });
});

describe("boot materialization — a format/role on the EMPTY chapter acts immediately (no idle state)", () => {
  const boot = (): ChapterState =>
    ({ ...initialChapterState(parseSource("")), focus: { at: "into", path: [] }, caret: null });

  it("▦ on the boot cell creates a one-cell table; the caret enters its creation flow", () => {
    const s1 = applyChapterIntent(boot(), { kind: "format", chosen: "table" });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- !!<*:: yamlover: $defs: table>\n  - ''\n");
    expect(s1.focus).toEqual(tok(0, 0));
    const site = chapterSiteOf(s1.doc, s1.focus);
    expect(site.cell).toBe("tableCell");
    expect(site.singleRow).toBe(true); // Tab grows COLUMNS from here
  });

  it("• on the boot cell creates a one-item list", () => {
    const s1 = applyChapterIntent(boot(), { kind: "format", chosen: "bullets" });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("- !!<*:: yamlover: $defs: bullets>\n  - ''\n");
    expect(s1.focus).toEqual(tok(0, 0));
    expect(chapterSiteOf(s1.doc, s1.focus).cell).toBe("listItem");
  });

  it("¶ on the boot cell is exactly the first empty chunk", () => {
    const s1 = applyChapterIntent(boot(), { kind: "format", chosen: "chapter" });
    expect(sourceOf(s1.doc)).toBe("- ''\n");
    expect(s1.focus).toEqual(tok(0));
    expect(chapterSiteOf(s1.doc, s1.focus).cell).toBe("prose");
  });

  it("T on the boot cell makes an empty TITLE to type into", () => {
    const s1 = applyChapterIntent(boot(), { kind: "role", role: "title" });
    expect(s1.refused).toBe(false);
    expect(s1.focus).toEqual({ at: "token", path: [] });
    expect(chapterSiteOf(s1.doc, s1.focus).cell).toBe("title");
    const typed = commitChapterText(s1, [], "My chapter");
    expect(sourceOf(typed.doc)).toBe("My chapter\n");
  });

  it("D on the boot cell makes an empty description", () => {
    const s1 = applyChapterIntent(boot(), { kind: "role", role: "desc" });
    expect(s1.refused).toBe(false);
    expect(sourceOf(s1.doc)).toBe("description: ''\n");
    expect(s1.focus).toEqual(tok(0));
    expect(chapterSiteOf(s1.doc, s1.focus).cell).toBe("description");
  });

  it("Ctrl+Enter from a split cell's INNER chunk still appends a row", () => {
    const src = "- !!<*yamlover: $defs: table>\n  - - one\n      - two\n    - b\n";
    const doc = parseSource(src);
    const s0 = { ...initialChapterState(doc), focus: tok(0, 0, 0, 0), caret: null } as ChapterState;
    const s1 = applyChapterKey(s0, { key: "Enter", ctrl: true })!;
    expect(s1).not.toBeNull();
    expect(s1.refused).toBe(false);
    const rows = ((s1.doc.root as Node).entries![0].value as Node).entries!;
    expect(rows.length).toBe(2); // the new row landed
  });
});

describe("the chapter watchdog over the corpora — no dead advertised keys anywhere", () => {
  const roots = [path.join(__dirname, "..", "..", "..", "edit-examples"), path.join(__dirname, "..", "..", "..", "test-examples")];
  const fixtures: { id: string; src: string }[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const name of ["out.yamlover", "in.yamlover"]) {
        const f = path.join(root, dir, name);
        if (fs.existsSync(f)) { fixtures.push({ id: `${path.basename(root)}/${dir}/${name}`, src: fs.readFileSync(f, "utf8") }); break; }
      }
    }
  }

  it("every corpus doc, every chapter position, every advertised key: claimed ⇒ responds", () => {
    expect(fixtures.length).toBeGreaterThan(20);
    for (const f of fixtures) {
      let doc;
      try { doc = parseSource(f.src); } catch { continue; } // non-yamlover fixtures skip
      const s0 = initialChapterState(doc);
      for (const pos of chapterPositionsOf(doc)) {
        const s = { ...s0, focus: pos };
        try {
          chapterWatchdog(s);
        } catch (e) {
          throw new Error(`${f.id} @ ${JSON.stringify(pos)}: ${(e as Error).message}`);
        }
      }
    }
  });
});
