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
      const sourceKind = SOURCE_KINDS.has(kind) && cell.closest(".chunk-source") !== null;
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
