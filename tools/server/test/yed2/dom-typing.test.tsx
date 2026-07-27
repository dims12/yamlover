// @vitest-environment jsdom
// yed2 — DOM-LEVEL typing: the same laws the pure suites pin, exercised through the REAL key
// plumbing (CellInput onKeyDown/onChange, focus hand-off between cells). The pure corpus replays
// applyKey directly and cannot see a browser-layer defect — this suite types into the DOM.
// THE CARET IS PINNED after every step: document.activeElement must be the active cell's input
// (a cursor the projection does not draw is exactly the reported focus-loss bug).
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { DebugEditorPage, EditorView } from "../../src/client/yed2/page";
import { watchdog } from "../../src/client/yed2/apply";
import { initialState, sourceOf, type EditorState } from "../../src/client/yed2/state";

afterEach(cleanup);

let lastState: EditorState = initialState();

function Harness() {
  const [state, setState] = useState<EditorState>(initialState);
  lastState = state;
  return <EditorView state={state} setState={setState} />;
}

/** The focused editor cell — after EVERY keystroke the caret must live in a cell input or on a
 *  gap slot (the two focusable cell homes). BODY means the caret fell off the projection. */
function focusedInput(): HTMLInputElement {
  const el = document.activeElement;
  const ok = el !== null && ((el.tagName === "INPUT" && el.classList.contains("y2-input")) || el.classList.contains("y2-gapslot"));
  expect(ok, `the caret must be in a cell, but activeElement is ${el ? el.tagName + "." + el.className : "null"}`).toBe(true);
  return el as HTMLInputElement;
}

/** Type a string of printables + named keys through real DOM events on the focused input.
 *  `⏎` = Enter, `⇤` = Shift-Tab, `←`/`→` = arrows. */
function domType(script: string): void {
  for (const ch of script) {
    const input = focusedInput();
    const key = ch === "⏎" ? "Enter" : ch === "⇤" ? "Tab" : ch === "←" ? "ArrowLeft" : ch === "→" ? "ArrowRight"
      : ch === "↑" ? "ArrowUp" : ch === "↓" ? "ArrowDown" : ch;
    const before = input.value;
    const defaulted = fireEvent.keyDown(input, { key, shiftKey: ch === "⇤" });
    // a printable the grammar left alone reaches the controlled input as an onChange
    if (key.length === 1 && defaulted) {
      fireEvent.change(input, { target: { value: before + key } });
    }
    watchdog(lastState); // no state a DOM keystroke reaches may hold a dead advertised key
    if (process.env.Y2_TRACE) {
      const el = document.activeElement;
      console.log(`after ${JSON.stringify(key)}: focus=${el ? el.tagName + "." + el.className : "null"} cursor=${JSON.stringify(lastState.cursor)}`);
    }
  }
}

/** The `.y2-row` that holds the key cell spelled `label` — the VISUAL line the key sits on. */
function keyRow(label: string): HTMLElement {
  const k = Array.from(document.querySelectorAll(".y2-k")).find((el) => el.textContent === label);
  expect(k, `no key cell spelled ${JSON.stringify(label)}`).toBeTruthy();
  return k!.closest(".y2-row") as HTMLElement;
}

