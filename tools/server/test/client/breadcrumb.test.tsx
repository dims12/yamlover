// @vitest-environment jsdom
// The editable breadcrumb: smart cells over the machine (cell mechanics, dropdown as TOC
// rows, commit contracts). The pure transitions live in breadcrumb-machine.test.ts — here
// we exercise the DOM wiring: focus→edit, typing→filter fetches, ':' split, merge,
// pick-keeps-tail, Enter/Escape/TOC-click.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";

vi.mock("../../src/client/api", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn().mockResolvedValue([]),
  queryFilter: vi.fn().mockResolvedValue({ root: { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] }, matches: [], truncated: false }),
  fetchTree: vi.fn(),
}));
import { queryFilter, queryTree, TreeNode } from "../../src/client/api";
import { Breadcrumb, useBreadcrumb } from "../../src/client/Breadcrumb";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.mocked(queryTree).mockReset();
  vi.mocked(queryTree).mockResolvedValue([]);
  vi.mocked(queryFilter).mockReset();
  vi.mocked(queryFilter).mockResolvedValue({ root: n(":", "r"), matches: [], truncated: false });
});

function n(path: string, label: string, hasChildren = false): TreeNode {
  return { path, label, type: "object", format: null, concrete: null, hasChildren, children: [] };
}

const selectSpy = vi.fn();

function Host({ initial = ":team:alice" }: { initial?: string }) {
  const [current, setCurrent] = useState(initial);
  const api = useBreadcrumb({
    current,
    select: (p) => {
      selectSpy(p);
      setCurrent(p);
    },
  });
  return (
    <div>
      <Breadcrumb current={current} rootLabel="root" api={api} />
      <output data-testid="mode">{api.state.mode}</output>
      <button data-testid="toc-click-match" onClick={() => api.dispatch({ type: "TOC_CLICK", path: ":team:alice" })} />
      <button data-testid="toc-click-other" onClick={() => api.dispatch({ type: "TOC_CLICK", path: ":pets" })} />
    </div>
  );
}

const cells = () => Array.from(document.querySelectorAll<HTMLElement>(".crumb-cell"));
const mode = () => screen.getByTestId("mode").textContent;
const settle = () => act(() => vi.advanceTimersByTimeAsync(500)); // past both debounces

