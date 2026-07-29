// @vitest-environment jsdom
// THE CHAPTER DOM-TYPING LAWS — real key events over the NEW cells, the caret asserted a
// member of the CLOSED focus-home set after EVERY interaction, the watchdog after every
// applied state. The reported-bug scenarios live here: the vanishing title (Enter after a
// fresh wrap), the dead Delete before a subchapter (the dissolve), the Backspace mirror,
// the ring on a refused join, and "typing rewrites NO DOM" (the identity guard).
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { sourceOf } from "../src/state";
import { chapterWatchdog } from "../src/chapter/watchdog";
import { caretVisibleOffset } from "../src/chapter/caret";
import { plainCodec } from "../src/chapter/cells";
import { focusedHome, mountChapter, setCaret, type ChapterHarness } from "./chapter-cells-kit";

afterEach(cleanup);

/** Assert the caret home + run the watchdog — after every step of every scenario. */
function lawCheck(h: ChapterHarness, step: string): void {
  expect(focusedHome(), `after ${step}: activeElement is ${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className}`).toBe(true);
  chapterWatchdog(h.state());
}

const prose = (h: ChapterHarness, n: number): HTMLElement =>
  h.container.querySelectorAll(".y2-cell[data-kind=prose] .chapter-prose")[n] as HTMLElement;

/** Type text into a focused contentEditable the way a browser does: DOM first, input after. */
function typeInto(h: ChapterHarness, el: HTMLElement, text: string): void {
  el.textContent = (el.textContent ?? "") + text;
  setCaret(el, (el.textContent ?? "").length);
  fireEvent.input(el);
}

