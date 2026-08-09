// @vitest-environment jsdom
// COMPLETION HINTS (src/complete.ts) - the advisory dropdown over the reference portion
// cells: the pure in-memory doc provider, the ranking, and the DOM face (the dropdown pops
// in the DEBUG editor with no server; picking replaces the active cell's text; hints never
// gate typing - the grammar's Enter still owns the commit).
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { EditorView } from "../src/page";
import { docHints, rankHints, type Hint } from "../src/complete";
import { parseSource, sourceOf, type EditorState } from "../src/state";

afterEach(cleanup);

const DOC = "pets:\n  - Rex\n  - Whiskers\nowner:\n  name: Alice\n";
const doc = () => parseSource(DOC);

// ---------------------------------------------------------------------------- //
// the PURE provider - the document's own entries, portioned
// ---------------------------------------------------------------------------- //

describe("docHints - the in-memory document answers the portion cells", () => {
  const hints = (q: { ladder: 0 | 1 | 2 | 3; portions: string[]; prefix: string; path: number[] }): Hint[] =>
    docHints({ ...q, doc: doc() }) as Hint[];

  it("the bare scope at the root offers the ROOT's keys", () => {
    const h = hints({ ladder: 0, portions: [], prefix: "", path: [] });
    expect(h.map((x) => x.insert)).toEqual(["pets", "owner"]);
  });

  it("a committed portion steps INTO its node - positions for the keyless members", () => {
    const h = hints({ ladder: 0, portions: ["pets"], prefix: "", path: [] });
    expect(h.map((x) => x.insert)).toEqual(["0", "1"]);
    expect(h[0]).toMatchObject({ label: "[0]", detail: "Rex" });
  });

  it("the `:` scope resolves at the DOCUMENT root from anywhere", () => {
    // asked from inside `owner` (path [1]) - the document ladder still starts at the root
    const h = hints({ ladder: 1, portions: ["owner"], prefix: "", path: [1] });
    expect(h.map((x) => x.insert)).toEqual(["name"]);
  });

  it("the bare scope resolves at the CURSOR's container", () => {
    const h = hints({ ladder: 0, portions: [], prefix: "", path: [1] });
    expect(h.map((x) => x.insert)).toEqual(["name"]);
  });

  it("`..` climbs the walk stack", () => {
    const h = hints({ ladder: 0, portions: [".."], prefix: "", path: [1] });
    expect(h.map((x) => x.insert)).toEqual(["pets", "owner"]);
  });

  it("the `::` / `:::` scopes reach beyond one document - nothing to say", () => {
    expect(hints({ ladder: 2, portions: [], prefix: "", path: [] })).toEqual([]);
    expect(hints({ ladder: 3, portions: [], prefix: "", path: [] })).toEqual([]);
  });

  it("an unresolvable portion yields NO hints - never an error", () => {
    expect(hints({ ladder: 0, portions: ["nosuch"], prefix: "", path: [] })).toEqual([]);
  });
});

describe("rankHints - prefix first, substrings after, the exact match drops", () => {
  const pool: Hint[] = [{ insert: "pets" }, { insert: "owner" }, { insert: "carpets" }];
  it("empty prefix keeps everything", () => {
    expect(rankHints(pool, "").map((h) => h.insert)).toEqual(["pets", "owner", "carpets"]);
  });
  it("prefix matches outrank substrings; non-matches drop", () => {
    expect(rankHints(pool, "pe").map((h) => h.insert)).toEqual(["pets", "carpets"]);
  });
  it("the exact match drops - the typed text needs no hint", () => {
    expect(rankHints(pool, "pets").map((h) => h.insert)).toEqual(["carpets"]);
  });
});

// ---------------------------------------------------------------------------- //
// the DOM face - the dropdown in the debug editor, no server anywhere
// ---------------------------------------------------------------------------- //

let lastState: EditorState = null as never;