describe("yed2 DOM typing — the reported yaml, through real key events", () => {
  it("`- name: Eurasia` ⏎ ⇤ `children: ` ⏎ `- name: Europe` — the caret NEVER leaves a cell", () => {
    render(<Harness />);
    focusedInput();
    domType("- name: Eurasia⏎⇤children: ⏎- name: Europe→");
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
    focusedInput();
  });

  it("the bare-colon idiom descends the same way (`children:` ⏎, no space)", () => {
    render(<Harness />);
    domType("- name: Eurasia⏎⇤children:⏎- name: Europe→");
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
    focusedInput();
  });

  it("Enter after `children:` WRAPS THE ROW — the hole opens on its own line, never beside the key", () => {
    render(<Harness />);
    domType("- name: Eurasia⏎⇤children:⏎");
    // the reported defect: the projection drew the block child ON the key's line. The key's
    // visual row must hold the key alone; the descended hole lives on an indented row below.
    expect(keyRow("children").querySelector(".y2-hole")).toBeNull();
    expect(document.querySelector(".y2-row.y2-indent .y2-hole")).toBeTruthy();
    domType("- name: Europe→");
    expect(keyRow("children").textContent).not.toContain("Europe"); // the child never shares the key's row
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
  });

  it("a mistaken ⇤ then Tab returns INSIDE — Tab is ALWAYS claimed, never a browser focus jump", () => {
    render(<Harness />);
    domType("- name: Eurasia⏎⇤children:⏎⇤");
    // the reported defect: Tab here was unhandled, so the browser's own Tab walked the focus
    // into the debug panels. The grammar claims Tab — keyDown must come back preventDefaulted.
    const defaulted = fireEvent.keyDown(focusedInput(), { key: "Tab" });
    expect(defaulted, "Tab leaked to the browser — focus would jump out of the editor").toBe(false);
    domType("- name: Europe→");
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
    focusedInput();
  });

  it("the reported LOCK: an empty children value draws a CLICKABLE placeholder — never a wall", () => {
    render(<Harness />);
    domType("- name: Eurasia⏎⇤children:⏎⇤↑"); // the exact reported keys — ↑ walks back inside
    expect(lastState.cursor).toEqual({ at: "hole", path: [0, 1], index: 0, text: "", key: null });
    domType("- name: Europe→");
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
  });

  it("…and the placeholder slot itself is drawn and clickable when the caret is elsewhere", () => {
    render(<Harness />);
    domType("- name: Eurasia⏎⇤children:⏎⇤"); // climbed out — the empty value must stay reachable
    const slot = Array.from(document.querySelectorAll(".y2-cell[data-kind=block] .y2-gapslot")).pop() as HTMLElement;
    expect(slot, "the empty container draws no placeholder slot").toBeTruthy();
    fireEvent.focus(slot);
    expect(lastState.cursor).toEqual({ at: "hole", path: [0, 1], index: 0, text: "", key: null });
    domType("- name: Europe→");
    expect(sourceOf(lastState.doc)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
  });

  it("↑↑ walks ROWS through the DOM: from under `key2: 13` up to `key1: 12`, caret at its end", () => {
    render(<Harness />);
    domType("key1: 12⏎⇤key2: 13⏎↑↑");
    const input = focusedInput();
    expect(input.value).toBe("12");
    expect(input.selectionStart).toBe(2); // the caret landed at the END of the row's value
  });

  it("the CONVERSION ladder through the DOM: Backspace at value2's start un-names, then makes it THE value", () => {
    render(<Harness />);
    domType("- value1⏎⇤key2: value2→");
    const input = focusedInput();
    expect(input.value).toBe("value2");
    input.setSelectionRange(0, 0);                       // Home — the reported caret position
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(sourceOf(lastState.doc)).toBe("- value1\n- value2\n");
    const input2 = focusedInput();
    input2.setSelectionRange(0, 0);
    fireEvent.keyDown(input2, { key: "Backspace" });
    expect(sourceOf(lastState.doc)).toBe("- value1\nvalue2\n"); // the value stays ON ITS ROW
    focusedInput();
  });

  it("INSERTION AT THE CARET: A at the start of key1 makes Akey1, not key1A", () => {
    render(<Harness />);
    domType("key1: value1→");
    const keySpan = Array.from(document.querySelectorAll(".y2-k")).find((el) => el.textContent === "key1") as HTMLElement;
    fireEvent.focus(keySpan);
    const input = focusedInput();
    expect(input.value).toBe("key1");
    input.setSelectionRange(0, 0);
    // the page must NOT intercept a meaningless printable — the input inserts it at the caret
    const defaulted = fireEvent.keyDown(input, { key: "A" });
    expect(defaulted, "the printable was intercepted — it would append at the end").toBe(true);
    fireEvent.change(input, { target: { value: "Akey1" } }); // what the un-prevented browser does
    input.setSelectionRange(5, 5);
    fireEvent.keyDown(input, { key: "ArrowRight" });         // commit the edit, walk on
    expect(sourceOf(lastState.doc)).toBe("Akey1: value1\n");
    focusedInput();
  });

  it("the descend hole renders BELOW its value line, never above (reported: placeholder on top)", () => {
    render(<Harness />);
    domType("key1: value1⏎");
    expect(sourceOf(lastState.doc)).toBe("key1: value1\n");
    const token = document.querySelector('.y2-cell[data-kind=token]')!;
    const hole = document.querySelector('.y2-cell[data-kind=hole]')!;
    expect(token, "the committed value must be drawn").toBeTruthy();
    expect(hole, "the descend hole must be drawn").toBeTruthy();
    // the value line comes FIRST in document order; the hole (its future fields) follows it
    expect((token.compareDocumentPosition(hole) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    domType("- sub→");
    expect(sourceOf(lastState.doc)).toBe("key1: value1\n  - sub\n");
  });

  it("an empty `{}` draws a clickable INNER slot — the reported [ {}, {} ] fills again", () => {
    render(<Harness />);
    domType("[⏎{}, {}]");
    expect(sourceOf(lastState.doc)).toBe("[\n  {},\n  {}\n]\n");
    const slot = document.querySelector(".y2-inner") as HTMLElement;
    expect(slot, "no inner slot drawn between the empty brackets").toBeTruthy();
    fireEvent.focus(slot);
    expect(lastState.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
    domType("key: 12}");
    expect(sourceOf(lastState.doc)).toBe("[\n  {key: 12},\n  {}\n]\n");
    focusedInput();
  });

  it("copy document COMMITS pending input first; uncommittable input rings RED and copies NOTHING", () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); }, readText: () => Promise.resolve("") },
    });
    const { getByText, getByTestId, unmount } = render(<DebugEditorPage corpus={{}} />);
    domType("{{12"); // an unnamed element in `{` — pending, and it cannot land
    fireEvent.click(getByText("copy document"));
    expect(written).toEqual([]);                                          // NOTHING copied
    expect(getByTestId("y2-cursor").textContent).toContain("REFUSED");    // and it rang
    unmount();
    const second = render(<DebugEditorPage corpus={{}} />);
    domType("[1, 2"); // pending but committable
    fireEvent.click(second.getByText("copy document"));
    expect(written).toEqual(["[1, 2]\n"]);                                // committed, THEN copied
  });

  it("a flow document types through the DOM too", () => {
    render(<Harness />);
    domType("[1, {key: 12}]");
    expect(sourceOf(lastState.doc)).toBe("[1, {key: 12}]\n");
    focusedInput();
  });
});
