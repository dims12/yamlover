// @vitest-environment jsdom
// THE CHAPTER CELL LAWS — the structural contract (the chapter twin of cells.test.tsx):
// one closed framed set, every cell captioned, active/refused visible, the positions law
// asserted IN THE DOM, debug/plain one class apart, the view pure over its props.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { CHAPTER_CELL_KINDS } from "../src/chapter/cells";
import { chapterPositionsOf } from "../src/chapter/positions";
import { inSourceChunk } from "../src/chapter/site";
import { mountChapter } from "./chapter-cells-kit";

afterEach(cleanup);

const RICH =
  "The Handbook\n" +
  "description: all of it\n" +
  "- opening prose\n" +
  "- Dogs\n  description: our friends\n  - Dogs bark.\n" +
  "- !!<*yamlover: $defs: bullets>\n  - feed daily\n  - fresh water\n" +
  "- !!<*yamlover: $defs: table>\n  header:\n    - A\n    - B\n  - - '1'\n    - '2'\n" +
  "- !!<format: text/x-latex> 'e = mc^2'\n" +
  "- !!<*yamlover: $defs: recipe>\n  serves: 4\n" +
  "- closing words\n";

const SOURCE_KINDS = new Set(["hole", "gap", "token", "key", "tag", "block", "seq", "map", "omni", "pointer", "blob"]);