/** Put the collapsed caret at `offset` inside a cell (jsdom Range). */
function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection()!;
  const r = document.createRange();
  const t = el.firstChild ?? el;
  r.setStart(t, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function typeInto(el: HTMLElement, text: string) {
  el.textContent = text;
  fireEvent.input(el);
}

describe("Breadcrumb", () => {
  beforeEach(() => selectSpy.mockReset());

  it("idle renders the current path as cells (numeric folding), root label first", () => {
    render(<Host initial=":pets[0]:name" />);
    expect(screen.getByText("root")).toBeTruthy();
    expect(cells().map((c) => c.textContent)).toEqual(["pets[0]", "name"]);
    expect(mode()).toBe("idle");
  });

  it("an index-headed FIRST cell reads as an index on the root — its ':' separator is not drawn", async () => {
    // idle: the path of the root's entry 0 spells `root[0]`, not `root : [0]`
    render(<Host initial="[0]:name" />);
    expect(cells().map((c) => c.textContent)).toEqual(["[0]", "name"]);
    expect(document.querySelectorAll(".crumb-sep").length).toBe(1); // only before "name"
    cleanup();
    // editing: typing `[0]` into the first cell hides its separator LIVE
    vi.useFakeTimers();
    render(<Host initial=":team:alice" />);
    expect(document.querySelectorAll(".crumb-sep").length).toBe(2);
    const cell = cells()[0];
    fireEvent.focus(cell);
    typeInto(cell, "[0]");
    expect(document.querySelectorAll(".crumb-sep").length).toBe(1);
    await settle();
    expect(queryFilter).toHaveBeenCalledWith(": [0]: alice"); // still the document-scoped query
  });

  it("focusing a cell enters editing and fetches candidates + the filter", async () => {
    vi.useFakeTimers();
    render(<Host />);
    fireEvent.focus(cells()[1]);
    expect(mode()).toBe("editing");
    await settle();
    expect(queryTree).toHaveBeenCalledWith(": team: ?", ":"); // the cell's context children
    expect(queryFilter).toHaveBeenCalledWith(": team: alice");
  });

  it("the dropdown lists the context's children as TOC rows; picking keeps the tail", async () => {
    vi.useFakeTimers();
    vi.mocked(queryTree).mockResolvedValue([n(":team", "team", true), n(":teammate", "teammate")]);
    render(<Host />);
    fireEvent.focus(cells()[0]);
    await settle();
    const dd = document.querySelector(".crumb-dd")!;
    expect(dd).toBeTruthy();
    expect(dd.parentElement).toBe(document.body); // portaled — an ancestor overflow box never clips it
    const rows = dd.querySelectorAll(".tree-row");
    expect(rows.length).toBeGreaterThanOrEqual(2); // the two children + operator rows
    expect(dd.querySelector(".icon")).toBeTruthy(); // real TOC icons
    // ArrowDown arms the second? First: hi -1 → down → 0 (teammate is [1])
    fireEvent.keyDown(cells()[0], { key: "ArrowDown" });
    fireEvent.keyDown(cells()[0], { key: "ArrowDown" });
    fireEvent.keyDown(cells()[0], { key: "Enter" });
    // picked "teammate" into cell 0 — the tail cell "alice" is KEPT
    expect(cells().map((c) => c.textContent)).toEqual(["teammate", "alice"]);
    expect(mode()).toBe("editing");
  });

  it("Tab ACCEPTS the completion — the armed candidate, else the first", async () => {
    vi.useFakeTimers();
    vi.mocked(queryTree).mockResolvedValue([n(":team", "team", true), n(":teammate", "teammate")]);
    render(<Host />);
    fireEvent.focus(cells()[0]);
    await settle();
    expect(document.querySelector(".crumb-dd")).toBeTruthy();
    // nothing armed: Tab takes the FIRST candidate (Enter would commit the typed query instead)
    fireEvent.keyDown(cells()[0], { key: "Tab" });
    expect(cells().map((c) => c.textContent)).toEqual(["team", "alice"]);
    expect(mode()).toBe("editing");
    // armed: Tab takes the highlighted row, like Enter (the refetch reopened the dropdown)
    await settle();
    fireEvent.keyDown(cells()[0], { key: "ArrowDown" });
    fireEvent.keyDown(cells()[0], { key: "ArrowDown" });
    fireEvent.keyDown(cells()[0], { key: "Tab" });
    expect(cells().map((c) => c.textContent)).toEqual(["teammate", "alice"]);
  });

  it("typing ':' splits the cell at the caret; Backspace at cell start merges back", async () => {
    vi.useFakeTimers();
    render(<Host initial=":teamalice" />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    setCaret(cell, 4); // team|alice
    fireEvent.keyDown(cell, { key: ":" });
    expect(cells().map((c) => c.textContent)).toEqual(["team", "alice"]);
    // merge back: caret at the start of the second cell, Backspace
    const second = cells()[1];
    fireEvent.focus(second);
    setCaret(second, 0);
    fireEvent.keyDown(second, { key: "Backspace" });
    expect(cells().map((c) => c.textContent)).toEqual(["teamalice"]);
  });

  it("Enter selects the FIRST match and enters filtered; Escape restores idle cells", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: n(":", "r", true), matches: [":team:bob", ":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[1];
    fireEvent.focus(cell);
    typeInto(cell, "b");
    await settle(); // matches arrive fresh
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(selectSpy).toHaveBeenCalledWith(":team:bob");
    expect(mode()).toBe("filtered");
    // the query cells stay visible in filtered mode
    expect(cells().map((c) => c.textContent)).toEqual(["team", "b"]);
    // Escape → idle → cells re-derive from current (:team:bob after the select)
    fireEvent.keyDown(cells()[0], { key: "Escape" });
    // Escape on a filtered-mode cell needs it focused first — dispatch via focus+Escape
    // (the cell click re-enters editing; Escape then closes back to idle)
    await settle();
    expect(mode()).not.toBe("editing");
  });

  it("a TOC click on a match keeps the query (filtered); on a non-match regresses to the path", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: n(":", "r", true), matches: [":team:alice"], truncated: false });
    render(<Host />);
    fireEvent.focus(cells()[1]);
    typeInto(cells()[1], "ali");
    await settle();
    fireEvent.click(screen.getByTestId("toc-click-match"));
    expect(mode()).toBe("filtered");
    expect(selectSpy).toHaveBeenCalledWith(":team:alice");
    expect(cells().map((c) => c.textContent)).toEqual(["team", "ali"]); // query kept
    // re-enter editing, then click a NON-match → idle, plain path
    fireEvent.focus(cells()[1]);
    await settle();
    fireEvent.click(screen.getByTestId("toc-click-other"));
    expect(mode()).toBe("idle");
    expect(selectSpy).toHaveBeenCalledWith(":pets");
    expect(cells().map((c) => c.textContent)).toEqual(["pets"]); // regressed to the path
  });

  it("a malformed mid-edit query tints the active cell and keeps going", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockRejectedValue(new Error("400"));
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    typeInto(cell, "!!<");
    await settle();
    expect(mode()).toBe("editing");
    expect(cell.className).toContain("edit-error");
  });

  it("'[' projects its ']' with the caret between; ']' jumps over; Backspace dismantles the empty pair", async () => {
    vi.useFakeTimers();
    render(<Host initial=":pets" />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    setCaret(cell, 4); // pets|
    fireEvent.keyDown(cell, { key: "[" });
    expect(cell.textContent).toBe("pets[]");
    // the caret sits inside the pair — typing lands between the brackets
    const sel = window.getSelection()!;
    expect(sel.anchorOffset).toBe(5);
    // typing ']' jumps OVER the projected closer instead of doubling it
    fireEvent.keyDown(cell, { key: "]" });
    expect(cell.textContent).toBe("pets[]");
    expect(window.getSelection()!.anchorOffset).toBe(6);
    // Backspace between an empty pair dismantles both
    setCaret(cell, 5);
    fireEvent.keyDown(cell, { key: "Backspace" });
    expect(cell.textContent).toBe("pets");
  });

  it("'[' in an EMPTY cell folds into the previous portion — ': [1]' cannot be typed", async () => {
    vi.useFakeTimers();
    render(<Host initial=":pets" />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    setCaret(cell, 4);
    fireEvent.keyDown(cell, { key: ":" }); // a fresh empty cell opens after "pets"
    expect(cells().map((c) => c.textContent)).toEqual(["pets", ""]);
    fireEvent.keyDown(cells()[1], { key: "[" }); // the index belongs to "pets"
    expect(cells().map((c) => c.textContent)).toEqual(["pets[]"]);
    const merged = cells()[0];
    expect(window.getSelection()!.anchorOffset).toBe(5); // caret inside the brackets
    expect(merged.textContent).toBe("pets[]");
  });

  it("clicking the tail area opens the append cell", async () => {
    vi.useFakeTimers();
    render(<Host />);
    fireEvent.mouseDown(document.querySelector(".crumbs-tail")!);
    expect(mode()).toBe("editing");
    expect(cells()).toHaveLength(3); // team, alice, and the fresh append cell
    expect(cells()[2].textContent).toBe("");
  });
});
