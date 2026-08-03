// THE EDIT KIT — the shared machinery of the yed-*.matrix suites (the executable form of the
// editor's LAWS, EDITOR.md). A suite mounts an EMPTY document with the api mocked, then types its
// way into a context and through a script; the kit asserts, after EVERY keystroke, that the caret
// resolves to a real cell (the harness's `press` does this), so a caret trap fails at the exact
// keystroke that caused it rather than as a mystery later.
//
// TARGET: the YED mount (yed-editor.tsx — the y2 cells). The kit mounts with `?yed=debug` so the
// state panels render: the CURSOR panel is the walk/unwind identity (yed re-renders replace DOM
// elements on every edit, so element identity cannot anchor a law), and debug mode runs the
// WATCHDOG after every apply — a dead advertised key raises the alarm panel mid-suite.
//
// The kit deliberately reuses the corpus harness's script machinery (`parseKeys`/`press`/`rowsOf`)
// — one definition of "typing", whether the transport is a real server (edit-corpus) or a mock.

import { expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { press, parseKeys, rowsOf, cellText } from "../edit-corpus-harness";
import { YedEditor } from "../../src/client/renderers/yed-editor";

export { rowsOf, cellText };

/** What a mocked `fetchNode` must resolve to for an EMPTY document at `:n`. */
export const EMPTY_DOC = {
  path: ":n", type: "object", concrete: "file/yamlover", title: null, description: null, value: {},
} as const;

/** The focusable cell homes — every position `positionsOf` yields draws one of these. */
const FOCUSABLE = "input.y2-input, textarea.y2-blocktext, .y2-gapslot, .y2-p, .y2-v[tabindex], .y2-k[tabindex], .y2-tagtext, .y2-anchor-add";

export interface Kit {
  container: HTMLElement;
  /** The editor's rows as text — the projection a reader sees. */
  rows(): string[];
  /** Every focusable cell home, in DOM order. */
  cells(): HTMLElement[];
  /** The focused cell, asserted to be inside the editor (never <body>). */
  caret(): HTMLElement;
  /** The CURSOR, as the debug panel spells it — the stable identity across re-renders. */
  cursor(): string;
  /** Replay a keystroke script (per-stroke caret assertion included). */
  run(script: string): void;
  /** Cells that would DISPLAY the `…` placeholder: empty editable inputs. THE LAW: at most
   *  one — the hole actively awaiting content. Gaps must not count. */
  placeholders(): HTMLElement[];
}

/** Mount the yed editor over the mocked api and wait for the doc. The suite owns the mocks
 *  (vi.mock is per-file); it hands `fetchNode` here so the kit can prime the empty document. */
export async function mountKit(fetchNode: { mockResolvedValue(v: unknown): void }, doc?: Record<string, unknown>): Promise<Kit> {
  window.history.replaceState({}, "", "/?yed=debug"); // the state panels ARE the kit's instruments
  fetchNode.mockResolvedValue(doc ?? EMPTY_DOC);
  const { container } = render(createElement(YedEditor, { path: ":n", onNavigate: () => {} }));
  await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(), { timeout: 3000 });
  return {
    container,
    rows: () => rowsOf(container),
    cells: () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)),
    caret: () => {
      const el = document.activeElement as HTMLElement | null;
      expect(el, "the caret must be somewhere").toBeTruthy();
      expect(el, "the caret fell to <body> — the editor trapped it").not.toBe(document.body);
      expect(container.contains(el!), "the caret left the editor").toBe(true);
      return el!;
    },
    cursor: () => container.querySelector("[data-testid=y2-cursor]")?.textContent ?? "",
    run: (script: string) => { for (const s of parseKeys(script)) press(s); },
    placeholders: () =>
      Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input.y2-input, textarea.y2-blocktext"))
        .filter((el) => el.value === ""),
  };
}

/** Put the caret at an end of a cell — input-aware (yed cells are inputs; gaps are buttons). */
export function caretTo(el: HTMLElement, where: "start" | "end"): void {
  fireEvent.focus(el); // the React handler moves the cursor; el may be replaced by the render
  const live = document.activeElement as HTMLElement | null;
  const target = live && live !== document.body ? live : el;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const n = where === "end" ? target.value.length : 0;
    target.setSelectionRange(n, n);
    return;
  }
  if (!target.hasAttribute("contenteditable")) { target.focus(); return; } // buttons/atoms: focus is the caret
  target.focus();
  const r = document.createRange();
  r.selectNodeContents(target);
  r.collapse(where === "start");
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Simulate what a browser's Backspace does to TEXT (jsdom fires the event but never edits):
 *  clear the cell and announce it, so a structural ladder can march through text-bearing cells. */
function clearCell(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    fireEvent.change(el, { target: { value: "" } });
    return;
  }
  el.textContent = "";
  fireEvent.input(el);
}

/** THE LADDER LAW, executable: from wherever the caret stands, deleting must reach the EMPTY
 *  document — every press removes one level or one cell's text, no press is dead, no state
 *  repeats (a repeat IS the jam the reports describe). Text deletion is simulated by clearing
 *  (jsdom cannot char-delete); structure is unwound by real Backspace presses. */
export function unwindToEmpty(kit: Kit, maxSteps = 60): void {
  const seen = new Set<string>();
  for (let step = 0; step < maxSteps; step++) {
    const rows = kit.rows();
    if (rows.length === 1 && rows[0] === "") return; // the empty document — done
    const el = kit.caret();
    const text = cellText(el);
    const state = JSON.stringify([rows, kit.cursor(), text]);
    expect(seen.has(state), `the ladder JAMMED — state repeated after ${step} steps: ${state}`).toBe(false);
    seen.add(state);
    if (text !== "" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.hasAttribute("contenteditable"))) {
      clearCell(el);
      continue;
    }
    caretTo(el, "start");
    press({ key: "Backspace" });
  }
  expect.fail(`the ladder did not reach the empty document in ${maxSteps} steps — rows: ${JSON.stringify(kit.rows())}`);
}

/** THE WALK LAW, executable: arrows cross every cell. From the focused cell, keep pressing the
 *  arrow (caret parked at the crossing edge first) and collect each landing's TEXT until the
 *  CURSOR stops moving (elements are replaced on every render — the cursor is the identity). */
export function walk(kit: Kit, from: HTMLElement, dir: "left" | "right", maxSteps = 60): string[] {
  caretTo(from, dir === "right" ? "end" : "start");
  const visited: string[] = [cellText(kit.caret())];
  for (let i = 0; i < maxSteps; i++) {
    const before = kit.cursor();
    caretTo(kit.caret(), dir === "right" ? "end" : "start");
    press({ key: dir === "right" ? "ArrowRight" : "ArrowLeft" });
    if (kit.cursor() === before) return visited;
    visited.push(cellText(kit.caret()));
  }
  return visited;
}
