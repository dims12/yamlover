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

describe("rankHints - the exact match first, then prefixes, then substrings", () => {
  const pool: Hint[] = [{ insert: "pets" }, { insert: "owner" }, { insert: "carpets" }];
  it("empty prefix keeps everything", () => {
    expect(rankHints(pool, "").map((h) => h.insert)).toEqual(["pets", "owner", "carpets"]);
  });
  it("prefix matches outrank substrings; non-matches drop", () => {
    expect(rankHints(pool, "pe").map((h) => h.insert)).toEqual(["pets", "carpets"]);
  });
  it("the EXACT match ranks first - typed-in-full must never lose to a lookalike", () => {
    // the pet1/extra_pet1 trap: with the exact match dropped, the substring lookalike armed
    // and Tab/Enter overwrote correct text; exact-first makes the typed name its own arm
    expect(rankHints(pool, "pets").map((h) => h.insert)).toEqual(["pets", "carpets"]);
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
    // native selection semantics: a typed character REPLACES the selection — the inline
    // completion tail rides selected, so typing over it must behave like a real browser
    const s = input.selectionStart ?? before.length;
    const e = input.selectionEnd ?? before.length;
    const defaulted = fireEvent.keyDown(input, { key });
    if (key.length === 1 && defaulted) fireEvent.change(input, { target: { value: before.slice(0, s) + key + before.slice(e) } });
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

  it("the INLINE TAIL: the armed candidate rides in the cell, its untyped part selected", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    // an EMPTY cell arms NOTHING: its list is just "every child", which implies no choice
    expect(rows()).toEqual(["pets", "owner"]);
    expect(document.querySelector(".y2-hint-sel")).toBeNull();
    expect(focused().value).toBe("");
    // one character and the offer is armed - the candidate appears IN the cell, tail selected
    await act(async () => { domType("ow"); });
    expect(document.querySelector(".y2-hint-sel .y2-hint-insert")?.textContent).toBe("owner");
    expect(focused().value).toBe("owner");
    expect(focused().selectionStart).toBe(2); // "ow" typed, "ner" selected - typing replaces it
    expect(focused().selectionEnd).toBe(5);
    // Enter ACCEPTS the suggestion and FINISHES - one key, one commit
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *owner\n");
  });

  it("ESCAPE closes the DROPDOWN and only the dropdown; the typed text stands", async () => {
    render(<Harness />);
    await act(async () => { domType("*ow"); });
    expect(dropdown()).toBeTruthy();
    expect(focused().value).toBe("owner"); // the tail is up
    const esc = fireEvent.keyDown(focused(), { key: "Escape" });
    await act(async () => {});
    expect(esc).toBe(false); // swallowed - it must never reach the page's lock-on-Escape
    expect(dropdown()).toBeNull(); // closed, not merely disarmed
    expect(focused().tagName).toBe("INPUT"); // the edit survives
    expect(focused().value).toBe("ow"); // the tail went with the dropdown
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *ow\n"); // the typed text won, as typed
  });

  it("DELETE discards the tail; the next typed character re-arms it", async () => {
    render(<Harness />);
    await act(async () => { domType("*o"); });
    expect(focused().value).toBe("owner");
    await act(async () => { fireEvent.keyDown(focused(), { key: "Delete" }); });
    expect(focused().value).toBe("o"); // the tail is gone, the dropdown stays
    expect(dropdown()).toBeTruthy();
    await act(async () => { domType("w"); });
    expect(focused().value).toBe("owner"); // typing re-arms
  });

  it("ArrowDown walks the list and the tail follows; `:` accepts and opens the next portion", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    expect(document.querySelector(".y2-hint-sel .y2-hint-insert")?.textContent).toBe("pets");
    // the arrow-picked candidate previews in the cell, wholly selected (nothing typed yet)
    expect(focused().value).toBe("pets");
    expect(focused().selectionStart).toBe(0);
    // `:` ACCEPTS the suggestion and splits - the next cell's hints are pets' POSITIONS
    await act(async () => { fireEvent.keyDown(focused(), { key: ":" }); });
    expect(lastState.cursor).toMatchObject({ ref: { portions: ["pets", ""], active: 1 } });
    expect(rows()).toEqual(["[0]", "[1]"]);
    expect(sourceOf(lastState.doc)).toBe(DOC); // still mid-entry - nothing committed
  });

  it("TAB never cycles - it accepts the suggestion and FINISHES the reference", async () => {
    render(<Harness />);
    await act(async () => { domType("*pe"); });
    expect(focused().value).toBe("pets"); // armed, tail up
    await act(async () => { fireEvent.keyDown(focused(), { key: "Tab" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets\n"); // one Tab: accepted AND committed
  });

  it("a fully-typed name commits AS TYPED - a lookalike candidate never overrides it", async () => {
    render(<Harness />);
    await act(async () => { domType("*pets"); });
    // "pets" is typed in full: the exact match arms (rankHints), so the tail is empty
    expect(focused().value).toBe("pets");
    expect(focused().selectionStart).toBe(4);
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets\n");
  });

  it("a CLICK on a row picks it into the cell; Enter then commits", async () => {
    render(<Harness />);
    await act(async () => { domType("*"); });
    const row = document.querySelectorAll(".y2-hint")[0] as HTMLElement;
    await act(async () => { fireEvent.mouseDown(row); });
    expect(focused().value).toBe("pets");
    await act(async () => { fireEvent.keyDown(focused(), { key: ":" }); });
    const pos = document.querySelectorAll(".y2-hint")[1] as HTMLElement;
    await act(async () => { fireEvent.mouseDown(pos); });
    expect(focused().value).toBe("1");
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *pets: 1\n");
  });

  it("the `&` BOOKMARK face: same cells, `&` sigil, POSITION hints dropped", async () => {
    render(<Harness />);
    await act(async () => { domType("&"); });
    expect(lastState.cursor).toMatchObject({ at: "hole", anchor: true, ref: { ladder: 0, portions: [""], active: 0 } });
    expect(document.querySelector(".y2-portions .y2-punct")?.textContent).toBe("&");
    // the keys still offer (a bookmark path walks keys)...
    expect(rows()).toEqual(["pets", "owner"]);
    await act(async () => { domType("pets:"); });
    // ...but pets' POSITIONS do not: a bookmark may not claim one, and an armed digit row
    // would Tab-accept straight into the refusal ring (the `*` face shows [0], [1] here)
    expect(rows()).toEqual([]);
    // commit through the hints anyway - Tab accepts `pets`? no: type the new key and Enter
    await act(async () => { domType("adopted"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(lastState.refused).toBe(false);
    expect(sourceOf(lastState.doc)).toBe("&pets: adopted\n" + DOC); // root anchors lead the document
    // the caret is the RESTORED hole - the bookmark is a decoration, not an entry
    expect(lastState.cursor).toMatchObject({ at: "hole", path: [], index: 2, text: "" });
    expect(focused().tagName).toBe("INPUT");
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