function Harness() {
  // the debug page's wiring: hints from the document itself
  const [state, setState] = useState<EditorState>(() => ({
    doc: doc(),
    cursor: { at: "hole", path: [], index: 2, text: "", key: null },
    refused: false,
    log: [],
  }));
  lastState = state;
  return <EditorView state={state} setState={setState} debug={false} hints={docHints} />;
}

const focused = (): HTMLInputElement => document.activeElement as HTMLInputElement;

function domType(script: string): void {
  for (const ch of script) {
    const input = focused();
    const key = ch === "\n" ? "Enter" : ch;
    const before = input.value ?? "";
    const defaulted = fireEvent.keyDown(input, { key });
    if (key.length === 1 && defaulted) fireEvent.change(input, { target: { value: before + key } });
  }
}

const dropdown = (): HTMLElement | null => document.querySelector("[data-testid=y2-hints]");
const rows = (): string[] => Array.from(document.querySelectorAll(".y2-hint .y2-hint-insert")).map((el) => el.textContent ?? "");

describe("the dropdown over the portion cells - the debug editor's pointer entrance", () => {
  it("`*` pops the hints; typing filters them; the grammar is never gated", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    expect(lastState.cursor).toMatchObject({ at: "hole", ref: { ladder: 0, portions: [""], active: 0 } });
    expect(dropdown(), "the `*` decision must pop the document's keys").toBeTruthy();
    expect(rows()).toEqual(["pets", "owner"]);
    await act(async () => { domType("ow"); });
    expect(rows()).toEqual(["owner"]);
    // free typing PAST the hints - the doctrine: a hint never validates
    await act(async () => { domType("nery"); });
    expect(rows()).toEqual([]);
  });

  it("ArrowDown walks the list, Enter takes the highlighted row into the cell", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    expect(document.querySelector(".y2-hint-sel .y2-hint-insert")?.textContent).toBe("pets");
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    // the pick REPLACED the text - nothing committed to the document yet
    expect(focused().value).toBe("pets");
    expect(sourceOf(lastState.doc)).toBe(DOC);
    // `:` splits the portion; the next cell's hints are pets' POSITIONS
    await act(async () => { domType(":"); });
    expect(lastState.cursor).toMatchObject({ ref: { portions: ["pets", ""], active: 1 } });
    expect(rows()).toEqual(["[0]", "[1]"]);
  });

  it("Tab ACCEPTS - the armed candidate, else the FIRST row (the query editor's rule)", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    // no row armed: Tab takes the FIRST hint into the cell - never an indent, never a focus walk
    await act(async () => { fireEvent.keyDown(focused(), { key: "Tab" }); });
    expect(focused().value).toBe("pets");
    expect(sourceOf(lastState.doc)).toBe(DOC); // replaced text only - nothing committed
    // an ARMED row: Tab takes it, like Enter would
    await act(async () => { domType(":"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "Tab" }); });
    expect(focused().value).toBe("1");
    // the grammar's Enter still owns the commit
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets: 1\n");
  });

  it("a CLICK on a row picks it; the grammar's Enter still commits the reference", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    await act(async () => { domType(":"); });
    const row = document.querySelectorAll(".y2-hint")[1] as HTMLElement;
    await act(async () => { fireEvent.mouseDown(row); });
    expect(focused().value).toBe("1");
    // Enter with NO highlight falls through to the grammar - the reference commits
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets: 1\n");
  });

  it("with NO provider the portion cells draw no dropdown and the grammar is unchanged", async () => {
    lastState = null as never;
    function Bare() {
      const [state, setState] = useState<EditorState>(() => ({
        doc: doc(),
        cursor: { at: "hole", path: [], index: 2, text: "", key: null },
        refused: false,
        log: [],
      }));
      lastState = state;
      return <EditorView state={state} setState={setState} debug={false} />;
    }
    render(<Bare />);
    await act(async () => { domType("*pets"); });
    expect(dropdown()).toBeNull();
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets\n");
  });
});