describe("chapter dom-typing — the reported bugs, pinned in real events", () => {
  it("Tab NESTS as a plain paragraph; T titles it; typed title SURVIVES Enter", () => {
    const h = mountChapter("- p1\n- fresh\n");
    const p = prose(h, 1);
    fireEvent.focus(p);
    setCaret(p, 5);
    lawCheck(h, "focus");
    fireEvent.keyDown(p, { key: "Tab" });
    lawCheck(h, "Tab (nest)");
    // the nest kept a PARAGRAPH focused — one level deeper, inside a badged group (localized)
    expect((document.activeElement as HTMLElement).classList.contains("chapter-prose")).toBe(true);
    expect(sourceOf(h.state().doc)).toBe("- p1\n- - fresh\n");
    expect(h.container.querySelector(".y2-cell[data-kind=chapter] .y2-badge")?.textContent).toContain("wrapped");
    // T makes the group's TITLE (the explicit role)
    h.dispatch({ kind: "role", role: "title" });
    lawCheck(h, "T (title)");
    const input = document.activeElement as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("fresh");
    // type through the CONTROLLED input — per-keystroke commits, no commit-on-Enter race
    fireEvent.change(input, { target: { value: "fresh chapter" } });
    expect(sourceOf(h.state().doc)).toContain("fresh chapter");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    lawCheck(h, "Enter");
    expect(h.container.textContent).toContain("fresh chapter");
    expect(sourceOf(h.state().doc)).toBe("- p1\n- fresh chapter\n  - ''\n");
    expect((document.activeElement as HTMLElement).classList.contains("chapter-prose")).toBe(true);
    h.unmount();
  });

  it("Delete at the end before a SUBCHAPTER dissolves its title in — the dead key lives", () => {
    const h = mountChapter("- intro\n- Dogs\n  - woof\n- tail\n");
    const p = prose(h, 0);
    fireEvent.focus(p);
    setCaret(p, 5); // "intro" — the end
    lawCheck(h, "focus");
    fireEvent.keyDown(p, { key: "Delete" });
    lawCheck(h, "Delete (dissolve)");
    expect(sourceOf(h.state().doc)).toBe("- introDogs\n- woof\n- tail\n");
    const el = document.activeElement as HTMLElement;
    expect(el.textContent).toBe("introDogs");
    expect(caretVisibleOffset(el), "the caret sits at the junction").toBe(5); // consumed from state, planted in the DOM
    h.unmount();
  });

  it("Backspace at a subchapter TITLE's start mirrors the dissolve", () => {
    const h = mountChapter("- intro\n- Dogs\n  - woof\n");
    // click the inactive title face — the input swaps in
    const face = h.container.querySelector("section.chapter-sub .chapter-title-text") as HTMLElement;
    fireEvent.focus(face);
    const input = document.activeElement as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "Backspace" });
    lawCheck(h, "Backspace (title dissolve)");
    expect(sourceOf(h.state().doc)).toBe("- introDogs\n- woof\n");
    h.unmount();
  });

  it("a REFUSED join RINGS — visibly, on the focused cell", () => {
    const h = mountChapter("description: d\n- p\n");
    const p = prose(h, 0);
    fireEvent.focus(p);
    setCaret(p, 0);
    fireEvent.keyDown(p, { key: "Backspace" }); // the description is not absorbable
    lawCheck(h, "Backspace (refused)");
    expect(h.state().refused).toBe(true);
    expect(h.container.querySelector(".y2-cell.y2-refused")).toBeTruthy();
    h.unmount();
  });

  it("TYPING rewrites no DOM — the identity guard (state echoes, innerHTML untouched)", () => {
    const h = mountChapter("T\n- hello\n", { codec: { ...plainCodec } });
    const toHtml = vi.spyOn(h.codec, "toHtml");
    const p = prose(h, 0);
    fireEvent.focus(p);
    setCaret(p, 5);
    const before = toHtml.mock.calls.length;
    typeInto(h, p, " there");
    typeInto(h, p, " again");
    expect(sourceOf(h.state().doc)).toContain("hello there again");
    expect(toHtml.mock.calls.length, "a keystroke must not re-render the prose DOM").toBe(before);
    h.unmount();
  });

  it("a PROGRAMMATIC divergence (the split head) DOES reconcile the DOM", () => {
    const h = mountChapter("T\n- headtail\n- after\n");
    const p = prose(h, 0);
    fireEvent.focus(p);
    setCaret(p, 4);
    fireEvent.keyDown(p, { key: "Enter" });
    lawCheck(h, "Enter (split)");
    const texts = Array.from(h.container.querySelectorAll(".y2-cell[data-kind=prose] .chapter-prose")).map((x) => x.textContent);
    expect(texts).toEqual(["head", "tail", "after"]); // the head's DOM was rewritten from state
    expect((document.activeElement as HTMLElement).textContent).toBe("tail");
    h.unmount();
  });

  it("the arrow walk crosses title → description → prose, planted each landing", () => {
    const h = mountChapter("T\ndescription: d\n- p\n");
    // opens in the title input
    lawCheck(h, "open");
    expect((document.activeElement as HTMLInputElement).value).toBe("T");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    lawCheck(h, "ArrowDown 1");
    expect((document.activeElement as HTMLInputElement).value).toBe("d");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    lawCheck(h, "ArrowDown 2");
    expect((document.activeElement as HTMLElement).classList.contains("chapter-prose")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    lawCheck(h, "ArrowUp");
    expect((document.activeElement as HTMLInputElement).value).toBe("d");
    h.unmount();
  });

  it("the table Tab walk: header → rows → APPEND at the last cell — inputs all the way", () => {
    const h = mountChapter("T\n- !!<*yamlover: $defs: table>\n  header:\n    - A\n    - B\n  - - '1'\n    - '2'\n");
    const faces = h.container.querySelectorAll(".y2-cell[data-kind=cell] .yl-cell");
    fireEvent.focus(faces[0]); // A
    lawCheck(h, "cell focus");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    lawCheck(h, "Tab 1");
    expect((document.activeElement as HTMLInputElement).value).toBe("B");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    lawCheck(h, "Tab 2 (wraps to the data row)");
    expect((document.activeElement as HTMLInputElement).value).toBe("1");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    lawCheck(h, "Tab 4 (append)");
    expect(h.container.querySelectorAll("tbody tr").length).toBe(2);
    expect((document.activeElement as HTMLInputElement).value).toBe("");
    h.unmount();
  });

  it("typing into the BOOTSTRAP births the first entry and keeps the caret", () => {
    const h = mountChapter("");
    lawCheck(h, "open (boot)");
    const boot = document.activeElement as HTMLElement;
    expect(boot.getAttribute("data-placeholder")).toBe("Write…");
    typeInto(h, boot, "Hello");
    expect(sourceOf(h.state().doc)).toBe("- Hello\n");
    lawCheck(h, "first text");
    expect((document.activeElement as HTMLElement).classList.contains("chapter-prose")).toBe(true);
    h.unmount();
  });
});
