// THE EDIT KIT — the shared machinery of the yed-*.matrix suites (the executable form of the
// editor's LAWS, EDITOR.md). A suite mounts an EMPTY document with the api mocked, then types its
// way into a context and through a script; the kit asserts, after EVERY keystroke, that the caret
// resolves to a real cell (the harness's `press` does this), so a caret trap fails at the exact
// keystroke that caused it rather than as a mystery later.
//
// The kit deliberately reuses the corpus harness's script machinery (`parseKeys`/`press`/`rowsOf`)
// — one definition of "typing", whether the transport is a real server (edit-corpus) or a mock
// (here, for speed and per-context control).

import { expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { press, parseKeys, rowsOf } from "../edit-corpus-harness";
import { YamloverEditor } from "../../src/client/renderers/yamlover-editor/editor";

export { rowsOf };

/** What a mocked `fetchNode` must resolve to for an EMPTY document at `:n`. */
export const EMPTY_DOC = {
  path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {},
} as const;

export interface Kit {
  container: HTMLElement;
  /** The editor's rows as text — the projection a reader sees. */
  rows(): string[];
  /** Every registered cell, in DOM order. */
  cells(): HTMLElement[];
  /** The focused cell, asserted to be inside the editor (never <body>). */
  caret(): HTMLElement;
  /** Replay a keystroke script (per-stroke caret assertion included). */
  run(script: string): void;
  /** Cells that would DISPLAY the `…` placeholder (the `:empty::before` CSS): empty editable
   *  spans. THE LAW: at most one — the hole actively awaiting content. Gaps must not count. */
  placeholders(): HTMLElement[];
}

/** Mount the editor over the mocked api and wait for the first row. The suite owns the mocks
 *  (vi.mock is per-file); it hands `fetchNode` here so the kit can prime the empty document. */
export async function mountKit(fetchNode: { mockResolvedValue(v: unknown): void }, doc?: Record<string, unknown>): Promise<Kit> {
  fetchNode.mockResolvedValue(doc ?? EMPTY_DOC);
  const { container } = render(createElement(YamloverEditor, { path: ":n", onNavigate: () => {} }));
  await waitFor(() => expect(container.querySelector(".yed-row")).toBeTruthy(), { timeout: 3000 });
  return {
    container,
    // CONTENT rows only: the `＋` tail is an affordance, not content, and whether a context shows
    // one is a layout fact no law cares about — a frame that had to mention it would be noise
    rows: () =>
      Array.from(container.querySelectorAll(".yed-row"))
        .filter((r) => !r.querySelector(".yed-tail"))
        .map((r) => r.textContent ?? ""),
    cells: () => Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")),
    caret: () => {
      const el = document.activeElement as HTMLElement | null;
      expect(el, "the caret must be somewhere").toBeTruthy();
      expect(el, "the caret fell to <body> — the editor trapped it").not.toBe(document.body);
      expect(container.contains(el!), "the caret left the editor").toBe(true);
      return el!;
    },
    run: (script: string) => { for (const s of parseKeys(script)) press(s); },
    placeholders: () =>
      Array.from(container.querySelectorAll<HTMLElement>(".editable")).filter(
        (el) => (el.textContent ?? "") === "",
      ),
  };
}

/** Put the caret at an end of a cell (jsdom needs the range set by hand). */
export function caretTo(el: HTMLElement, where: "start" | "end"): void {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(where === "start");
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Simulate what a browser's Backspace does to TEXT (jsdom fires the event but never edits):
 *  clear the cell and announce it, so a structural ladder can march through text-bearing cells. */
function clearCell(el: HTMLElement): void {
  el.textContent = "";
  fireEvent.input(el);
}

/** THE LADDER LAW, executable: from wherever the caret stands, deleting must reach the EMPTY
 *  document — every press removes one level or one cell's text, no press is dead, no state
 *  repeats (a repeat IS the jam the reports describe). Text deletion is simulated by clearing
 *  (jsdom cannot char-delete); structure is unwound by real Backspace presses. */
export function unwindToEmpty(kit: Kit, maxSteps = 40): void {
  const seen = new Set<string>();
  for (let step = 0; step < maxSteps; step++) {
    const rows = kit.rows();
    if (rows.length === 1 && rows[0] === "") return; // the empty document — done
    const el = kit.caret();
    const text = el.textContent ?? "";
    const state = JSON.stringify([rows, el.getAttribute("data-yed-cell"), text]);
    expect(seen.has(state), `the ladder JAMMED — state repeated after ${step} steps: ${state}`).toBe(false);
    seen.add(state);
    if (text !== "") { clearCell(el); continue; }
    caretTo(el, "start");
    press({ key: "Backspace" });
  }
  expect.fail(`the ladder did not reach the empty document in ${maxSteps} steps — rows: ${JSON.stringify(kit.rows())}`);
}

/** THE WALK LAW, executable: arrows cross every cell. From `from`, keep pressing the arrow (caret
 *  parked at the crossing edge first) and collect each landing until movement stops. */
export function walk(kit: Kit, from: HTMLElement, dir: "left" | "right", maxSteps = 40): HTMLElement[] {
  const visited: HTMLElement[] = [from];
  caretTo(from, dir === "right" ? "end" : "start");
  for (let i = 0; i < maxSteps; i++) {
    const cur = kit.caret();
    caretTo(cur, dir === "right" ? "end" : "start");
    press({ key: dir === "right" ? "ArrowRight" : "ArrowLeft" });
    const next = kit.caret();
    if (next === cur) return visited;
    visited.push(next);
  }
  return visited;
}