describe("the chapter cell laws", () => {
  it("ONE closed set: every framed cell is a chapter kind (or a source kind inside a source chunk), every cell CAPTIONED", () => {
    const h = mountChapter(RICH);
    const cells = Array.from(h.container.querySelectorAll(".y2-cell"));
    expect(cells.length).toBeGreaterThan(8);
    for (const cell of cells) {
      const kind = cell.getAttribute("data-kind")!;
      const chapterKind = (CHAPTER_CELL_KINDS as readonly string[]).includes(kind);
      const sourceKind = SOURCE_KINDS.has(kind) && cell.closest(".chunk-source, .chunk-ref") !== null;
      expect(chapterKind || sourceKind, `unexpected cell kind ${kind}`).toBe(true);
      expect(cell.querySelector(".y2-tag")?.textContent, `uncaptioned ${kind}`).toBeTruthy();
    }
    // the rich fixture exercises the whole chapter set except boot
    const kinds = new Set(cells.map((c) => c.getAttribute("data-kind")));
    for (const k of ["title", "description", "prose", "item", "table", "cell", "latex", "source", "chapter"]) {
      expect(kinds.has(k), `kind ${k} not drawn`).toBe(true);
    }
    h.unmount();
  });

  it("exactly ONE chapter cell is ACTIVE, and it matches the state's focus", () => {
    const h = mountChapter("T\n- p1\n- p2\n");
    const chapterActive = () =>
      Array.from(h.container.querySelectorAll(".y2-cell.y2-active"))
        .filter((c) => (CHAPTER_CELL_KINDS as readonly string[]).includes(c.getAttribute("data-kind")!));
    expect(chapterActive().length).toBe(1);
    expect(chapterActive()[0].getAttribute("data-kind")).toBe("title"); // opens in the first cell
    h.dispatch({ kind: "move", dir: 1 });
    expect(chapterActive().length).toBe(1);
    expect(chapterActive()[0].getAttribute("data-path")).toBe("0");
    h.unmount();
  });

  it("a RAW pointer chunk faces as a reference LINE — never a title (nothing local says the target is one)", () => {
    const h = mountChapter("Structured\n- some prose\n- *..:..:..\n");
    const atom = h.container.querySelector('.y2-cell[data-kind=atom]')!;
    expect(atom).toBeTruthy();
    // the pointer identity from the source editor (`*` + authored spelling), not a heading
    const ref = atom.querySelector(".chunk-ref .y2-p")!;
    expect(ref.textContent).toContain("..:..:..");
    expect(atom.querySelector(".chapter-title")).toBeNull();
    expect(atom.querySelector(".descend")).toBeNull(); // no fake hyperlink to an unresolved raw
    h.unmount();
  });

  it("…and the reference is EDITABLE: Enter on the atom opens the PICK face, Escape-less abandon keeps it", () => {
    const h = mountChapter("Structured\n- some prose\n- *..:..:..\n");
    const ptr = h.container.querySelector('.y2-cell[data-kind=atom] .y2-p') as HTMLElement;
    fireEvent.keyDown(ptr, { key: "Enter" });
    // the nested yed editor's pick cursor: the raw decomposes into PORTION cells (the
    // retarget face) - the caret's input holds the LAST portion, the rest are idle spans
    const input = h.container.querySelector('.y2-cell[data-kind=atom] .y2-pick input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("..");
    const idle = h.container.querySelectorAll('.y2-cell[data-kind=atom] .y2-pick .y2-portion');
    expect(Array.from(idle).map((el) => el.textContent)).toEqual(["..", ".."]);
    h.unmount();
  });

  it("…and the WALK passes the reference: arrows hand off to the chapter at the wrapper's edge, no ring", () => {
    const h = mountChapter("Structured\n- above\n- *..:..:..\n- below\n");
    h.update({ ...h.state(), focus: { at: "ptr", path: [1] }, caret: null });
    const ptr = h.container.querySelector('.y2-cell[data-kind=atom] .y2-p') as HTMLElement;
    fireEvent.keyDown(ptr, { key: "ArrowDown" });
    expect(h.state().focus).toEqual({ at: "token", path: [2] }); // …onto "below"
    expect(h.state().refused).toBe(false);
    h.update({ ...h.state(), focus: { at: "ptr", path: [1] }, caret: null });
    fireEvent.keyDown(ptr, { key: "ArrowUp" });
    expect(h.state().focus).toEqual({ at: "token", path: [0] }); // …onto "above"
    expect(h.state().refused).toBe(false);
    h.unmount();
  });

  it("…and Backspace on the emptied reference DISSOLVES the chunk into an empty paragraph", () => {
    const h = mountChapter("Structured\n- some prose\n- *..:..:..\n");
    const ptr = h.container.querySelector('.y2-cell[data-kind=atom] .y2-p') as HTMLElement;
    fireEvent.keyDown(ptr, { key: "Backspace" }); // removeLevel: the pointer leaves the wrapper
    // the chunk grafted back as an empty paragraph — a prose cell stands where the atom was
    expect(h.container.querySelector('.y2-cell[data-kind=atom]')).toBeNull();
    const prose = h.state().doc;
    expect(JSON.stringify(prose.root)).not.toContain("pointer");
    h.unmount();
  });

  it("the NEST is a LOCALIZED state: the group's caption carries the badge", () => {
    const h = mountChapter("- p1\n- fresh\n");
    h.update({ ...h.state(), focus: { at: "token", path: [1] }, caret: null });
    h.dispatch({ kind: "nest" });
    const badge = h.container.querySelector(".y2-cell.y2-chapter .y2-tag .y2-badge");
    expect(badge?.textContent).toContain("wrapped");
    h.unmount();
  });

  it("a REFUSED key RINGS the active cell", () => {
    const h = mountChapter("description: d\n- p\n");
    h.update({ ...h.state(), focus: { at: "token", path: [1] }, caret: null });
    h.dispatch({ kind: "joinPrev" }); // the description is not absorbable — the ring
    expect(h.state().refused).toBe(true);
    const rung = h.container.querySelector(".y2-cell.y2-refused");
    expect(rung).toBeTruthy();
    expect(rung!.getAttribute("data-kind")).toBe("prose");
    h.unmount();
  });

  it("THE POSITIONS LAW, in the DOM: every walk stop has exactly one stamped cell with a focusable home", () => {
    const h = mountChapter(RICH);
    const doc = h.state().doc;
    for (const pos of chapterPositionsOf(doc)) {
      if (inSourceChunk(doc, pos.path) ) continue; // the source sub-walk is yed's own cells
      const sel = `.y2-cell[data-at="${pos.at}"][data-path="${pos.path.join(".")}"]`;
      const cells = h.container.querySelectorAll(sel);
      expect(cells.length, `position ${pos.at}@${pos.path.join(".")} drew ${cells.length} cells`).toBe(1);
      const home = cells[0].querySelector("input, [contenteditable], textarea, [tabindex]");
      expect(home, `position ${pos.at}@${pos.path.join(".")} has no focusable home`).toBeTruthy();
    }
    h.unmount();
  });

  it("debug and plain are ONE class apart — the same DOM", () => {
    // an embedded source chunk's own mode class normalizes too — the DOM is otherwise identical
    const norm = (html: string): string => html.replace(/y2-debug|y2-plain/g, "y2-MODE");
    const a = mountChapter(RICH, { debug: true });
    const debugHtml = norm(a.container.innerHTML);
    a.unmount();
    cleanup();
    const b = mountChapter(RICH, { debug: false });
    const plainHtml = norm(b.container.innerHTML);
    expect(debugHtml).toBe(plainHtml);
    b.unmount();
  });

  it("the view is PURE over its props: a forced re-render changes nothing", () => {
    const h = mountChapter(RICH);
    const before = h.container.innerHTML;
    h.rerender();
    expect(h.container.innerHTML).toBe(before);
    h.unmount();
  });

  it("clicking an INACTIVE line face swaps in the controlled input, focused", () => {
    const h = mountChapter("T\n- p\n");
    const face = h.container.querySelector(".y2-cell[data-kind=description] .chapter-subtitle, .y2-cell[data-kind=prose] .chapter-prose");
    const prose = h.container.querySelector(".y2-cell[data-kind=prose] .chapter-prose") as HTMLElement;
    expect(face ?? prose).toBeTruthy();
    fireEvent.focus(prose);
    expect(h.state().focus).toEqual({ at: "token", path: [0] });
    expect(h.state().caret).toBeNull(); // the browser's caret stands
    h.unmount();
  });
});

// ---------------------------------------------------------------------------- //
// Membership tag chips — the adapter's renderTags seam (display-only chrome)
// ---------------------------------------------------------------------------- //

describe("membership tag chips (adapter renderTags)", () => {
  // a tagged chunk (ordinal bookmark), a plain chunk, an ALIAS (keyed) bookmark that must be
  // filtered, and a tagged subchapter
  const TAGGED =
    "T\n" +
    "- plain prose\n" +
    "- tagged prose\n  &::ontos:urgent:-\n" +
    "- aliased prose\n  &::ontos:alias\n" +
    "- Sub\n  &::ontos:review:-\n  - inner\n";

  it("no adapter hook -> no tag chrome at all", () => {
    const h = mountChapter(TAGGED);
    expect(h.container.querySelector(".chunk-tags")).toBeNull();
    expect(h.container.querySelector(".title-tags")).toBeNull();
    h.unmount();
  });

  it("renders chips on the tagged chunk and subchapter title; keyed aliases are filtered; the root title stays bare", () => {
    const seen: string[][] = [];
    const h = mountChapter(TAGGED, {
      adapter: {
        renderTags: (anchors) => {
          seen.push(anchors.map((a) => a.path.raw ?? ""));
          return <span className="tt-stub">{anchors.length}</span>;
        },
      },
    });
    // the tagged chunk carries a .chunk-tags row; the plain and aliased chunks carry none
    const chunks = Array.from(h.container.querySelectorAll(".chunk"));
    const withTags = chunks.filter((c) => c.querySelector(":scope > .chunk-tags"));
    expect(withTags.length).toBe(1);
    expect(withTags[0].textContent).toContain("tagged prose");
    // the subchapter's heading carries a .title-tags span; the ROOT title (path []) never does
    expect(h.container.querySelectorAll(".title-tags").length).toBe(1);
    const rootTitle = h.container.querySelector(".y2-cell[data-kind=title]")!.closest("h1, h2")!;
    expect(rootTitle.querySelector(".title-tags")).toBeNull();
    // only ORDINAL anchors reach the hook — the keyed alias never shows
    expect(seen.flat().every((raw) => raw.includes("urgent") || raw.includes("review"))).toBe(true);
    h.unmount();
  });

  it("a chip mousedown never moves the caret out of the active cell", () => {
    const h = mountChapter(TAGGED, {
      adapter: { renderTags: () => <span className="tt-stub">t</span> },
    });
    // focus the tagged prose chunk
    h.update({ ...h.state(), focus: { at: "token", path: [1] }, caret: "end" });
    const before = document.activeElement;
    expect(before).not.toBe(document.body);
    fireEvent.mouseDown(h.container.querySelector(".chunk-tags .tt-stub")!);
    expect(document.activeElement).toBe(before);
    h.unmount();
  });
});
