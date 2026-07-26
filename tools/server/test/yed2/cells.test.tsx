// @vitest-environment jsdom
// yed2 D1 GATE — the recursive projection: every cell framed and TITLED with its kind, the same
// closed set at every depth, the gap visible, the active cell marked. EditorView is pure over its
// props, so the test hands it a state and reads the DOM.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EditorView } from "../../src/client/yed2/page";
import { parseSource, initialState, type EditorState } from "../../src/client/yed2/state";
import { applyKey } from "../../src/client/yed2/apply";
import { parseScript } from "./keys-util";

afterEach(cleanup);

const stateFor = (src: string): EditorState => ({
  doc: parseSource(src), cursor: { at: "after", path: [] }, refused: false, log: [],
});

const kindsOf = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll("[data-kind]")).map((el) => el.getAttribute("data-kind")!);

describe("yed2 cells — the projection is visible", () => {
  it("renders {a: [1, {b: 2}]} with titled, nested cells of the closed set", () => {
    const state = stateFor("a: {q: [1, 2], b: 2}\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const kinds = kindsOf(container);
    // the closed set only, and the nesting is present (a map inside the block root, a seq inside it)
    expect(new Set(kinds)).toEqual(new Set(["block", "key", "map", "seq", "token", "gap"]));
    expect(kinds.filter((k) => k === "token")).toHaveLength(3); // 1, 2, 2
    expect(kinds.filter((k) => k === "gap")).toHaveLength(2);   // after the seq, after the map
    // every framed cell carries its visible caption
    for (const cell of Array.from(container.querySelectorAll(".y2-cell"))) {
      expect(cell.querySelector(".y2-tag")?.textContent).toBeTruthy();
    }
  });

  it("the ACTIVE cell is marked, and a typed state shows the hole", () => {
    let state = initialState();
    for (const k of parseScript("[1, ")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-cell.y2-hole.y2-active")).toBeTruthy();
    expect(container.querySelector("[data-testid=y2-source]")?.textContent).toContain("[1]");
  });

  it("the legend shows enabled and disabled keys for the current site", () => {
    let state = initialState();
    for (const k of parseScript("[1")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const caps = Array.from(container.querySelectorAll(".y2-keycap"));
    const byLabel = Object.fromEntries(caps.map((c) => [c.textContent, c.className]));
    expect(byLabel["]"]).toContain("y2-on");   // the right closer has a meaning
    expect(byLabel[","]).toContain("y2-on");
    expect(byLabel["}"]).toContain("y2-on");   // interpret says refuse — a MEANING (the visible ring)
    expect(byLabel[":"]).toContain("y2-off");  // no meaning in a seq hole
  });

  it("a refused state rings the active cell", () => {
    let state = initialState();
    for (const k of parseScript("{{12}")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    expect(state.refused).toBe(true);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-refused")).toBeTruthy();
    expect(container.querySelector("[data-testid=y2-cursor]")?.textContent).toContain("REFUSED");
  });
});
